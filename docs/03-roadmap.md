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

## Phase 2 — Shopping core (single user, short sessions) `[x]`

Phase record: [05-phase-2-shopping-core.md](05-phase-2-shopping-core.md).

> **Rescoped (2026-11-03):** cut down to the core loop: intent → query → tool → grounded reply, plus missing information, empty results and errors. Price, sorting, "cheaper", unsupported attributes, stock/shipping, product details and caching moved to phase 2b.

**Goal:** a single agent that reliably turns conversation into well-formed product searches and answers only with grounded results.

**Scope**
- Domain layer:
  - `ProductRepository` (dummyjson implementation, 1:1 with endpoints, no filtering in code)
  - a trimmed product model: fields we don't use are stripped
- Two agent tools:
  - `searchProducts({ query })`
  - `browseCategory({ category })`, with the category as an enum of real slugs
- `toModelOutput` gives the model a slim view without images.
- Categories are fetched once at startup and go into the prompt. There is no `listCategories` tool.
- System prompt rules:
  - intent: small talk vs. product request vs. vague request (ask first, with category suggestions)
  - query structuring
  - grounding
  - empty / unavailable states
- The last allowed step forbids tools, so a turn always ends in text.
- A golden eval set with code-based grounding checks.

**Done when**
- [x] Domain unit tests pass: empty results, field stripping, API errors (with an injected fake `fetch`).
- [x] Mock-model tests pass: tool dispatch, `toModelOutput` shape, step-limit behaviour, error status reaching the model.
- [x] The golden set passes ≥ 4/5 per case, except the known `tops` issue (left open, see 2b).
- [x] The grounding check passes: no product or price is mentioned that a tool didn't return.
- [x] Works on Windows (checked 2026-11-03).

**Open questions**
- ~~Fetch per request, or cache the catalog at startup?~~ Fetch per request; only categories are loaded at startup. Caching is in 2b.
- ~~Should categories go in the prompt only, or also stay available as a tool?~~ Prompt + enum only.
- Is a sub-agent / agent-as-tool needed for open-ended exploration? Not so far: the vague-request cases pass with prompt + step limit.
- Ambiguous category slugs (`tops` holds girls' dresses) mislead the agent. **Moved to 2b**: the fix depends on the data strategy there.

## Phase 2b — Shopping refinement `[~]`

> **Deferred (2026-11-04):** 2b comes after the core: persistence & sessions (phase 3) and the HTTP API & client (phase 5). The more complex queries need more design thought than the MVP needs. The phase numbers stay as they are.

**Goal:** the features cut from phase 2, built on the same grounding and empty-state behaviour.

**Data strategy: decided (2026-11-04).** dummyjson is treated as a stand-in for a **large, live, changing catalog API** (stock, sales and discounts change). We must not overload it or mirror it locally. So:
- ~~**Store the catalog locally:** filter in code over the local copy; recategorise or rename misleading categories.~~ Rejected: no full local copy.
- ~~**Light pre-fetch:** fetch one or two items per category at startup, so the model sees what each category holds.~~ Rejected: no bulk pre-fetch.
- **Live API:** queries go to the API. Results are checked against the request after the query, then we fetch another page or treat the result as empty / out of stock. Any caching is short-lived and per query, never a mirror.

The detailed design (filtering, paging, the `tops` fix) is left for 2b's own planning session.

> **Part 1 (2026-11-04): consolidated search.** Phase record: [09-phase-2b-product-search.md](09-phase-2b-product-search.md). A live test ("accessories and shoes" for a workout) gave 3 tool calls, 15 tiles, women's heels and a reply that repeated the tiles. `searchProducts` / `browseCategory` are replaced by **one `findProducts({ request, minPrice?, maxPrice? })` tool**, which runs a fixed workflow: plan → query → price filter in code → relevance filter → one refill. Results are grouped by need, with `unmet` needs. The reply is a short lead-in.

**Scope**
- ~~Price filters~~ (done in part 1: `minPrice` / `maxPrice`, filtered in code) and sorting. Contextual refinement: "too expensive, something cheaper" sets `maxPrice` from previous results *(part 1: prompt rule + eval case)*.
- ~~Combined query + category search.~~ Done in part 1: the planner mixes both per need.
- Unsupported attributes: "do they have it in pink?". There are no variants in the data; say so honestly.
- Stock / shipping filters: ~~"only in stock"~~ (part 1: out-of-stock is always filtered out in code), "ships to me". *Part 1: shipping time is known data, and the relevance step applies stated deadlines. Destinations aren't in the data.*
- Product details: `getProduct(id)`, plus the warranty and return fields (added back to the product model). *(Shipping time, tags and availability were added in part 1; weight and dimensions are dropped as meaningless, 09.)*
- Short-lived, per-query caching behind the `ProductRepository` interface, if paging and post-query checks need it (no catalog mirror).
- Fix for ambiguous categories (`tops`), following the data strategy. *Part 1: the relevance filter drops misfits from results. The clarifying-question side is still open: no catalog knowledge goes into prompts, so the model only sees slugs (09).*
- Eval cases for each: ~~budget refinement~~, unsupported attribute, ~~category confusion~~ (part 1 added both, plus multi-need and budget).

**Done when**
- [~] Domain unit tests for filtering and sorting pass. *(Filtering, paging and dedupe done in part 1; sorting open.)*
- [~] New eval cases pass ≥ 4/5, and the phase 2 cases still do. *(Part 1, 2026-11-04: 18/19 with the new product fields. The school/`tops` case is unstable, 3/5 to 5/5 between runs. Open: the cases for the remaining 2b features.)*
- [x] Part 1 works on Windows (checked by the user, 2026-11-04).

## Phase 3 — Persistence & sessions `[x]`

Phase record: [06-phase-3-persistence-sessions.md](06-phase-3-persistence-sessions.md).

**Goal:** chats survive restarts. The schema is multi-user from day one.

**Scope**
- Confirm the SQLite driver (libsql is the default) and check it on Windows.
- Drizzle schema + migrations for `users`, `chats` and `messages` (stores `UIMessage`s with tool parts). *(2026-11-04: `chat_summaries` moved to phase 4, whose migration adds it when something uses it.)*
- A **default user** is created on first run. All data is scoped by `user_id`.
- Save on finish: the user message and the assistant message together, in one transaction, once the turn succeeds.
- CLI session commands: `/sessions` (list), `/sessions <n|id>` (switch), `/new`. A chat title is generated after the first turn.
- Step log moves to a table (optional). *Not done: the JSONL file is still enough.*

**Done when**
- [x] Store tests pass: create / list / load / append, scoping by `user_id`, and a full round-trip of tool parts.
- [x] A resumed chat continues correctly. The model sees prior tool results and refinements still work after a restart.
- [x] Works on Windows (checked by the user, 2026-11-04).

**Open questions**
- ~~Should the CLI keep the "first message picks a session" UX, or switch to explicit commands (`/new`, `/list`, `/open`)?~~ **Explicit commands** (2026-11-04). Startup opens a new chat; `/sessions` lists and switches.

## Phase 4 — Context management `[~]`

> **Deferred (2026-11-04):** like 2b, this isn't part of the MVP. It comes after the HTTP API (phase 5). The phase numbers stay as they are.

> **Rescoped (2026-11-05):** phase record: [10-phase-4-context-memory.md](10-phase-4-context-memory.md). Long-running chats (the embedded widget) made this urgent. **No summary**: the chat model sees a recent window of messages. Facts about the user are **extracted after each turn** into `memories` (lasting or per-chat, each tagged with who it's about), and the chat agent gets them in its instructions. `chat_summaries` is dropped.

**Goal:** long conversations stay within budget and keep their quality. Stored history is never mutated.

**Scope**
- ~~Context view builder in `prepareStep`. Layers are applied in order (see 02 §7):~~ Rescoped (2026-11-05):
  1. slim tool outputs (already done in phase 2)
  2. ~~prune old tool results (`pruneMessages`)~~ Not needed: old tool results age out with the window
  3. ~~incremental summary + recent window~~ **recent window only** (`HISTORY_WINDOW`), plus **memories** extracted after each turn by the `memory` role
- ~~Token budget and thresholds are configurable.~~ The window size is configurable.
- Fixtures of long conversations, recorded from real phase 2–3 chats in the DB. *(Replaced by multi-chat memory eval cases, 10.)*

**Done when**
- [x] Unit tests pass for the window (size, starts at a user message, stored history unchanged, resumed chats load only the tail), memory store, extraction and wiring.
- [x] Memory evals pass: an earlier budget is still respected outside the window, a recipient's facts don't mix with the user's, and lasting facts carry over between chats. *(2026-11-05: all four 5/5. The rest of the set passed too, except the known unstable school case, which a separate comparison showed isn't a regression (10 "Results").)*
- [x] The step log shows bounded input tokens on long chats. *(2026-11-05, a 24-turn scripted chat: with the window, input levels off at about 4.5–5.5k tokens per call from turn ~11. Without it, input reaches 7.8k and keeps growing (10, "Long chat").)*
- [x] Works on Windows (checked by the user, 2026-11-05: searches work and memories are stored and used).

**Open questions**
- ~~Summary trigger: by token count, by message count, or both?~~ No summary (2026-11-05). The window is by message count.
- ~~Should "user insights" (budget, recipient, tastes) be pulled out as structured state alongside the summary?~~ Yes, and instead of the summary: `memories` (10).
- Should users be able to see and delete their memories? (`GET/DELETE /memories`, needs phase 7 for anything beyond a POC.)

## Phase 5 — HTTP API & minimal client `[x]`

Phase records: [07-phase-5-http-api.md](07-phase-5-http-api.md) (API), [08-phase-5b-web-client.md](08-phase-5b-web-client.md) (client).

> **Client rescoped (2026-11-04):** a familiar chat UI from **assistant-ui primitives + plain CSS** over our own `useChat` core, instead of a minimal hand-rolled page. Product tiles (phase 6) and a placeholder identity seam (`X-User-Id`, ahead of phase 7) were pulled in.

> **Split (2026-11-04):** the API comes first (no users, no MCP, no UI). The minimal client follows as the second half.

**Goal:** the core is reachable over HTTP with streaming, and a basic web client works.

**Scope: API** `[x]`
- Hono app with these endpoints:
  - `POST /chats/:id/messages` (UI message stream via `createUIMessageStreamResponse({ stream: turn.uiStream })`)
  - `GET /chats`
  - ~~`POST /chats`~~ Dropped (2026-11-04): chat ids are client-generated, so retries can't create duplicate chats (07, "Chat ids").
  - `GET /chats/:id/messages?before=&limit=` (paginated)
- Disconnect safety: ~~`consumeStream()` + saving in `onFinish`~~. The session already drains its own stream branch, so the turn is saved anyway (02 §8 note).
- Product data in responses is JSON with **image URLs**, not base64. The widget contract is a `ProductCard` inside the tool output (07, "Product card contract").
- The user is still the default user, passed implicitly.

**Scope: client** `[x]`
- ~~Minimal **Vite + React** client using `useChat`: chat list, switching chats, streaming text. Tool parts are shown as raw JSON or plain lists for now.~~ Rescoped (08):
  - `web/` workspace package: Vite + React, assistant-ui primitives, CSS modules
  - headless core: `ShoppingConfig`, identity, API client + transport, chat list, `useShoppingChat`
  - product tiles for both shopping tools, live and from history
  - identity seam: `X-User-Id` (host user or anonymous `localStorage` id); users created with their first chat

**Done when**
- [x] API tests (Hono's test client + mock model) pass: streaming, persistence, pagination, and a client that disconnects mid-stream still gets the full message saved.
- [x] The eval set is unchanged by the tool-output change: 12/13 before and after (only the known `tops` case, 3/5).
- [x] Client tests pass: core, tiles, and the whole page on a fake API (08, "Results").
- [x] Manual end-to-end check: open the client, chat, switch chats, reload, and history is intact. *(2026-11-04, live model, headless Chromium; 08 "Results".)*
- [x] Works on Windows (checked by the user, 2026-11-04: install, tests, `pnpm api` and `pnpm web`; chat works and searches return product tiles).

## Phase 6 — Product UI & embed `[~]`

> **Tiles done in phase 5b (2026-11-04):** see 08. What's left is the embed and tile polish.

**Goal:** products display as proper tiles, live and from history.

**Scope**
- ~~Render `tool-searchProducts` parts as a `<ProductTiles>` component (image, title, price, rating).~~ Done in 5b, for both tools. Rating isn't shown yet.
- ~~Loading and error states for tool parts.~~ Done in 5b.
- Optional: an embeddable **widget** (web component or iframe) over the 5b core. ~~First check whether the AI SDK client can be used without React.~~ It can: `ai`'s `Chat` class (02 §14.8). Open: shadow-root styling, CORS, bundle size (~945 KB), and how a host passes identity.
- Tile polish: ~~show only the products the reply is about (after 2b's filtering), collapse empty retries~~ (part 1 of 2b: one filtered, grouped result per request; no retries), load older history.

**Done when**
- [x] Tiles render during streaming and after reloading history.
- [x] Component tests for the tile rendering pass.
- [ ] The widget embeds on a plain HTML page, anonymous and with a host-provided user.

## Phase 7 — Auth & users *(optional)* `[ ]`

**Goal:** real multiple users, each seeing only their own chats.

> **Seam in place (2026-11-04, 08):** the API already scopes by an `X-User-Id` header (trusted, no auth), and the client config takes `identity`. This phase makes the identity verifiable.

**Scope**
- Simple auth. Options to evaluate in the phase plan: a hand-rolled session cookie, or a library such as better-auth (it works with Hono + Drizzle + SQLite).
- Migrate data from the default user.
- Middleware that checks every route is scoped to the user.

**Done when**
- [ ] Tests confirm that user A cannot list or read user B's chats.
- [ ] Login/logout works from the client.

## Phase 8 — MCP endpoint & interop rendering *(optional)* `[~]`

> **Planned (2026-11-05):** details in [11-phase-8-mcp.md](11-phase-8-mcp.md). Stateless `/mcp` on the API server, markdown fallback; MCP Apps deferred.

**Goal:** other MCP-capable clients can use the product search, with reasonable rendering.

**Scope**
- ~~**Decide first:** expose the domain tools, an agent-as-tool, or both (open question from 02 §10).~~ Decided (2026-11-04, 09): expose **`findProducts`**, the search workflow, as the MCP tool.
- `@modelcontextprotocol/sdk` Streamable HTTP endpoint, mounted in Hono. `[x]`
- ~~Anonymous sessions, possibly with a persistent opaque id.~~ Dropped (2026-11-05, 11): the tool is stateless, so the endpoint is too.
- Rendering for other clients:
  - a markdown fallback (list with image links) `[x]`
  - optionally **MCP Apps** for hosts that support them (deferred, 11)

**Done when**
- [x] MCP Inspector can list and call the tools.
- [x] Works from at least one real MCP host, e.g. Claude Desktop.
- [x] Tests for the MCP wrappers pass. They reuse the domain tests' fixtures.

---

## Backlog / ideas (unscheduled)

- ~~`user_memories`: cross-chat preferences, optionally with embeddings via libsql vector search.~~ Done in phase 4 as `memories`, without embeddings (10).
- Local semantic product search over the cached catalog.
- Cart actions via dummyjson `/carts` and UCP/ACP.
