# 07 — Phase 5: HTTP API

The phase plan and record for [03-roadmap.md](03-roadmap.md) phase 5. Decisions that change 02 are also noted there, with dates.

Planned on 2026-11-04. **This round is the core API only**: the default user stays implicit, and there's no MCP and no web client. Phase 4 (context management) is deferred, like 2b. The minimal client is the second half of this phase and comes later.

The main requirement: product data comes back in a **stable, structured shape** that a client can render as in-chat widgets (title, description, price, image).

## Decisions (2026-11-04)

| Topic | Decision | Notes |
|---|---|---|
| Server | **Hono** 4.13 + **`@hono/node-server`** 2.1 | `pnpm api`. Port from `PORT`, default 3000 |
| Product data for widgets | **Inside the tool output.** Each product is a `ProductListing`: a `ProductCard` plus the fields the model uses | One shape everywhere: the live UI stream, stored history and the history endpoint. No translation layer. See "Product card contract" |
| Description | **Sent whole.** The widget trims it | It's presentational. Descriptions are about 170–200 characters, so traffic isn't a concern |
| Chat ids | **Client-generated. No `POST /chats`** | See "Chat ids" |
| Request body | `{ message: UIMessage }`, user role, text parts only | The `useChat` "send only the last message" shape. The server holds the history |
| Concurrency | **One turn per chat at a time.** A second POST gets 409 | Concurrent turns would build on the same history and interleave `seq` |
| Disconnects | **Already handled by the session.** No `consumeStream()` | The session drains its own branch of the teed UI stream (06), so a turn finishes and is saved even if the client cancels. Tested |
| Shared wiring | `src/adapters/bootstrap.ts` | Config, models, repo, DB, categories and service, used by both CLI and HTTP. Startup failures print one line and exit |

## Product card contract

Defined in `src/domain/product-card.ts`. The tool output schema is `ShoppingToolResultSchema` in `src/agent/tools.ts`.

```ts
ProductCard = {
  id: number,
  title: string,
  description: string,   // full text; the widget trims it
  price: number,
  currency: 'USD',       // dummyjson prices carry no currency
  imageUrl: string,      // dummyjson `thumbnail`, a CDN URL, never base64 (02 §9)
}

ProductListing = ProductCard & { category: string, rating: number, brand?: string }

ShoppingToolResult =
  | { status: 'ok', total: number, products: ProductListing[] }
  | { status: 'empty' }
  | { status: 'catalog_unavailable' }
```

Where clients find it:
- **Live:** a `tool-output-available` chunk on the UI message stream. Its `output` is a `ShoppingToolResult`.
- **History:** a `tool-searchProducts` / `tool-browseCategory` part of an assistant message, with `state: 'output-available'` and the same `output`.

The model doesn't see `imageUrl` or `currency`. `toModelOutput` is an explicit field whitelist (`id, title, description, category, price, rating, brand`), so a new card field never reaches the model by accident. The model view is unchanged from phase 2.

## Chat ids

There's no `POST /chats`. The client generates the chat id, and the first `POST /chats/:id/messages` to an unknown id starts that chat. As before (06), it's stored with its first successful turn.

**Why.** At first `POST /chats` was going to stay, so clients wouldn't depend on generating ids. A stable id matters more for retries and network instability:
- With a server-created id, a client that loses the `POST /chats` response (or the first message's) and retries creates a second chat, or more, with the same first message.
- A client-owned id is fixed before the first request, so every retry or replay targets the same chat.

Ids are 1–64 characters of `A–Z a–z 0–9 _ -`. A chat owned by another user still behaves as missing: its first append fails with `ChatNotFoundError` (06, "Scoping").

## Routes

| Route | Response |
|---|---|
| `GET /chats` | `ChatSummary[]`, newest activity first (`id`, `title`, `firstText`, `createdAt`, `updatedAt`) |
| `GET /chats/:id/messages?before=&limit=` | `{ messages: UIMessage[], hasMore }`. Up to `limit` messages before the message id `before` (or the newest), oldest first. `limit` defaults to 50, max 200. 404 for an unknown chat or `before` id |
| `POST /chats/:id/messages` | Body `{ message: { role: 'user', parts: [{ type: 'text', text }] } }`. Returns the turn as a UI message stream (SSE, `createUIMessageStreamResponse`). 409 while a turn for this chat is running |

> **Note (2026-11-04, phase 5b):** every route now takes an optional **`X-User-Id`** header. Without it the request acts as the default user, as above. With it, the request acts as that user, who is created with their first chat. It's a trusted placeholder, not auth. Details are in 08, "Identity".

Errors are JSON `{ error }`: 400 for validation, 404 for unknown chats and routes, 409 for busy chats, 500 otherwise. A turn that fails after streaming has started reaches the client as an `error` chunk, is reported via `onTurnError` (logged by `main.ts`) and isn't saved.

## Behaviour worth knowing

- **A chat stays busy until its turn is saved, not until the response ends.** After a disconnect, the next POST may get 409 for a moment.
- **Shutdown** (Ctrl+C / SIGTERM) stops accepting requests, then waits up to 10 s for running turns and pending titles before closing the DB. A second Ctrl+C quits at once.
- **The busy set is in-memory**, so it's per process. Fine for a single local server.
- **If saving fails after the stream has finished,** the client has already seen `finish`, but the turn isn't stored. It's logged via `onTurnError`. That's rare for local SQLite. Revisit if it matters.

## Layout

```
src/
  domain/product-card.ts      ProductCard / ProductListing schemas, toProductListing
  agent/tools.ts              ShoppingToolResultSchema; outputs ProductListing[]; whitelisted toModelOutput
  store/chat-store.ts         + loadMessagesPage
  agent/chat-service.ts       + newChat(id?), loadMessagesPage
  adapters/bootstrap.ts       shared wiring for CLI and HTTP
  adapters/http/app.ts        createApi({ service }) → { app, settled }
  adapters/http/main.ts       server + graceful shutdown
test/
  domain/product-card.test.ts
  adapters/http-api.test.ts   Hono app.request + mock model + :memory: store
  helpers/mock-model.ts       + gatedTextReply (holds a turn open mid-stream)
```

## Results (2026-11-04)

- `pnpm test`: 112 passed. That includes the HTTP tests for streaming, persistence, pagination, 400/404/409, and disconnect mid-stream (the turn is still saved). The 409 and disconnect tests were checked to fail when their guard is removed.
- `pnpm eval`: 12/13 before and after the tool-output change. The only failure is the known `tops` case (3/5, 03 phase 2b).
- Windows: tests, `pnpm chat` and `pnpm api` checked by the user.
- Manual check against the live model and catalog: `POST` streams a `tool-output-available` chunk with card fields, and `GET /chats/:id/messages` returns the same card from history.

## How to run

```sh
pnpm api           # http://localhost:3000 (PORT to change)

curl -N -X POST localhost:3000/chats/my-chat-1/messages \
  -H 'content-type: application/json' \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"show me some lipstick"}]}}'

curl localhost:3000/chats
curl 'localhost:3000/chats/my-chat-1/messages?limit=20'
```
