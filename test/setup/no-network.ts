/**
 * Unit tests run offline. Any real `fetch` fails loudly here instead of
 * silently passing on a connected dev machine and failing in CI / offline.
 * Code under test gets a fake `fetch` or a fake repository injected instead.
 */

globalThis.fetch = async input => {
  throw new Error(`network access in unit tests: ${String(input instanceof Request ? input.url : input)}`)
}
