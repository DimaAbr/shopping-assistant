import { and, asc, desc, eq, lt, sql } from 'drizzle-orm'
import type { UIMessage } from 'ai'
import type { Database } from './db.ts'
import { chats, messages, users } from './schema.ts'

/**
 * Chat persistence (02 §6). Persistence only — no model calls, no prompts.
 *
 * Every read and write is scoped by `userId`: a chat id alone never gives
 * access to another user's chat. Until auth (phase 7) there is one user,
 * `DEFAULT_USER_ID`, created on first run.
 */

export const DEFAULT_USER_ID = 'default'

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

export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`chat not found: ${chatId}`)
    this.name = 'ChatNotFoundError'
  }
}

export function createChatStore(db: Database, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date())

  async function ownedChat(userId: string, chatId: string) {
    const [chat] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))

    return chat !== undefined
  }

  return {
    /** Idempotent. */
    async ensureDefaultUser() {
      await db
        .insert(users)
        .values({ id: DEFAULT_USER_ID, name: 'Default user', createdAt: now() })
        .onConflictDoNothing()

      return DEFAULT_USER_ID
    },

    async createChat(userId: string, chat: { id: string, title?: string | null }) {
      const at = now()

      await db
        .insert(chats)
        .values({
          id: chat.id,
          userId,
          title: chat.title ?? null,
          createdAt: at,
          updatedAt: at,
        })
    },

    /** Newest activity first. */
    async listChats(userId: string): Promise<ChatSummary[]> {
      const rows = await db
        .select({
          id: chats.id,
          title: chats.title,
          createdAt: chats.createdAt,
          updatedAt: chats.updatedAt,
          parts: messages.parts,
        })
        .from(chats)
        .leftJoin(messages, and(eq(messages.chatId, chats.id), eq(messages.seq, 0)))
        .where(eq(chats.userId, userId))
        .orderBy(desc(chats.updatedAt), desc(chats.createdAt))

      return rows.map(({ parts, ...chat }) => ({ ...chat, firstText: parts === null ? null : textOf(parts) }))
    },

    async getChat(userId: string, chatId: string): Promise<ChatSummary | undefined> {
      return (await this.listChats(userId)).find(chat => chat.id === chatId)
    },

    /** The whole chat in order. Throws `ChatNotFoundError` if the user doesn't own it. */
    async loadMessages(userId: string, chatId: string): Promise<UIMessage[]> {
      if (!await ownedChat(userId, chatId)) throw new ChatNotFoundError(chatId)

      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(asc(messages.seq))

      return rows.map(toUIMessage)
    },

    /**
     * The newest `limit` messages before the message `before` (or the newest overall),
     * in chronological order. `hasMore` says whether older messages exist.
     * Throws `ChatNotFoundError` if the user doesn't own the chat or `before` isn't one of its messages.
     */
    async loadMessagesPage(userId: string, chatId: string, page: { before?: string, limit: number }): Promise<MessagePage> {
      if (!await ownedChat(userId, chatId)) throw new ChatNotFoundError(chatId)

      let beforeSeq: number | undefined
      if (page.before !== undefined) {
        const [anchor] = await db
          .select({ seq: messages.seq })
          .from(messages)
          .where(and(eq(messages.chatId, chatId), eq(messages.id, page.before)))

        if (anchor === undefined) throw new ChatNotFoundError(chatId)
        beforeSeq = anchor.seq
      }

      // One extra row tells whether there's an older page.
      const rows = await db
        .select()
        .from(messages)
        .where(and(
          eq(messages.chatId, chatId),
          beforeSeq === undefined ? undefined : lt(messages.seq, beforeSeq),
        ))
        .orderBy(desc(messages.seq))
        .limit(page.limit + 1)

      return {
        messages: rows.slice(0, page.limit).reverse().map(toUIMessage),
        hasMore: rows.length > page.limit,
      }
    },

    /**
     * Appends after the existing messages, in one transaction, and bumps `updated_at`.
     * With `createIfMissing`, a chat that doesn't exist yet is created in the same
     * transaction — so a chat is never stored without its first messages.
     */
    async appendMessages(userId: string, chatId: string, newMessages: readonly UIMessage[], options: { createIfMissing?: boolean } = {}) {
      if (newMessages.length === 0) return

      await db.transaction(async tx => {
        const at = now()
        
        const [chat] = await tx
          .select({ userId: chats.userId })
          .from(chats)
          .where(eq(chats.id, chatId))

        if (chat === undefined && options.createIfMissing)
          await tx.insert(chats).values({ id: chatId, userId, title: null, createdAt: at, updatedAt: at })
        else if (chat?.userId !== userId)
          throw new ChatNotFoundError(chatId)

        const [{ next }] = await tx
          .select({ next: sql<number>`coalesce(max(${messages.seq}) + 1, 0)` })
          .from(messages)
          .where(eq(messages.chatId, chatId)) as [{ next: number }]

        await tx
          .insert(messages)
          .values(newMessages.map((message, i) => ({
            id: message.id,
            chatId,
            seq: next + i,
            role: message.role,
            parts: message.parts,
            metadata: message.metadata ?? null,
            createdAt: at,
          })))

        await tx
          .update(chats)
          .set({ updatedAt: at })
          .where(eq(chats.id, chatId))
      })
    },

    async setTitle(userId: string, chatId: string, title: string) {
      await db
        .update(chats)
        .set({ title })
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    },
  }
}

export type ChatStore = ReturnType<typeof createChatStore>

function toUIMessage(row: typeof messages.$inferSelect): UIMessage {
  return {
    id: row.id,
    role: row.role,
    parts: row.parts,
    ...(row.metadata == null ? {} : { metadata: row.metadata }),
  }
}

function textOf(parts: UIMessage['parts']): string {
  return parts.flatMap(part => part.type === 'text' ? [part.text] : []).join(' ').trim()
}
