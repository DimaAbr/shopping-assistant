# 11 — Phase 8: MCP endpoint

The phase plan and record for [03-roadmap.md](03-roadmap.md) phase 8. Decisions that change 02 are also noted there, with dates.

Planned on 2026-11-05. 02 §10 and 09 had already decided *what* to expose: `findProducts`, the search workflow. This round wraps it, with a markdown fallback for rendering. MCP Apps come later, if at all.

## Goals

- Any MCP host can search the catalog with the same workflow our chat agent uses.
- The host's model doesn't need to know our catalog quirks (09, "Goals").
- Results render reasonably in any host, without our React tiles.

## Decisions (2026-11-05)

| Topic | Decision | Notes |
|---|---|---|
| Memory and history window | **Don't affect the MCP tool** | They live in the chat agent (`chat.ts`, `chat-service.ts`, `prompt.ts`). `findProducts` was kept stateless on purpose (10, "Who applies the facts"). A host applies its own context when it writes `request` |
| Transport | **Streamable HTTP, stateless, JSON responses**, at `/mcp` on the `pnpm api` server | `WebStandardStreamableHTTPServerTransport` takes a Fetch `Request`, so it mounts straight into Hono. A fresh server and transport per POST; GET and DELETE are 405 |
| Sessions | **None.** Drops the roadmap's "anonymous sessions, possibly with an opaque id" | The tool has no user or chat state, so there's nothing to key a session on |
| Calling guidance | **In the tool description** (`mcpToolDescription`) | Our agent learns how to call `findProducts` from its system prompt; a host's model only sees the description. The host-relevant rules from `buildInstructions` are repeated: one call per request, a self-contained request, facts only about the recipient, budgets in `minPrice` / `maxPrice`, refinements, grounding, what `unmet` means. The category slugs come from the API at startup, as in the chat prompt |
| Input schema | **Shared** (`FindProductsInputSchema` in `agent/tools.ts`) | The chat tool's description stays its own: it mentions tiles |
| Result | **Markdown in `content`, the whole `ShoppingToolResult` in `structuredContent`** | Markdown: one section per group, image link, title, id, price, rating, brand, shipping, description, then the unmet needs. `catalog_unavailable` is a normal result, like in chat |
| `outputSchema` | **Not declared** | MCP needs an object schema, and the result is a discriminated union. `structuredContent` is allowed without one |
| Timeout | **`STEP_TIMEOUT_MS` per call**, the same bound as a chat step | Without it, an MCP call had no bound. A timeout and any other failure become `isError` results with a short message |
| Step log | **`chatId: tool:mcp-<uuid>`**, one id per call | MCP has no tool call id. The scopes stay `findProducts:plan` / `:relevance` |
| Local only | **Host must be localhost; `Origin`, when present, too** | The spec's DNS-rebinding rule for local servers. The SDK's own options for this are deprecated in favour of middleware, so it's a small Hono middleware |
| Rendering | **Markdown first. MCP Apps deferred** | Optional in the roadmap |

## Behaviour worth knowing

- **Cost.** Every MCP call runs the workflow's model calls (plan, relevance, maybe a refill) on our `searcher` model and key. That's fine on localhost. Rate limiting stays out of scope (02 §13).
- **Cancellation.** The handler passes the request's signal through, but in stateless mode a client's cancel notification arrives as a separate request to a separate server, so in practice only the timeout cuts a call short.
- **Shutdown** doesn't wait for running MCP calls: nothing is stored, so there's nothing to lose.

## Using it

- `pnpm api` logs `MCP endpoint: http://localhost:<port>/mcp`.
- MCP Inspector: `npx @modelcontextprotocol/inspector`, transport "Streamable HTTP", that URL.
- Claude Code: `claude mcp add --transport http shopping http://localhost:3000/mcp`.
- Claude Desktop only takes remote servers as connectors (public URL) or through a bridge such as `mcp-remote`.

## Tests

`test/adapters/mcp.test.ts` drives the Hono app with the SDK's `Client` and `StreamableHTTPClientTransport`, with `fetch` routed to `app.fetch` (no network). It reuses the fake repository and the scripted search model. It covers the tool list, markdown and structured content, catalog failures, input validation, step-log ids, the timeout, other failures, 405s and the localhost check. `test/adapters/mcp-render.test.ts` covers the renderer.
