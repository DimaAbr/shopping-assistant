import type { UIMessage } from 'ai'

/**
 * Store result types, kept free of database imports so clients can use them
 * through the HTTP contract (`adapters/http/contract.ts`) without pulling in the DB.
 */

export type ChatSummary = {
  id: string
  /** Generated after the first turn; `null` until then (or if generation failed). */
  title: string | null
  /** The first user message's text — a label for chats without a title. */
  firstText: string | null
  createdAt: Date
  updatedAt: Date
}

export type MessagePage = {
  /** Chronological order. */
  messages: UIMessage[]
  /** Whether older messages exist before this page. */
  hasMore: boolean
}

/** A stored fact about the user or someone they shop for (10, "Memories"). */
export type Memory = {
  id: string
  /** `user`: lasting, shared by all the user's chats. `chat`: the current shopping task of one chat. */
  scope: MemoryScope
  /** `self`, or a relation as the user put it ("wife", "son"). */
  subject: string
  text: string
}

export type MemoryScope = 'user' | 'chat'

export const SELF = 'self'

/** A change to a user's memories. `update` and `remove` refer to `Memory.id`. */
export type MemoryOp =
  | { op: 'add', scope: MemoryScope, subject: string, text: string }
  | { op: 'update', id: string, text: string }
  | { op: 'remove', id: string }
