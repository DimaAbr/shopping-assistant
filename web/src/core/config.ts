/**
 * Everything the chat needs from its host, in one object (08, "Core").
 * There are no globals: a standalone page, a web component or an iframe embed
 * each build one of these and pass it to `<ShoppingProvider>`.
 */
export type ShoppingConfig = {
  /** Where the HTTP API is, e.g. `/api` (dev proxy) or `https://shop.example.com/api`. */
  apiBaseUrl: string
  /**
   * An authenticated host passes its user. Without it the widget is anonymous:
   * it generates an opaque id and keeps it in `storage`, so a reload keeps the chats.
   */
  identity?: { userId: string }
  /** Where an anonymous id is kept. Default: `localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  /** Default: the global `fetch`. Injected in tests. */
  fetch?: typeof fetch
}
