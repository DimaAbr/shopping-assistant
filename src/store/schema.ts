import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import type { UIMessage } from 'ai'

/**
 * Drizzle schema (02 §6, 06 "Schema").
 *
 * `user_id` is on every chat from day one, so auth (phase 7) needs no migration.
 * Messages are AI SDK `UIMessage`s: `parts` is kept as a JSON blob, not normalised —
 * it holds tool parts with their full (raw) output, which the UI renders later.
 * `memories` holds facts extracted from chats (10). Chats are never summarized,
 * so the planned `chat_summaries` table isn't needed.
 */

const createdAt = () => integer('created_at', { mode: 'timestamp_ms' }).notNull()

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  title: text('title'),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, table => [
  index('chats_user_updated_idx').on(table.userId, table.updatedAt),
])

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  /** Position in the chat, 0-based. The order messages were appended in. */
  seq: integer('seq').notNull(),
  role: text('role', { enum: ['system', 'user', 'assistant'] }).notNull(),
  parts: text('parts', { mode: 'json' }).$type<UIMessage['parts']>().notNull(),
  metadata: text('metadata', { mode: 'json' }).$type<unknown>(),
  createdAt: createdAt(),
}, table => [
  uniqueIndex('messages_chat_seq_idx').on(table.chatId, table.seq),
])

/**
 * One fact about a user or someone they shop for (10, "Memories").
 * `chat_id` null: a lasting fact, shared by all the user's chats. Otherwise it
 * belongs to that chat's current shopping task and is deleted with the chat.
 */
export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  chatId: text('chat_id').references(() => chats.id, { onDelete: 'cascade' }),
  /** Who the fact is about: `self` (the user) or a relation as the user put it ("wife", "son"). */
  subject: text('subject').notNull(),
  text: text('text').notNull(),
  /** The user message the fact was taken from, for debugging. */
  sourceMessageId: text('source_message_id'),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, table => [
  index('memories_user_chat_idx').on(table.userId, table.chatId),
])
