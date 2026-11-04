import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import type { UIMessage } from 'ai'

/**
 * Drizzle schema (02 §6, 06 "Schema").
 *
 * `user_id` is on every chat from day one, so auth (phase 7) needs no migration.
 * Messages are AI SDK `UIMessage`s: `parts` is kept as a JSON blob, not normalised —
 * it holds tool parts with their full (raw) output, which the UI renders later.
 * `chat_summaries` is added by phase 4's migration, when something uses it.
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
