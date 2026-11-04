import { openDatabase } from '../../src/store/db.ts'
import { createChatStore } from '../../src/store/chat-store.ts'

/** A fresh, migrated in-memory store with a controllable clock (+1s per call). */
export async function memoryStore() {
  const db = await openDatabase(':memory:')
  let tick = Date.UTC(2026, 10, 4, 12, 0, 0)
  const store = createChatStore(db, { now: () => new Date(tick += 1000) })
  return Object.assign(store, { db })
}
