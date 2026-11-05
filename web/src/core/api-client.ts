import { APICallError, DefaultChatTransport, type UIMessage } from 'ai'
import type { ChatSummaryJson, ErrorBody, MessagePage, SendMessageBody } from 'shopping-assistant/contract'

import type { ShoppingConfig } from './config.ts'
import { resolveUserId } from './identity.ts'

/**
 * The headless client for the HTTP API (07, 08): the chat list, history, and the
 * `useChat` transport. No React and no styling, so any host UI can sit on top.
 */

export const USER_ID_HEADER = 'x-user-id'

/**
 * Messages per history page: the newest page when a chat opens, then each
 * "load earlier" page (the API's max page size).
 */
export const HISTORY_LIMIT = 200

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export function createApiClient(config: ShoppingConfig) {
  const base = config.apiBaseUrl.replace(/\/+$/, '')
  const userId = resolveUserId(config)
  const headers = { [USER_ID_HEADER]: userId }
  // Looked up per call, so a `fetch` patched after startup (tests, devtools) is used.
  const fetchFn: typeof fetch = (input, init) => (config.fetch ?? globalThis.fetch)(input, init)

  const chatUrl = (chatId: string) => `${base}/chats/${encodeURIComponent(chatId)}/messages`

  async function getJson<T>(url: string): Promise<T> {
    const response = await fetchFn(url, { headers })
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as ErrorBody | undefined
      throw new ApiError(response.status, body?.error ?? `${response.status} ${response.statusText}`)
    }
    return await response.json() as T
  }

  return {
    userId,

    listChats: () => getJson<ChatSummaryJson[]>(`${base}/chats`),

    /**
     * A page of a chat's history, oldest first: the newest messages, or with
     * `before` the ones just before that message id. `hasMore` says whether
     * older messages exist. A chat the server doesn't know yet (a new,
     * client-generated id) has no history: 404 → an empty page.
     */
    async loadHistory(chatId: string, before?: string): Promise<MessagePage> {
      const query = new URLSearchParams({ limit: String(HISTORY_LIMIT) })
      if (before !== undefined) query.set('before', before)

      try {
        return await getJson<MessagePage>(`${chatUrl(chatId)}?${query}`)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { messages: [], hasMore: false }
        throw error
      }
    },

    /**
     * One transport for every chat: `useChat` passes the chat id per request.
     * The server holds the history, so only the new message is sent (07, "Routes").
     */
    transport: new DefaultChatTransport<UIMessage>({
      api: `${base}/chats`,
      headers,
      fetch: fetchFn,
      prepareSendMessagesRequest: ({ id, messages }) => {
        const last = messages.at(-1)
        if (last?.role !== 'user') throw new Error('only new user messages can be sent; regenerating is not supported')

        return {
          api: chatUrl(id),
          body: {
            message: { id: last.id, role: 'user', parts: textParts(last) },
          },
        }
      },
    }),

    /** Chat ids are client-generated (07, "Chat ids"). */
    newChatId: () => crypto.randomUUID(),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

function textParts(message: UIMessage) {
  return message.parts.flatMap(part => part.type === 'text'
    ? [{ type: 'text' as const, text: part.text }]
    : []
  )
}

/**
 * A short, user-facing description of a failed turn. Errors before the stream
 * starts come from the transport as an `APICallError` with the API's `{ error }` body;
 * errors mid-stream arrive as plain errors with the server's message.
 */
export function describeChatError(error: Error): string {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 409) return 'The previous reply is still being saved. Try again in a moment.'

    const body = parseErrorBody(error.responseBody)
    return `The request failed (${error.statusCode ?? 'network'}): ${body ?? error.message}`
  }
  return `Something went wrong: ${error.message}`
}

function parseErrorBody(text: string | undefined): string | undefined {
  try {
    return (JSON.parse(text ?? '') as ErrorBody).error
  } catch {
    return undefined
  }
}
