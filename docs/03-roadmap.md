# 03 — Roadmap

These are the phased checkpoints for the POC. The architecture and its reasoning are in [02-architecture.md](02-architecture.md).

- Each phase gets its own detailed planning session, recorded as `docs/NN-phase-X-<topic>.md`.
- Update the status checkboxes here as work progresses. This file doubles as the progress tracker.

**Legend:** `[ ]` not started · `[~]` in progress · `[x]` done

## Cross-cutting rules

- **No phase is done until its tests pass.** Deterministic and mock-model tests run on every change.
- **Behaviour changes are checked against the eval set.** This covers prompt, tool-schema and context changes, and applies from phase 2 on. Record pass rates before and after.
- **Check Windows at every phase boundary:** install, run, test.
- **Keep layering intact:**
  - `domain` doesn't import the AI SDK.
  - Adapters stay thin.
  - Only the model registry knows about providers.
- **Record decisions.** If a phase changes a decision from 02, update 02 with a dated note.
- **Log wrong assumptions.** If a phase proves an assumption wrong, add it to 02 §14 with what changed.

---

## Phase 1 — Scaffold & console chat `[x]`

Phase record: [04-phase-1-scaffold.md](04-phase-1-scaffold.md).

**Goal:** an empty-but-working TypeScript project in which a model streams replies in the console.

**Scope**
- Node + TypeScript project setup (tsconfig, a runner such as `tsx`, lint/format).
- Model registry with `chat` / `summarizer` / `judge` roles, configured from env. Use `gpt-6-luna`.
- Console REPL (readline) that uses `streamText` and keeps conversation history in memory.
- Vitest set up, plus one mock-model test of the chat loop.
- Step logging to JSONL via `onStepFinish`.

**Done when**
- [x] `pnpm chat` gives a multi-turn streamed conversation on Linux **and Windows**.
- [x] `pnpm test` passes, including the mock-model test.
- [x] The step log shows token usage and the finish reason for every turn.

**Open questions** *(answered 2026-11-03)*
- ~~Which package manager to use (npm or pnpm), and whether to use a monorepo layout now or later.~~ **pnpm**, single package for now. Split into a workspace in phase 5.
- ~~How the provider is configured for `gpt-6-luna`: OpenAI-compatible provider or a dedicated one.~~ **`@ai-sdk/openai`**.

## Phase 2 — Shopping behaviour (single user, short sessions) `[ ]`

**Goal:** a single agent that reliably turns conversation into well-formed product searches and answers with grounded results.

**Scope**
- Domain layer:
  - `ProductRepository` (dummyjson implementation)
  - `searchProducts({ query?, category?, minPrice?, maxPrice?, sortBy?, limit? })` with **filtering in code**
  - `listCategories()`, `getProduct(id)`
- Agent tools wrap the domain functions. `toModelOutput` returns a slim product view to the model.
- System prompt includes:
  - the category list
  - the data gaps: no variants, so no colours or sizes
  - grounding rules: mention only products that were returned
  - when to ask a clarifying question and when to search
- Target behaviours:
  - **Open-ended:** "gift for my wife" or "kitchen remodel". Clarify, or map to candidate categories.
  - **Contextual refinement:** "too expensive, something cheaper". Set `maxPrice` from previous results.
  - **Failure states:** no results. Broaden or switch category, and tell the user.
  - **Unsupported attributes:** "do they have it in pink?". Say so honestly.
- `stopWhen` step limit tuned.
- **Golden eval set (evalite)**, seeded with the categories listed in 02 §11.

**Done when**
- [ ] Domain unit tests pass: filtering, sorting, empty results, API errors (with mocked HTTP).
- [ ] Mock-model tests pass: tool dispatch, `toModelOutput` shape, step-limit behaviour.
- [ ] The golden set meets agreed pass-rate thresholds. Proposed ≥ 4/5 per case; set the final number in the phase plan.
- [ ] The grounding check passes: no product is mentioned that the tool didn't return.

**Open questions**
- Is a sub-agent / agent-as-tool needed for open-ended exploration, or is prompt + step limit enough? Decide based on eval results.
- Fetch per request, or cache the catalog at startup?
- Should categories go in the prompt only, or also stay available as a tool?

## Phase 3 — Persistence & sessions `[ ]`

**Goal:** chats survive restarts. The schema is multi-user from day one.

**Scope**
- Confirm the SQLite driver (libsql is the default) and check it on Windows.
- Drizzle schema + migrations for `users`, `chats`, `messages` (stores `UIMessage`s with tool parts), and `chat_summaries` (the table only for now).
- A **default user** is created on first run. All data is scoped by `user_id`.
- Save on finish: the user message, then the assistant message in `onFinish`.
- CLI session commands: new chat, list chats, resume chat by id or index. Optionally generate a chat title from the first message.
- Step log moves to a table (optional).

**Done when**
- [ ] Store tests pass: create / list / load / append, scoping by `user_id`, and a full round-trip of tool parts.
- [ ] A resumed chat continues correctly. The model sees prior tool results and refinements still work after a restart.
- [ ] Works on Windows.

**Open questions**
- Should the CLI keep the "first message picks a session" UX, or switch to explicit commands (`/new`, `/list`, `/open`)?

## Phase 4 — Context management `[ ]`

**Goal:** long conversations stay within budget and keep their quality. Stored history is never mutated.

**Scope**
- Context view builder in `prepareStep`. Layers are applied in order (see 02 §7):
  1. slim tool outputs (already done in phase 2)
  2. prune old tool results (`pruneMessages`)
  3. incremental summary + recent window, using the `summarizer` role and stored in `chat_summaries`
- Token budget and thresholds are configurable.
- Fixtures of long conversations, recorded from real phase 2–3 chats in the DB.

**Done when**
- [ ] Unit tests for the view builder pass: the right messages are pruned, the summary is inserted, the window size is correct, and stored history is unchanged.
- [ ] Evals on long-conversation fixtures pass: earlier preferences (budget, recipient) are still respected after compaction.
- [ ] The step log shows bounded input tokens on long chats.

**Open questions**
- Summary trigger: by token count, by message count, or both?
- Should "user insights" (budget, recipient, tastes) be pulled out as structured state alongside the summary? This could be the seed for `user_memories`.

## Phase 5 — HTTP API & minimal client `[ ]`

**Goal:** the core is reachable over HTTP with streaming, and a basic web client works.

**Scope**
- Hono app with these endpoints:
  - `POST /chats/:id/messages` (UI message stream via `toUIMessageStreamResponse()`)
  - `GET /chats`
  - `POST /chats`
  - `GET /chats/:id/messages?before=&limit=` (paginated)
- Disconnect safety: `consumeStream()` + saving in `onFinish`.
- Product data in responses is JSON with **image URLs**, not base64.
- Minimal **Vite + React** client using `useChat`: chat list, switching chats, streaming text. Tool parts are shown as raw JSON or plain lists for now.
- The user is still the default user, passed implicitly.

**Done when**
- [ ] API tests (Hono's test client + mock model) pass: streaming, persistence, pagination, and a client that disconnects mid-stream still gets the full message saved.
- [ ] Manual end-to-end check: open the client, chat, switch chats, reload, and history is intact.
- [ ] Works on Windows.

## Phase 6 — Product UI `[ ]`

**Goal:** products display as proper tiles, live and from history.

**Scope**
- Render `tool-searchProducts` parts as a `<ProductTiles>` component (image, title, price, rating).
- Loading and error states for tool parts.
- Optional: an embeddable **web-component widget**. First check whether the AI SDK client can be used without React; if not, parse the UI message stream by hand.

**Done when**
- [ ] Tiles render during streaming and after reloading history.
- [ ] Component tests for the tile rendering pass.

## Phase 7 — Auth & users *(optional)* `[ ]`

**Goal:** real multiple users, each seeing only their own chats.

**Scope**
- Simple auth. Options to evaluate in the phase plan: a hand-rolled session cookie, or a library such as better-auth (it works with Hono + Drizzle + SQLite).
- Migrate data from the default user.
- Middleware that checks every route is scoped to the user.

**Done when**
- [ ] Tests confirm that user A cannot list or read user B's chats.
- [ ] Login/logout works from the client.

## Phase 8 — MCP endpoint & interop rendering *(optional)* `[ ]`

**Goal:** other MCP-capable clients can use the product search, with reasonable rendering.

**Scope**
- **Decide first:** expose the domain tools, an agent-as-tool, or both (open question from 02 §10).
- `@modelcontextprotocol/sdk` Streamable HTTP endpoint, mounted in Hono.
- Anonymous sessions, possibly with a persistent opaque id.
- Rendering for other clients:
  - a markdown fallback (list with image links)
  - optionally **MCP Apps** for hosts that support them

**Done when**
- [ ] MCP Inspector can list and call the tools.
- [ ] Works from at least one real MCP host, e.g. Claude Desktop.
- [ ] Tests for the MCP wrappers pass. They reuse the domain tests' fixtures.

---

## Backlog / ideas (unscheduled)

- `user_memories`: cross-chat preferences, optionally with embeddings via libsql vector search.
- Local semantic product search over the cached catalog.
- Cart actions via dummyjson `/carts` and UCP/ACP.
