# 10 — Phase 4: recent window + memories

The phase plan and record for [03-roadmap.md](03-roadmap.md) phase 4, rescoped. Decisions that change 02 are also noted there, with dates.

Planned on 2026-11-05. Chats are now persisted and the client loads older messages, so a chat can run for a long time. That's especially true of the planned embedded widget, where a user may never start a new chat and just goes on shopping in the same one, session after session. Until now every turn sent the whole history to the chat model.

## Goals

- **Bounded context** without summarizing: the chat model sees only the last N messages.
- **Facts about the user survive the window and carry over between chats**: age group, gender, household, sizes, tastes, shopping habits.
- **Lasting facts and task facts stay apart.** Buying a gift for the user's wife must not change what's known about the user.
- **Searches only use the relevant facts**: a search for someone else uses that person's facts, not the user's.

## Decisions (2026-11-05)

| Topic | Decision | Notes |
|---|---|---|
| Compaction | **No summary. A recent window of `HISTORY_WINDOW` messages (default 20 = 10 turns)** | Replaces 02 §7 layer 3. Most bloat comes from tool results, and they age out with the window. Memories keep the facts a summary would have carried. The planned `chat_summaries` table is dropped |
| Window and memories together | **The window covers the recent messages, memories cover the rest** | A fact from the last N messages is still in the window word for word, so if extraction runs a turn late, nothing is lost |
| Extraction | **A background model call after each turn**, like title generation | New **`memory`** role (`MODEL_MEMORY`). No added latency. It runs every turn, not only when the agent decides to |
| Rejected: a `remember` tool for the chat agent | | It would distract the chat agent and change its prompt and evals. It would only save facts when the agent thought of it |
| Storage | **A list of fact records** (`memories` table): one plain sentence each, plus `scope` and `subject` | The extractor edits facts one at a time (add / update / remove by id), the same pattern Mem0 and similar systems use |
| Rejected: one free-text document per user | | Every update rewrites it, so facts drift and get lost. It can't separate scopes, and you can't edit or delete a single fact |
| Rejected: fixed key-value fields | | Too rigid for open-ended preferences ("avoids synthetic fabrics") |
| Rejected: embeddings / vector search | | A user has a few dozen facts at most, which fit in the prompt. Retrieval would only add a way to miss the fact that mattered. Revisit if memories grow into things like purchase histories (libsql has vectors) |
| Scope | **`user` (lasting, `chat_id` null) or `chat` (the current shopping task)** | Task facts are deleted with the chat. The extractor removes or replaces them when the user moves on to another task, which matters in endless widget chats |
| Subject | **Every fact is about someone**: `self` or a relation as the user put it ("wife", "son") | This is what keeps the wife's facts apart from the user's. "Wife loves gold" is lasting, but it isn't about the user |
| Who applies the facts | **The chat agent**, through its instructions. `findProducts` stays stateless | The agent already writes a self-contained `request` and knows who the search is for. A prompt rule says to use only the facts about the person the products are for. The MCP tool (phase 8) has no user store, so the workflow shouldn't need one. If the evals show leaks, add a structured "for whom" field to `findProducts` |
| No guessing | **Only what the user stated or clearly implied** | Never infer gender or age from a name, and nothing about the user from what they buy for someone else |

## How it works

- **Window** (`src/agent/chat.ts`): `recentWindow(messages, historyWindow)` keeps the last N messages and moves the start forward to a user message. Stored history and `session.history` are untouched. `openChat` loads only the last N messages (`loadMessagesPage`). The turn count comes from `countTurns`, so step-log turn numbers continue.
- **Per-turn instructions**: `instructions` can be a function, called at the start of every turn. The service builds it from `store.loadMemories(userId, chatId)`, which returns the lasting facts plus this chat's. `buildInstructions(categories, memories)` appends a `# What you know about the user` section (`renderMemories`), with each fact tagged by who it's about.
- **Extraction** (`src/agent/memory.ts`): one structured-output call. Input: the current facts under short ids (`m1`, `m2`, …) and the text of the new turn (no tool results). Output: `{ add, update, remove }`. The prompt calls the scopes "lasting" and "task". `normalizeChanges` maps short ids back and drops:
  - ops on ids the model wasn't given
  - empty texts, no-op updates and duplicates
  - adds over the caps (30 lasting, 10 per chat)

  `remove` wins over `update`.
- **Ordering** (`src/agent/chat-service.ts`): extractions of one chat are chained, so each sees the previous one's changes. Two chats of the same user can still change lasting facts at the same time, and the later write wins. That's acceptable for a POC.
- **Store** (`applyMemoryOps`): one transaction. `update` and `remove` only reach the user's lasting facts and this chat's facts. Ids from other users or other chats are ignored.
- Extraction calls go to the step log with `scope: memory`. A failed extraction loses that turn's facts and is reported through `onBackgroundError` (`task: 'memory'`). The turn itself is never affected.

## Behaviour worth knowing

- **The next turn may not see this turn's facts yet.** Extraction runs in the background. That's fine while the turn is still in the window. It only matters with a tiny window.
- **The CLI's `/sessions <n>` replay shows only the last N messages** of a resumed chat. The web client pages history from the API, which isn't affected.
- Users can't see or edit their memories yet. A natural follow-up: `GET/DELETE /memories`, and a "forget this" path.

## Long chat (2026-11-05)

A scripted 24-turn chat through the chat service with memory, run twice: with `HISTORY_WINDOW=20` and with no window. It covers several shopping tasks in a row: running gear for the user, a birthday gift for his wife, kitchen and decor for a new apartment, a tablet for his son, then back to running.

| Turn | 1 | 6 | 11 | 16 | 20 | 24 |
|---|---|---|---|---|---|---|
| Chat-model input tokens, window 20 | 1230 | 2261 | 3754 | 4572 | 5362 | 5042 |
| Chat-model input tokens, no window | 1230 | 2326 | 3679 | 4999 | 7123 | 7803 |

(The largest step of each turn.) With the window, input levels off at about 4.5–5.5k from turn ~11, when the conversation reaches 20 messages. It still moves with how many search results are in the window. Without the window it grows by roughly 200–500 tokens a turn.

Memories at the end: all lasting, and correctly kept apart by subject. The user: a man in his thirties who recently started running. The wife: loves perfume, prefers gold jewellery. The son: turning 10, likes video games and tech. Nothing about the user was taken from the gifts.

**Found: the model denies what it can't see.** At turn 23, "What did I tell you my budget for running shoes was?" got "You haven't mentioned a budget". The budget ("under $80", turn 3) was outside the window, and its task note had been cleared when the user moved on to another task. Losing the budget is how the design works. Claiming the user never said it is wrong. Open.

## Evals

New cases in `evals/shopping.eval.ts` ("memory golden set"). They run several chats through the chat service with an in-memory DB (`converseWithMemory` in the harness). After each turn they wait for extraction and record the stored memories.

- a lasting fact ("I'm a man") picks men's watches in a later chat
- a gift for the wife in a second chat returns women's watches, and the request has no male terms
- a gift conversation leaves the user's own facts unchanged
- with a window of 1, a budget from an earlier turn is still applied

### Results (`gpt-6-luna`, 5 trials, 2026-11-05)

Full set, one run: **22/23 cases ≥ 4/5**. All four memory cases scored 5/5. Every phase 2 and 09 case scored 5/5, except:

- **vague: son starting school, 1/5.** A clarifying question that suggested `tops`, a watch, or a bag (only `womens-bags` exists). This case has never been stable: it scored 1/5 → 4/5 in 05 and 3/5–5/5 in 09.

The new prompt lines could have shifted it, so the case was compared alone, 10 trials per prompt (a scratch script with the same checks):

| Prompt | Pass | tops | bag | watch |
|---|---|---|---|---|
| before this phase (`HEAD`) | 7/10 | 1 | 2 | 0 |
| with the memory rules | 8/10 | 1 | 0 | 1 |

No regression: the 1/5 was a bad draw on an unstable case. Afterwards:

- **Watches are accepted for this case** (`mens-watches`). A watch for a boy starting school is a reasonable suggestion, and the "working out" case accepts watches too.
- **A general audience rule was tried and removed** in the vague-request instructions: "only suggest categories … whose names fit the person (a category named for women isn't for a boy)". With watches accepted in both runs:

| Prompt | Pass | tops | bag |
|---|---|---|---|
| before this phase (`HEAD`) | 7/10 | 1 | 2 |
| with the memory rules + audience rule | 6/10 | 4 | 0 |

  It removed the bag failures but made `tops` more frequent. `tops` doesn't name a gender, so the rule seems to make it look like a safe pick. **Removed**: the prompt stays as it was. The `tops` problem stays open (05, 09): nothing in its name says what it holds, and prompts carry no catalog knowledge.
