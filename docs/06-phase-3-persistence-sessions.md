# 06 — Phase 3: Persistence & sessions

The phase plan and record for [03-roadmap.md](03-roadmap.md) phase 3. Decisions that change 02 are also noted there, with dates.

Planned on 2026-11-04, together with a refocus on the MVP: persistence & sessions (this phase), then the HTTP API & client (phase 5). Phase 2b is deferred until after those, and its data strategy is now decided (02 §5): a **live, large, changing API**, never mirrored locally.

Scope: a single default user, no auth. Chats survive restarts, the CLI can list and switch them, and each chat gets a generated title.

## Decisions (2026-11-04)

| Topic | Decision | Notes |
|---|---|---|
| Driver | **libsql** (`@libsql/client` 0.18) + **Drizzle** (`drizzle-orm` 0.45, `drizzle-kit` 0.31) | Confirms 02 §6. Checked on Node 26 / Linux, including transactions on `:memory:` |
| Database location | `DATABASE_URL`, default `file:data/shopping.db` | `data/` is git-ignored. The directory is created on open |
| Migrations | `pnpm db:generate` writes to `drizzle/` (committed). They run **on every open** | No separate migrate step, so a fresh checkout just works. Tests run them on `:memory:` |
| Tables | `users`, `chats`, `messages` | `chat_summaries` is added in phase 4, by that phase's migration |
| Message format | **`UIMessage`**, `parts` as a JSON column, plus `seq` for order | Session history is `UIMessage[]` as well. See "UIMessage history" below and 02 §14.7 |
| When a chat is saved | **On the first successful turn**: the chat row and `[user, assistant]` in **one transaction** (`appendMessages(…, { createIfMissing })`) | Empty chats never appear in the list. A failed turn saves nothing, the same as the in-memory rollback from phase 1 |
| Persistence port | `createChatSession({ onTurnEnd })` | `agent/chat.ts` knows nothing about the DB. `agent/chat-service.ts` connects it to the store |
| Scoping | Every store method takes `userId`. A chat owned by someone else behaves as if it doesn't exist (`ChatNotFoundError`) | `DEFAULT_USER_ID = 'default'`, created by `ensureDefaultUser()` on startup |
| Titles | `summarizeChat({ purpose: 'title' })` with the **`summarizer`** role, run **in the background** after the first stored turn | A plain function, not a model tool. Sends only text parts (no tool payloads). If it fails, the chat stays untitled and the list shows the first message instead |
| CLI UX | **Explicit commands.** Startup opens a new chat | Answers the open question in 03 phase 3 |

## UIMessage history

The phase 2 history was `ModelMessage[]`. A `ModelMessage` tool result holds what `toModelOutput` produced, so the thumbnails were already lost (05 said otherwise; corrected there). Phase 3 changes the source of truth:

- `history: UIMessage[]`. One user message and one assistant message per turn. Tool calls and results are **parts of the assistant message**, with the raw `execute` output.
- Each turn, the model view is built with `convertToModelMessages(history, { tools })`. That conversion applies each tool's `toModelOutput`, so the model still sees the slim products.
- The assistant `UIMessage` comes from `result.toUIMessageStream({ originalMessages, onEnd })`. `onEnd` only fires if that stream is read, so the session **tees** it: it drains one branch itself, and the other is `turn.uiStream`, for the HTTP adapter in phase 5. The CLI and evals still read `fullStream`.
- `send()` is now **async**, because `convertToModelMessages` is: `const turn = await session.send(text)`.

## Layout

```
src/
  store/schema.ts             Drizzle tables: users, chats, messages
  store/db.ts                 openDatabase(url): libsql client + Drizzle, runs migrations
  store/chat-store.ts         createChatStore(db): user-scoped CRUD, DEFAULT_USER_ID, ChatNotFoundError
  agent/chat.ts               UIMessage history, initialMessages, onTurnEnd, uiStream
  agent/summarize.ts          summarizeChat({ purpose: 'title' }), transcriptOf, cleanTitle
  agent/chat-service.ts       newChat / openChat / listChats / settled: what adapters call
  adapters/cli/commands.ts    parseCommand, resolveChatRef (pure)
  adapters/cli/render.ts      traceLine, formatChatList, formatReplay, relativeTime (pure)
  adapters/cli/main.ts        REPL wiring
drizzle/                      generated migrations (0000_init.sql)
drizzle.config.ts
test/
  helpers/store.ts            memoryStore(): migrated :memory: DB with a ticking clock
  store/chat-store.test.ts
  agent/summarize.test.ts, agent/chat-service.test.ts, (+ chat.test.ts extended)
  adapters/cli-commands.test.ts
```

## CLI

| Input | Effect |
|---|---|
| `/sessions` | Numbered list, newest activity first. `*` marks the current chat. Untitled chats show their first message, dimmed |
| `/sessions <n>` or `/sessions <id-prefix>` | Switch to that chat and replay its last 6 messages (text plus the dim tool trace lines) |
| `/new` | Start a new chat (saved after its first reply) |
| `/help` | The command list |
| `/exit`, `/quit`, Ctrl+D | Quit. Waits up to 5 s for a pending title |
| Ctrl+C | Quit immediately. An unfinished turn isn't saved, and a pending title is lost (the list falls back to the first message) |
| `/anything-else` | "unknown command" + help. **Not** sent to the model |

A line counts as a command only when it starts with `/` followed by a letter, so `/50% off?` is still a message.

## Behaviour worth knowing

- **Turn numbers in the step log continue** after a resume (counted from the stored user messages), so `chatId + turn` stays unique.
- **If saving fails, the turn fails.** `onTurnEnd` throwing rolls back the in-memory history too, so memory and DB never disagree.
- **A title failure never fails the turn.** The CLI drops these errors silently, because printing mid-prompt garbles the input line. The service has an `onBackgroundError` hook if an adapter wants them.
- **Reasoning parts are stored.** With `gpt-6-luna` each step stores a `reasoning` part carrying OpenAI's encrypted reasoning, about 1.8 KB, and it is replayed on later turns. This is provider-specific data in history; see 02 §14.7 #2. Phase 4 can prune it.

## How to run

```sh
pnpm test          # offline; the store tests use libsql :memory:
pnpm typecheck
pnpm chat          # creates data/shopping.db on first run
pnpm db:generate   # after changing src/store/schema.ts
```

## Status

- [x] Store tests pass: create / list / load / append, ordering, `updated_at`, user scoping, atomic first save, a tool part round-trip with `thumbnail`
- [x] Mock-model tests pass: `onTurnEnd` only on success, rollback when saving fails, the stored tool part is full while the prompt is slim, resume from JSON-roundtripped messages (the model sees the prior `tool` message), `uiStream`
- [x] Chat-service tests pass: lazy creation, no save on failure, a single title, title failure isolation, resume
- [x] `pnpm chat` checked on Linux (WSL) against the real model:
  - lipstick search → `/exit` → restart → `/sessions` shows the chat titled "Lipstick options"
  - switched to it and asked for "the price and its rating": answered $12.99 / 4.36 from the stored tool result
  - `/new`, `/sessions`, and an unknown command all behave as described
- [x] `pnpm eval` re-run on the `UIMessage` path (2026-11-04): 12 of 13 cases at 5/5. **School: 3/5**, failing on the known `tops` issue (05 "Known issues", deferred with 2b). Phase 2 had 1/5 and 4/5 on this case, so this is not a regression
- [x] Windows: install (libsql prebuilt binary), tests and chat work (checked by the user, 2026-11-04)
