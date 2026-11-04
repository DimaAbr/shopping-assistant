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
