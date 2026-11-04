import type { ShoppingConfig } from './config.ts'

/**
 * The user the widget acts as (08, "Identity"): the host's user if it passed one,
 * otherwise an anonymous id generated once and kept in storage.
 *
 * Storage, not a cookie: embedded on another site, a cookie for our API would be
 * third-party and is often blocked. The id travels as the `X-User-Id` header.
 * It's an opaque identifier, not a credential (no auth yet, phase 7).
 */

export const ANONYMOUS_ID_KEY = 'shopping.anonUserId'

export function resolveUserId(config: Pick<ShoppingConfig, 'identity' | 'storage'>): string {
  if (config.identity) return config.identity.userId

  const storage = config.storage ?? globalThis.localStorage
  const stored = storage.getItem(ANONYMOUS_ID_KEY)
  if (stored) return stored

  const id = `anon-${crypto.randomUUID()}`
  storage.setItem(ANONYMOUS_ID_KEY, id)
  return id
}
