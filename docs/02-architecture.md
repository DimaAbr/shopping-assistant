# 02 — Architecture & design decisions

This is the stable reference for *what* we're building on and *why*. It builds on [01-tech-stack-overview.md](01-tech-stack-overview.md) and on the planning session that followed it. The phased plan is in [03-roadmap.md](03-roadmap.md).

Decisions use a lightweight ADR format:

- **Decision**: what we chose
- **Why**: the reasoning
- **Rejected**: alternatives we considered
- **Revisit when**: what would make us reconsider

When a decision changes, edit it in place and add a dated note. Don't silently rewrite it. Assumptions that turned out to be wrong are recorded in §14.

---

## 1. Goals & constraints

- **What it is:** an LLM-driven personal shopping assistant over the [dummyjson](https://dummyjson.com/docs/products) products API.
- **POC / learning project.** It doesn't need to be production grade. When a choice has to be made, prefer the one that teaches how the ecosystem works over the one that hides it.
- **Multi-user.** Each user has multiple chats and can switch between them.
- **Local only:**
  - No Docker.
  - No SaaS (no hosted DBs, eval platforms or observability).
  - Minimal setup.
- **Cross-platform.** It must run on **Windows** as well as Linux. Check this at every phase boundary.
- **Language:** Node + TypeScript.
- **Provider-agnostic code.** Only configuration knows which model or provider is in use.

> **Note (2026-11-03, phase 1):** tooling settled. Details are in [04-phase-1-scaffold.md](04-phase-1-scaffold.md).
> - **Node 26** (LTS)
> - **pnpm** with a single package; split into a workspace in phase 5
> - **TypeScript 7** + `tsx`
> - provider: **`@ai-sdk/openai`**
> - **no formatter, no ESLint**: the layering rules are enforced by `test/architecture.test.ts`

## 2. Model

**Decision**
- The only model available is `gpt-6-luna`.
- Code reaches models through a small **role-based model registry** in config:
  - `chat`: the main assistant
  - `summarizer`: context compaction
  - `judge`: LLM-as-judge evals
- Today all three roles map to `gpt-6-luna`.

**Why**
- Swapping a model or provider, or one role only, becomes a config change.
- Nothing outside the registry imports a provider package.

**Known risk**
- Using the same model as the evaluation judge gives a self-preference bias.
- To limit it, prefer code-based assertions (§11). Use the judge only for fuzzy qualities such as tone and helpfulness.

**Revisit when** a second model becomes available. The judge role is the first one to move.

## 3. Orchestration — Vercel AI SDK (core)

**Decision**
- Use the AI SDK's core API: `streamText` / `generateText` and its agent abstraction with the multi-step tool loop.
- These features carry most of the design:

| Feature | Used for |
|---|---|
| `stopWhen` (step-count conditions) | Limiting the tool loop |
| `prepareStep` | The hook for context management (§7). It runs before each model call and can rewrite the messages the model sees |
| `toModelOutput` on tools | Keeping what the **model** sees from a tool small. The full result still goes to the **UI** |
| `onStepFinish` / `onFinish` | Observability (§12) and persistence (§6) |
| `pruneMessages` | Stripping old tool calls and results out of the model's view |
| Mock models (`ai/test`) | Deterministic tests of the loop (§11) |

> **Note (2026-11-03, phase 1):** we're on AI SDK **v7**, which renamed several of these. The old names still work but are deprecated. We use the new ones:
>
> | Old name | v7 name |
> |---|---|
> | `onStepFinish` | `onStepEnd` (plus `onStepStart`) |
> | `onFinish` | `onEnd` |
> | `system` | `instructions` |
> | `stepCountIs` | `isStepCount` |
> | `result.response.messages` | `result.responseMessages` |
>
> The mock model is `MockLanguageModelV4`. The rest of this doc keeps the old names where they describe a concept.

**Why**
- It is provider-agnostic, yet low-level enough that we write the memory and session logic ourselves. That is the learning goal.
- It also comes with a client stream protocol (`useChat`) for the UI later.

**Rejected**
- **Provider SDKs:** they lock the core flow to one vendor.
- **LangGraph:** its graph and state-machine model is overhead for a mostly linear flow. Most of it would go unused.
- **Mastra:** the fastest way to an MVP, but too opinionated and pre-built to learn from.

**Revisit when** the control flow really becomes branching or workflow-shaped. Mastra is built on the AI SDK, so its memory and workflow pieces can be adopted gradually without a rewrite.

### Sub-agents

- Start with **one agent and good tools**.
- Add a sub-agent only when a golden eval case (§11) shows the single agent can't handle it. An example is open-ended gift exploration with retries ("no flowers, try chocolate").
- A sub-agent would be an **agent-as-tool**: a tool whose `execute` runs its own `generateText` loop.

## 4. Layering

```
                ┌──────────────────────── adapters ────────────────────────┐
                │  CLI (phase 1)     HTTP / Hono (phase 5)    MCP (phase 8) │
                └───────────┬──────────────────┬──────────────────┬────────┘
                            │                  │                  │
                ┌───────────▼──────────────────▼──────────────────▼────────┐
                │ agent      prompts · tool wrappers · loop · model registry│
                │            context view builder (prepareStep)             │
                ├───────────────────────────────────────────────────────────┤
                │ domain     ProductRepository (dummyjson impl) · zod schemas│
                │            searchProducts() · listCategories() · getProduct()│
                ├───────────────────────────────────────────────────────────┤
                │ store      Drizzle schema · users · chats · messages ·    │
                │            summaries                                       │
                └───────────────────────────────────────────────────────────┘
```

- **domain**
  - Plain typed functions with zod input and output schemas. No AI SDK imports.
  - Unit-testable without any model.
- **agent**
  - Wraps domain functions as AI SDK `tool()`s.
  - Owns the prompts, the loop configuration and the context view.
- **store**
  - Persistence only.
- **adapters**
  - Thin wrappers. The **CLI calls the core directly**, not through HTTP, so it is just another adapter.
  - The MCP server later wraps the same domain functions (and possibly the agent, see §10).

Tools run **in-process**. MCP is an *outward* interface for other clients. Our own agent doesn't use MCP internally.

## 5. Product data (dummyjson) constraints

dummyjson is small and simple. Its limits drive the tool design more than prompting does.

- **The catalog is small:**
  - roughly 190–200 products
  - about 24 categories
  - `limit=0` returns everything
- **Search is basic keyword matching** (`/products/search?q=`).
- Products can be listed by category (`/products/category/{slug}`).
- `sortBy` / `order` / `limit` / `skip` / `select` are supported.
- **No price-range filter.**
- **No variants.** There are no colours or sizes, so "do they have it in pink?" has no data behind it.

**Decision**
- **The search tool filters in code.**
  - Inputs: TBD
  - For complex/unsupported filters, it fetches from the API, then filters and sorts on our side.
  - Consider background indexing and persistance, or gradual cached loading
- **The category list goes into the system prompt.** It's short and rarely changes. Then the model can map "gift for my wife" to `womens-jewellery`, `fragrances`, `beauty`, … without spending a tool call. A `listCategories` tool stays available as a fallback.
- **Everything goes through a `ProductRepository` interface.** Fetching per request and caching the whole catalog at startup are interchangeable implementations. The cached version also enables local semantic search later.
- **The prompt should acknowledge data gaps** (variants, stock specifics). The model should say so rather than invent an answer.

> **Note (2026-11-03, phase 2):** phase 2 was cut down to the core. Details are in [05-phase-2-shopping-core.md](05-phase-2-shopping-core.md).
> - **Two tools, 1:1 with endpoints:** `searchProducts({ query })` and `browseCategory({ category })`. No filtering in code yet; that comes with price filters in phase 2b.
> - **Categories:** fetched once at startup, put in the prompt and used as a **zod enum** for `browseCategory`. No `listCategories` tool.
> - **Trimmed product model:** id, title, description, category, price, rating, brand, thumbnail. Fields we don't model are stripped, so the agent has no data to make claims about stock, warranty or shipping.
> - **Tools return a status** (`ok` / `empty` / `catalog_unavailable`) instead of throwing.

## 6. Persistence — SQLite (libsql) + Drizzle

**Decision**
- SQLite through **libsql** (`@libsql/client`), with **Drizzle** for the schema and migrations.

**Why**
- It's a single file with no server and no container.
- libsql ships **prebuilt binaries**, which fits the Windows requirement. `better-sqlite3` native builds are a common Windows pain.
- libsql has **built-in vector search**. That removes the main reason to plan a move to Postgres.
- Drizzle keeps migrations simple. The data model is still portable if we ever do move.

**Rejected**
- **JSON files:** concurrency issues, and multi-user would need its own indexing.
- **Postgres:** an extra dependency, or Docker.
- **`node:sqlite` / `better-sqlite3`:** both viable. Choose libsql unless phase 3 testing turns up a problem. Make the final driver choice at the start of phase 3 and record it here.

**Data model sketch.** This is not final; phase 3 settles it.

| Table | Key columns | Notes |
|---|---|---|
| `users` | id, name, created_at | A single **default user** exists from phase 3 until auth (phase 6) |
| `chats` | id, user_id, title, created_at, updated_at | `user_id` is there from day one, which avoids a migration later |
| `messages` | id, chat_id, role, parts (JSON), metadata (JSON), created_at | Stores AI SDK **`UIMessage`s**. Parts are kept as a JSON blob, not normalised |
| `chat_summaries` | id, chat_id, covers_up_to_message_id, text, created_at | Derived data for context management (§7) |
| `user_memories` *(later)* | id, user_id, content, embedding?, created_at | Preferences and insights. Optional |

- Store the **full** message list, including tool calls and tool results. Correct replay and product-tile rendering from history both need them.
- The answer to disconnects is in §8.

## 7. Context model

This is the central concept of the memory work.

**Decision**
- **Stored history is the source of truth and is never rewritten.** The UI always shows the full history.
- The model gets a **derived view**, built in `prepareStep` (or just before the call). Apply the layers in this order and stop when the context is small enough:
  1. **Slim tool outputs** (`toModelOutput`). The model gets id / title / price / rating / a short description. The UI gets the full product objects.
  2. **Prune old tool results** (`pruneMessages`). Earlier search results are dropped and their conclusions kept.
  3. **Summary + recent window.** The newest summary covers older messages, followed by the last N messages verbatim. Summaries are stored in `chat_summaries` and regenerated incrementally.

**Why**
- In this domain most context bloat comes from tool results, not conversation length. Layers 1 and 2 do most of the work cheaply. Layer 3 is the interesting learning part.
- Keeping the stored history separate from the model view means compaction bugs never destroy data.

## 8. Server / transport — Hono + UI message stream

**Decision**
- **Hono** for HTTP. It's also a chance to learn it.
- Stream with the AI SDK **UI message stream** (SSE) via `toUIMessageStreamResponse()`. It returns a standard web `Response`, which Hono returns directly.
- **Disconnects:**
  - Call `result.consumeStream()` so generation finishes even if the client goes away.
  - Save the assistant message in `onFinish`.
  - The client re-fetches history when it reconnects.
- **History endpoints are paginated:** load the latest N messages, then page back.

**Rejected**
- **Next.js as the core:** the API is the product. UI and MCP are its consumers.
- **Resumable streams:** they need Redis.

**Revisit when** mid-stream resume really matters.

## 9. Client UI

**Decision**
- The first client is a **Vite + React** page using the AI SDK **`useChat`** hook against the Hono endpoint.
- **Product tiles** come from rendering **tool parts**: a `tool-searchProducts` part maps to a `<ProductTiles>` component. In current AI SDK terms, this is what "generative UI" means.
- **Images use dummyjson's CDN URLs**, never base64. Base64 bloats the stream, and if it ends up in history it leaks into model context.
- The **embeddable web-component widget** comes later, as a separate step. First check whether the AI SDK client can be used without React. If it can't, parse the UI message stream (SSE) by hand.

**Rejected**
- **LibreChat:** has its own backend, DB and Docker.
- **Vercel Chatbot template:** a full Next.js app with its own DB and auth.
- **assistant-ui:** too much for the small UI we need. Revisit it if the custom UI grows or to make the full-page chat experience more familiar-looking if web components and MCP are descoped.
- **AI SDK RSC `streamUI`:** tied to Next.js React Server Components, and not the actively developed path.

## 10. Interop — MCP (later)

- **What to expose is an open question:**
  - domain tools (`search_products`, `list_categories`) for the host's own model to drive
  - an agent-as-tool (`ask_shopping_assistant`)
  - both

  Decide at the start of the MCP phase.
- **Rendering in other clients:** our React components can't run there. Two options:
  - a **markdown fallback** (product list with image links), which works everywhere
  - **MCP Apps** (the MCP UI extension) for hosts that support it
- **Auth:** anonymous sessions, possibly with a persistent opaque id. Full MCP OAuth 2.1 is out of scope.
- **SDK:** `@modelcontextprotocol/sdk`, Streamable HTTP transport, mounted in the Hono app.

## 11. Testing strategy

Testing starts in phase 1, not at the end. There are three layers:

| Layer | Tooling | What it covers | When it runs |
|---|---|---|---|
| **Deterministic** | Vitest; dummyjson mocked with msw or fixtures | Domain functions, filtering, repository, store (create / list / load / append), context view builder | Always (CI-able) |
| **Loop / wiring** | Vitest + AI SDK mock model (`ai/test`) with scripted tool calls | Tool dispatch, step limits, `toModelOutput`, persistence hooks, error paths | Always |
| **Behaviour evals** | **Golden set** against the real model (evalite planned; a vitest harness in practice, see §14.6) | Intent, tool-call quality, grounding, multi-turn refinement | **On demand only**, to save tokens |

**Eval conventions**
- **Prefer code-based assertions:**
  - "called `searchProducts` with `category ∈ {…}`"
  - "`maxPrice` < the previous result's price"
  - "every product mentioned in the reply has an id that the tool returned" (the grounding check)
- Use the LLM judge only for fuzzy qualities.
- **Non-determinism:** run each case N times (e.g. 5) and require a pass rate (e.g. ≥ 4/5).
- Run evals against a **pinned model version**. Keep result history so prompt changes can be compared.
- **Golden-set seed categories:**
  - small talk (no tool call)
  - direct product request
  - open-ended gift
  - budget refinement ("cheaper")
  - no results / fallback
  - unsupported attribute (colour or size)
  - category confusion

## 12. Observability

**Decision**
- From phase 1, log every step through `onStepFinish` to a local **JSONL file**, or to a table once the DB exists.
- Fields: chat id, step number, tool calls + arguments, tool result size, token usage, finish reason, latency.

**Why**
- In phase 2, most time goes into asking why the model did something. A local log answers that without a SaaS.
- AI SDK `experimental_telemetry` (OpenTelemetry) stays an option if a local viewer is ever wanted.

## 13. Out of scope

- UCP / ACP (commerce protocols)
- Resumable streams (needs Redis)
- Postgres
- Hosted eval and observability platforms (LangSmith, Braintrust, Langfuse cloud)
- Full MCP OAuth
- Production hardening: rate limiting, multi-instance deployment

## 14. Assumptions revisited (planning session, 2026-11-02)

This is a record of where the original plan's assumptions were wrong or changed during planning. Keep it as it is, so you can later look back at what changed and why. If later phases prove other assumptions wrong, add them here with a date.

### 14.1 Mistaken assumptions

| # | Original assumption | What's actually the case | What changed |
|---|---|---|---|
| 1 | AI SDK "generative UI" is a semi-standard way to deliver UI that other clients (including MCP clients) can render. | AI SDK RSC `streamUI` is tied to Next.js React Server Components, and it isn't the actively developed path. In current AI SDK terms, "generative UI" means **our own client renders tool parts**. Other clients can't run our components. | Our client renders tool parts (§9). Other clients get a **markdown fallback** and optionally **MCP Apps** (§10). The separate "gen-UI variant" phase was dropped and folded into the MCP phase. |
| 2 | The server would be exposed as an MCP tool that a separate chat agent consumes. *(Self-corrected before this session.)* | The chat model runs inside our server and calls tools in-process. MCP is only an *outward* interface for other clients. | §4 layering: domain functions + AI SDK `tool()` wrappers internally. MCP wraps the same functions later. |
| 3 | Moving to Postgres would be needed for vector search / semantic features. | libsql (SQLite) has built-in vector search. | Postgres moved out of scope (§6, §13). Drizzle is still kept for migrations and portability. |
| 4 | The API should return product images as a resource / base64. | dummyjson already serves CDN image URLs. Base64 bloats the stream, and once it's in history it leaks into the model's context. | Image URLs are passed through as they are (§9). |
| 5 | Vercel's pre-built Chatbot UI would be a quick way to test the API in phase 5. | It's a full Next.js app with its own DB and auth. Pointing it at our Hono API is more work than writing a small client. | A minimal Vite + React `useChat` page instead (§9, phase 5). |
| 6 | Long conversation length is the main pressure on the context window, so summarization/compaction is the core of memory work. | In this domain, most context bloat comes from **tool results** (full product objects). | Layered context view: slim tool outputs, then pruning of old tool results, then summary (§7). Summarization is the last layer, not the first. |

### 14.2 Open questions resolved by research

| Question (from notes-to-self) | Answer | Effect |
|---|---|---|
| What does the dummyjson API support? Can "cheaper" or "in pink" be passed to it? | There's no price-range filter and no variants (colours or sizes). Search is basic keyword matching. The catalog is small (≈190–200 products, ≈24 categories). | The search tool filters in code. The category list goes in the system prompt. The prompt acknowledges data gaps (§5). *Still to be checked against the live API in phase 2.* |
| How to handle disconnects and network instability? | `consumeStream()` + saving in `onFinish`. Resumable streams need Redis. | §8. Resumable streams are out of scope. "Disaster recovery" was dropped as a vague requirement. |
| Can the Vercel AI client be used without their UI? | `useChat` is a hook that only handles the transport and state. The UI is ours. Use outside React still needs checking. | React + `useChat` first. The web-component widget is a later step (§9). |
| How is auth done with MCP? | Properly, with OAuth 2.1. That's far more work than this POC needs. | Anonymous sessions for MCP (§10). |

### 14.3 Plan changes (not mistakes, but decisions that moved)

- **Phase order:** persistence now comes *before* context management, so long conversations can be stored and replayed to test compaction.
- **Phases 8 + 9 merged:** "gen-UI variant" and "MCP endpoint" became one interop phase (see 14.1 #1).
- **`user_id` in the schema from the first persistence phase,** with a default user, instead of being added together with auth.
- **SQLite driver:** libsql preferred over `better-sqlite3` for Windows prebuilt binaries. To be confirmed in phase 3.

### 14.4 Additions the original plan didn't cover

- **Observability from day 1:** step logging via `onStepFinish` (§12).
- **Model registry by role** (`chat` / `summarizer` / `judge`), and the self-judging bias of a single-model setup (§2).
- **Eval golden set as a phase 2 deliverable.** Testing was always planned for every phase. This makes the *behavioural* part concrete: code-based assertions, pass-rate thresholds, run on demand (§11).

### 14.5 Phase 1 (2026-11-03)

| # | Assumption | What's actually the case | What changed |
|---|---|---|---|
| 1 | The AI SDK API names in §3 / §12 (`onStepFinish`, `onFinish`, `system`, `stepCountIs`) are current. | AI SDK v7 renamed them. The old names are deprecated aliases. | The new names are used in code. There's a mapping note in §3. |
| 2 | Lint (ESLint) would enforce the layering rules. | typescript-eslint 8.x doesn't support TypeScript 7. | An import-scanning Vitest test (`test/architecture.test.ts`) enforces the layering instead. There's no lint toolchain. |
| 3 | A stream error surfaces as that error when the result is awaited. | v7 rejects `responseMessages` with a generic `NoOutputGeneratedError`. The real cause goes only to `onError`. | `agent/chat.ts` captures the error in `onError` and rethrows it. A test covers this. |

### 14.6 Phase 2 (2026-11-03)

| # | Assumption | What's actually the case | What changed |
|---|---|---|---|
| 1 | dummyjson search is "basic keyword matching". | It matches the **whole query as one substring** of the title or description. `lipstick red` and `laptops` find nothing. | The tool description and prompt ask for a short singular phrase in title word order. On an empty result the agent retries once with a simpler keyword or the closest category. |
| 2 | An unknown category would be an API error. | `/products/category/{unknown}` returns an empty list. | `browseCategory` takes a zod enum of real slugs. |
| 3 | evalite would be the eval runner (§11). | evalite 0.19 targets vitest 4 and `@ai-sdk/provider` v2, and needs `better-sqlite3` (native, rejected in §6). | A small harness on plain vitest in `evals/` (05 "Evals"). |
| 4 | Category slugs say what's in them. | `tops` holds girls' frocks and dresses. The agent sometimes suggests "tops" for a boy. | Known issue, open in 03 phase 2. |
