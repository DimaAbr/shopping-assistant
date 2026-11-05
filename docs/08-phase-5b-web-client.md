# 08 — Phase 5b: Web client, identity seam & product tiles

The phase plan and record for the client half of [03-roadmap.md](03-roadmap.md) phase 5. Decisions that change 02 are also noted there, with dates.

Planned on 2026-11-04. The API (07) was done; the MVP still needed a chat client that renders product widgets. This round also adds a placeholder identity seam (no auth) and pulls the product tiles in from phase 6.

## Goals

- A familiar chat UI (sidebar + thread) **without hand-rolling a chat component library**. Standard chat UX should come from a library.
- A **headless core** that owns the session logic, so a later embeddable widget (web component or iframe) can reuse it with its own host config.
- One identity model for both embed cases: an **authenticated host** passes its user, and an **anonymous host** gets a widget-generated id that survives reloads.

## Decisions (2026-11-04)

| Topic | Decision | Notes |
|---|---|---|
| UI library | **assistant-ui unstyled primitives** (`@assistant-ui/react` 0.15) + **plain CSS modules** | The primitives handle scrolling, the composer, send/stop and streaming states. The look is ours. See "UI library" |
| Rejected: AI Elements | Built on shadcn/ui, **Tailwind-only**; customizing means editing Tailwind classes | The user doesn't want Tailwind. Plain CSS is also simpler to inject into a shadow root for the embed |
| Rejected: assistant-ui's styled components / thread list | The styled layer is shadcn/Tailwind too. A thread list over our backend would need a remote thread-list adapter | We use only the primitives, and our own sidebar |
| Rejected: hand-rolled | Autoscroll, composer, stop/retry and streaming states are the polish a library already has | `use-stick-to-bottom` + `react-markdown` stays the fallback if assistant-ui stops fitting |
| State owner | **Our `useChat`** (`@ai-sdk/react` 4, AI SDK v7) | `useAISDKRuntime(chat)` wraps the `useChat` result; assistant-ui doesn't own the state |
| Transport | **One `DefaultChatTransport` per client.** `prepareSendMessagesRequest` targets `/chats/:id/messages` with `{ message: last }` | `useChat` passes the chat id per request. Regenerate isn't supported by the API and throws |
| Config | **One `ShoppingConfig` object** at `<ShoppingProvider config>`: `apiBaseUrl`, optional `identity`, `storage`, `fetch` | No globals. An embed only maps its attributes to this object |
| Identity | **`X-User-Id` header.** The host's `identity.userId`, or an anonymous `anon-<uuid>` kept in `localStorage` | See "Identity". **A placeholder, not auth: the server trusts the header** |
| Anonymous id storage | **`localStorage`, not a cookie** | Embedded on a customer's site, a cookie for our API is third-party and often blocked. A header also keeps CORS simple (no credentials) |
| Users | Created **with their first stored chat**, in the same transaction | Visitors who only open the widget leave no rows |
| Server shape | `createChatService(...)` → `{ forUser(userId), settled() }` | Per-request user chats; background titles are shared |
| Wire types | `shopping-assistant/contract` (`src/adapters/http/contract.ts`), **types only** | `ChatSummary` / `MessagePage` moved to `src/store/types.ts` so the contract doesn't reach `db.ts` (Node-only) |
| Active chat | In the **URL hash** | A reload reopens it. New chat ids are generated client-side (07, "Chat ids") |
| Product tiles | `ProductTiles` registered for `searchProducts` and `browseCategory` via `MessagePrimitive.Parts` `tools.by_name` | Same component live and from history. States: skeleton while running, `ok` grid, `empty`, `catalog_unavailable` |
| Dev serving | Vite proxies `/api` → the API (`API_URL`, default `http://localhost:3000`) | Same origin, so no CORS yet. CORS comes with the embed |

## Spike results (2026-11-04)

Checked against the installed packages before building:

- `@assistant-ui/react-ai-sdk` 1.4 has `peerDependencies: { ai: ^7 }`. `useAISDKRuntime(chatHelpers, adapter?)` takes a `useChat` result, so **`useChat` stays the source of truth** (02 §9 assumed we'd have to adopt assistant-ui's runtime).
- `MessagePrimitive.Parts` takes `components.tools.by_name` (tool name → component) and `Fallback`. Tool components get `{ toolName, args, result, status }`; `result` is our `ShoppingToolResult`.
- `ThreadPrimitive.Messages` takes a render function `({ message }) => …` (the `components` prop is deprecated).
- `@assistant-ui/react-markdown` gives an unstyled `MarkdownTextPrimitive` (react-markdown underneath).
- `HttpChatTransport` keeps constructor `headers` when `prepareSendMessagesRequest` doesn't return any, and lets it override `api` per request.
- A failed POST (400 / 409 / 500) reaches `useChat` as an `APICallError` with `statusCode` and the raw body; `describeChatError` turns it into a short message (409: "still in progress").

## Identity

```
host page                         widget (core)                         API
─────────                         ─────────────                         ───
identity: { userId: 'u-42' }  ──▶ X-User-Id: u-42                   ──▶ forUser('u-42')
(no identity)                 ──▶ localStorage 'shopping.anonUserId'
                                  ('anon-<uuid>', created once)
                                  X-User-Id: anon-…                 ──▶ forUser('anon-…')
(curl / CLI, no header)                                             ──▶ default user
```

- The id must match the chat id pattern (1–64 of `A–Z a–z 0–9 _ -`), or the API answers 400.
- A user only sees their own chats. Another user's chat id behaves as missing: history is 404, and a POST to it streams a reply that isn't saved (the turn fails with `ChatNotFoundError` and is reported through `onTurnError`). That's unchanged from 06/07.
- **Phase 7** replaces the trusted header with something verifiable (a session cookie on the first-party page, or a host-signed token for embeds). The client seam stays: `identity` in the config.

## Core

`web/src/core/` has no styling and no assistant-ui imports:

| File | What |
|---|---|
| `config.ts` | `ShoppingConfig` |
| `identity.ts` | `resolveUserId(config)` |
| `api-client.ts` | `createApiClient(config)` → `userId`, `listChats()`, `loadHistory(chatId, before?)` (a `MessagePage` of `HISTORY_LIMIT` messages; 404 → an empty page), `transport`, `newChatId()`; `describeChatError` |
| `provider.tsx` | `<ShoppingProvider config>`: builds the client once and owns the chat list (`useChatList()`: refreshes after a turn, and again 3 s later for the background title) |
| `use-shopping-chat.ts` | `useChatHistory(chatId)` (the newest page), then `useShoppingChat(chatId, initialMessages)` = `useChat({ id, messages, transport, onFinish: refresh })`; `useEarlierMessages(chat, hasMore)` prepends older pages via `setMessages` |

`useChat` reads `messages` only when it creates the chat, so the UI mounts the chat once history has loaded, **keyed by chat id**.

## UI library

`web/src/ui/` is the standalone page:

- `App.tsx`: the sidebar plus the active chat (hash-based). Below 40rem the sidebar is an off-canvas drawer behind a menu button (closes on select, backdrop, Escape)
- `Sidebar.tsx`: our own chat list
- `Thread.tsx`: assistant-ui primitives. User/assistant messages, markdown text, tool parts → `ProductTiles`, encrypted reasoning parts hidden, a composer with Send/Stop, scroll-to-bottom, inline errors
  - While a reply streams, Enter does nothing. assistant-ui would insert a newline, which looks like a send that failed. Stop only ends the client's request: the server turn keeps running and is saved (07), so a Send right after Stop can get 409.
- `ProductTiles.tsx`: the product widget. Image, title, price, and the description trimmed to 3 lines in CSS (07: the full description is sent). Below a 30rem container width (container query, so embeds behave too) tiles become compact rows with the image beside the text
- `*.module.css` + `global.css`: design tokens as CSS variables (light and dark), so a host theme only overrides variables. `color-scheme: light dark` is declared, and buttons inherit `color`, so native controls follow the theme

## Behaviour worth knowing

- **Tiles show every product the tool returned**, not only the ones the model picked. "Perfume under $100" shows a $129.99 tile, while the model's text lists only the cheaper ones. This is the missing price filter (phase 2b). Once 2b filters in code, the tiles follow.
- An **empty first search** stays visible ("No products found for 'perfume'") above the agent's retry. It's accurate, but noisy. It could be collapsed later.
- **History is paged.** A chat opens on its newest page; a "Load earlier messages" button at the top prepends older pages and keeps the scroll position. It's our own button: `ThreadPrimitive.LoadEarlier` needs `hasEarlier`/`onLoadEarlier` on the runtime, and `useAISDKRuntime` doesn't pass them through. Pages are `HISTORY_LIMIT` = 200 messages (the API's max).
- **The bundle is ~945 KB** (≈280 KB gzip), mostly assistant-ui, Radix and react-markdown. It's fine for the standalone page. Revisit for the embed (code-split or trim).
- **No regenerate / edit.** The API only appends new user messages, so the UI has no reload or edit actions.
- Clearing `localStorage` gives a fresh anonymous user. The old chats stay in the DB under the old id.

## Layout

```
pnpm-workspace.yaml          packages: [web]
package.json                 exports './contract'; script `web`
src/
  store/types.ts             ChatSummary, MessagePage (DB-free)
  store/chat-store.ts        + ensureUser; appendMessages creates a missing user with the chat
  agent/chat-service.ts      createChatService → { forUser(userId), settled }; UserChats type
  adapters/bootstrap.ts      returns defaultUserId
  adapters/cli/main.ts       service.forUser(defaultUserId)
  adapters/http/app.ts       X-User-Id → service.forUser(...); createApi({ service, defaultUserId })
  adapters/http/contract.ts  wire types for clients (types only)
web/
  vite.config.ts             /api proxy; vitest (jsdom)
  src/core/                  headless core (see "Core")
  src/ui/                    standalone page (see "UI library")
  test/core.test.ts          identity, api client, transport request shape, error text
  test/product-tiles.test.tsx  tile states from a stored-history output
  test/app.test.tsx          whole page on a fake API: history → tiles + markdown, new chat
test/
  adapters/http-api.test.ts  + identity: per-user lists, hidden chats, 400 for a bad id
  store/chat-store.test.ts   + a user is created with their first chat
```

## Results (2026-11-04)

- `pnpm test`: 116 passed (112 before; +3 HTTP identity, +1 store).
- `pnpm --filter shopping-web test`: 14 passed. The app test was checked to fail when the `searchProducts` tile mapping is removed.
- `pnpm typecheck` is clean in both packages. `pnpm --filter shopping-web build` works, and the bundle contains no server code (no drizzle / libsql).
- Manual check against the live model and catalog, through the Vite proxy and headless Chromium:
  - a new anonymous user's first turn is stored and titled
  - another user gets 404 for it
  - reload reopens the chat with its tile and markdown
  - a new chat streams, shows Stop while running, renders 5 tiles, and appears in the sidebar
- `pnpm eval` wasn't run: there are no prompt, tool or context changes.
- Windows: checked by the user (2026-11-04). Install, tests, `pnpm api` and `pnpm web` work; chat works and searches return product tiles.

## How to run

```sh
pnpm install
pnpm api           # http://localhost:3000
pnpm web           # http://localhost:5173, proxies /api to the API

# the API as a given user
curl localhost:3000/chats -H 'x-user-id: someone'
```

With the API on another port: `PORT=3123 pnpm api` and `API_URL=http://localhost:3123 pnpm web`.
