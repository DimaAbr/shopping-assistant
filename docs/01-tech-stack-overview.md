# Tech stack options for an AI shopping assistant

## 1. How the parts fit together

There are more choices here than it first looks, so it helps to split the system into layers. Most tools only cover one or two of them:

| Layer | What it does | Example options |
|---|---|---|
| **Model provider** | The LLM itself | Anthropic, OpenAI, Google, local models via Ollama |
| **Agent / orchestration** | The loop: send messages, model calls tools, run tools, repeat | Vercel AI SDK, LangChain/LangGraph, Mastra, provider SDKs |
| **Tool exposure** | How "search products" is made available to the model | Plain function tools, or an MCP server |
| **Server / transport** | HTTP API, streaming responses | Hono, Fastify, Express, Next.js route handlers |
| **Persistence** | Sessions and message history | JSON files, SQLite, later Postgres |
| **UI** | Chat, product cards | Console, Next.js + AI SDK UI, assistant-ui, LibreChat |
| **Evals / tests** | Checking behaviour | Vitest, evalite, promptfoo, LangSmith, Braintrust |

One thing to know early: **MCP is not an alternative to LangChain or the AI SDK.** It sits in a different layer. More on that below.

## 2. Agent frameworks (Node/TypeScript)

**Vercel AI SDK**
- A light, provider-agnostic library. `generateText` and `streamText` take tools, and you get the multi-step tool loop built in.
- Its `useChat` hook and stream protocol are made for Next.js, and assistant-ui plugs into it directly.
- It has mock models for testing.
- It is a library, not a framework: you own persistence and the server, which matches what you want.
- **Best fit for your goals**, especially since you might build a Next.js UI later.

**LangChain.js / LangGraph.js**
- LangChain is a large abstraction layer covering models, tools, retrievers and memory.
- LangGraph models the agent as an explicit state graph. It has checkpointers for conversation persistence, including SQLite and Postgres. That is a real plus for your multi-session needs.
- Downsides: more concepts, more churn, more "magic." The Python version is more mature than the JS one.
- Strongest when you need complex multi-step workflows, human-in-the-loop, or branching agents. A product search assistant probably doesn't need this.
- LangSmith, its observability and eval platform, is good but it's a hosted SaaS.

**Mastra**
- A TypeScript agent framework built on top of the AI SDK.
- Adds agents, workflows, memory with storage adapters (LibSQL/SQLite works locally), built-in evals and a local dev playground.
- It sits between "just the AI SDK" and LangGraph, with more batteries included. Worth a look if you want memory and session handling ready-made.

**Provider SDKs directly** (Anthropic SDK, OpenAI SDK, plus the OpenAI Agents SDK / Claude Agent SDK)
- Writing the tool loop yourself takes about 50–100 lines, and you understand everything that happens.
- The cost is lock-in to one provider unless you abstract it yourself.
- Good for learning. Less good if you want to swap models.

**If you're open to Python:** Pydantic AI is clean and typed, with good testing support (`TestModel`, `FunctionModel`). LangGraph is most mature in Python. FastAPI would be the server. Your emphasis on easy local setup works equally well in either ecosystem, but Node keeps one language if the UI ends up being Next.js.

## 3. Where MCP fits

The Model Context Protocol standardizes how tools and data are exposed to *any* MCP-capable client. You could write a small **dummyjson MCP server** with tools like `search_products`, `get_product` and `list_categories`. Then:
- Your own agent (built with the AI SDK, LangChain or Mastra, which all support MCP clients) uses it.
- Claude Desktop, LibreChat, Cursor and others can use the same server for free.
- The MCP Apps / UI extensions are emerging ways to render interactive UI, such as product cards, from tool results in compatible clients.

**Trade-off:** it adds a process boundary and some ceremony. A sensible path is to start with plain function tools in your agent, keep them in a clean module, and wrap them as an MCP server later if you want interoperability. The MCP TypeScript SDK makes that wrapper small.

## 4. Server and persistence

- **HTTP:** Hono is tiny, modern and runs anywhere. Fastify is mature with good schema validation. Express is familiar but dated. Use SSE (server-sent events) for streaming tokens.
- **Sessions:** JSON files (one per chat plus an index) are the simplest and fine for a prototype. Watch for concurrent writes.
- **SQLite** is probably the sweet spot for you. It's a single file, has no server and no container, and Node 22+ ships `node:sqlite` built in (`better-sqlite3` is the long-standing alternative). It also gives you an easy path to users and auth later, and an ORM like Drizzle can move you to Postgres down the line.
- **Message format:** store the full message list, *including tool calls and tool results*. Replaying a conversation correctly needs them, and so does rendering product cards from history.

## 5. UI options

| Option | Notes |
|---|---|
| **Console (readline)** | A good first step. Proves the server API works on its own. |
| **Next.js + AI SDK UI** | Lean and fully yours. Product cards come from rendering tool-result parts of messages. |
| **assistant-ui** | React component library for chat UIs (threads, streaming, tool UIs). Works with the AI SDK, LangGraph or a custom backend. You keep your server; it's just components. **Fits your architecture well.** |
| **LibreChat** | A full application with its own backend, auth and conversation storage (MongoDB, usually run via Docker). It would *duplicate* the server you want to build and clashes with your no-containers goal. You'd connect to it via MCP or an OpenAI-compatible endpoint. Better as "another client of my MCP server" than as your main UI. |

## 6. Testing LLM-driven flows

Think of it as three layers:

1. **Deterministic unit tests** (Vitest)
   - Tool functions against dummyjson, either mocked HTTP (msw) or live.
   - Session storage: create, list, load, append.
   - The agent loop, using a **mock model** that returns scripted tool calls (the AI SDK has `MockLanguageModel`). These are fast, free and run in CI.
2. **Behavioural evals against a real model.** A dataset of input → expected-behaviour cases:
   - *Intent detection:* "hi, how are you" should **not** call search. "I need a gift for my dad who likes cooking" **should**.
   - *Tool-call quality:* check the arguments (category, query terms, price filter).
   - *Grounding:* the response only mentions products that the tool actually returned. This can be checked in code against the IDs.
   - *Multi-turn:* "show me cheaper ones" refines the previous search.
   - Prefer **code-based assertions** on tool calls and structured output where you can. Use **LLM-as-judge** for fuzzy qualities like helpfulness or tone.
3. **Handling non-determinism:** run each case several times and use pass-rate thresholds (e.g. ≥ 4/5) rather than a single pass/fail. Pin model versions, and track scores over time so you notice regressions when you change prompts.

**Tools to read about:**
- **evalite** — Vitest-based, TypeScript, local.
- **promptfoo** — config-driven, CLI, local, any provider.
- Mastra's built-in evals.
- **LangSmith** or **Braintrust** — hosted dashboards.

Also look up "trajectory evaluation" (checking the sequence of tool calls) and "golden datasets."

## 7. UCP (low priority)

The Universal Commerce Protocol is an open standard, led by Google with Shopify and major retailers. It describes commerce capabilities (catalog, checkout, orders) so agents can complete purchases. It can be carried over REST, MCP or A2A. OpenAI and Stripe's **Agentic Commerce Protocol (ACP)** is a competing or adjacent spec worth reading alongside it.

For your project: dummyjson has a `/carts` endpoint, so a mock "add to cart / checkout" capability shaped like UCP is feasible later. The main design implication now is to keep the product and tool layer cleanly separated, so commerce capabilities can be added as more tools or an MCP surface.

## 8. Candidate stacks

- **Lean, recommended starting point:** Node + TypeScript, Hono, Vercel AI SDK, SQLite (`node:sqlite`), Vitest + evalite, console client, then assistant-ui or Next.js. Optionally an MCP wrapper later.
- **More batteries included:** Mastra, which brings memory and storage, evals and a playground, on top of the AI SDK.
- **Graph or workflow heavy:** LangGraph (JS or Python) with its SQLite checkpointer and LangSmith for evals.
- **Python:** FastAPI + Pydantic AI + SQLite + pytest/DeepEval.

**Suggested reading order:**
1. AI SDK docs on tool calling and message persistence
2. The MCP spec intro and TypeScript SDK
3. Mastra overview, as a comparison point
4. assistant-ui docs (runtime adapters)
5. An evals primer (evalite or promptfoo docs; Hamel Husain's writing on LLM evals is a good conceptual start)
6. The UCP spec last
