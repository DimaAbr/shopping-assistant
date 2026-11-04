import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createUIMessageStreamResponse, type ToolSet } from 'ai'
import { z } from 'zod'

import type { ChatService } from '../../agent/chat-service.ts'
import { ChatNotFoundError } from '../../store/chat-store.ts'

/**
 * The HTTP API (07). A thin adapter: validates input, calls the chat service,
 * maps errors to status codes. The user is the default user, passed implicitly.
 *
 * - `GET  /chats`                                    chat list, newest activity first
 * - `GET  /chats/:id/messages?before=&limit=`        a page of stored history (UIMessages)
 * - `POST /chats/:id/messages` `{ message }`         one turn, streamed as a UI message stream (SSE)
 *
 * There is no `POST /chats`: the client owns chat ids (07, "Chat ids"). A POST to
 * an unknown id starts that chat, and it's stored with its first successful turn.
 *
 * Product data reaches clients inside tool parts (`tool-searchProducts`,
 * `tool-browseCategory`), shaped by `ShoppingToolResultSchema`, both live and from history.
 */

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200

const chatIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1–64 characters of A–Z, a–z, 0–9, _ or -')

const paginationQuerySchema = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
})

/** The `useChat` "send only the last message" body. Only text parts are supported. */
const messagesBodySchema = z.object({
  message: z.object({
    role: z.literal('user'),
    parts: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
  }),
})

export type ApiOptions<TOOLS extends ToolSet = ToolSet> = {
  service: ChatService<TOOLS>
  /** A turn that failed after its response started streaming (the client got an error chunk). */
  onTurnError?: (error: unknown, context: { chatId: string }) => void
}

export function createApi<TOOLS extends ToolSet>(options: ApiOptions<TOOLS>) {
  const { service } = options
  /** Chats with a turn in progress, until the turn is saved or has failed. */
  const running = new Map<string, Promise<void>>()

  const app = new Hono()

  app.get('/chats', async c => c.json(await service.listChats()))

  app.get('/chats/:id/messages', async c => {
    const chatId = parse(chatIdSchema, c.req.param('id'), 'chat id')
    const page = parse(paginationQuerySchema, c.req.query(), 'query')
    return c.json(await service.loadMessagesPage(chatId, page))
  })

  app.post('/chats/:id/messages', async c => {
    const chatId = parse(chatIdSchema, c.req.param('id'), 'chat id')
    const body = parse(messagesBodySchema, await c.req.json().catch(() => undefined), 'body')
    const text = body.message.parts.map(part => part.text).join('\n').trim()
    if (text === '') throw badRequest('body: message text is empty')

    // Concurrent turns would both build on the same history.
    if (running.has(chatId)) throw new HTTPException(409, { message: 'a reply for this chat is still in progress' })

    let release!: () => void
    running.set(chatId, new Promise(resolve => { release = resolve }))
    try {
      const chat = await service.openChat(chatId).catch(error => {
        if (error instanceof ChatNotFoundError) return service.newChat(chatId)
        throw error
      })
      const turn = await chat.send(text)

      // The turn finishes (and is saved) even if the client disconnects: the session
      // reads its own copy of the stream. So the chat stays busy until `done`, not until the response ends.
      void turn.done
        .catch(error => options.onTurnError?.(error, { chatId }))
        .finally(() => { running.delete(chatId); release() })

      return createUIMessageStreamResponse({ stream: turn.uiStream })
    } catch (error) {
      running.delete(chatId)
      release()
      throw error
    }
  })

  app.notFound(c => c.json({ error: 'not found' }, 404))

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    if (error instanceof ChatNotFoundError) return c.json({ error: 'chat not found' }, 404)
    console.error(error)
    return c.json({ error: 'internal error' }, 500)
  })

  return {
    app,
    /** Resolves when no turn is in progress — e.g. before shutting down. */
    async settled(): Promise<void> {
      while (running.size > 0)
        await Promise.allSettled([...running.values()])
    },
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw badRequest(`${what}: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

function badRequest(message: string) {
  return new HTTPException(400, { message })
}
