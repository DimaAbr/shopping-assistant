import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'

import { ANONYMOUS_ID_KEY, createApiClient, describeChatError, resolveUserId } from '../src/core/index.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))

  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
  }
}

type Call = { url: string, init: RequestInit | undefined }

/** A fake `fetch` that records calls and answers with `respond`. */
function fakeFetch(respond: (url: string) => Response) {
  const calls: Call[] = []

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return respond(url)
  }) as typeof globalThis.fetch

  return { fetch, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const sse = (...chunks: object[]) =>
  new Response([...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })

const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name)

describe('resolveUserId', () => {
  it("uses the host's user when one is given, and stores nothing", () => {
    const storage = memoryStorage()
    expect(resolveUserId({ identity: { userId: 'host-user-7' }, storage })).toBe('host-user-7')
    expect(storage.items.size).toBe(0)
  })

  it('reuses a stored anonymous id', () => {
    const storage = memoryStorage({ [ANONYMOUS_ID_KEY]: 'anon-abc' })
    expect(resolveUserId({ storage })).toBe('anon-abc')
  })

  it('creates and stores an anonymous id the server accepts', () => {
    const storage = memoryStorage()
    const id = resolveUserId({ storage })

    expect(id).toMatch(/^anon-[A-Za-z0-9-]+$/)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(storage.items.get(ANONYMOUS_ID_KEY)).toBe(id)
    expect(resolveUserId({ storage })).toBe(id)
  })
})

describe('api client', () => {
  const config = (fetch: typeof globalThis.fetch) =>
    ({ apiBaseUrl: '/api/', identity: { userId: 'user-1' }, fetch })

  it('lists chats as the user', async () => {
    const { fetch, calls } = fakeFetch(() => json([]))
    await createApiClient(config(fetch)).listChats()

    expect(calls[0]!.url).toBe('/api/chats')
    expect(header(calls[0]!.init, 'x-user-id')).toBe('user-1')
  })

  it('loads history, and treats an unknown (new) chat as empty', async () => {
    const stored: UIMessage[] = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
    const { fetch, calls } = fakeFetch(url => url.includes('/known/') ? json({ messages: stored, hasMore: false }) : json({ error: 'chat not found' }, 404))
    const client = createApiClient(config(fetch))

    expect(await client.loadHistory('known')).toEqual(stored)
    expect(await client.loadHistory('new-chat')).toEqual([])
    expect(calls[0]!.url).toBe('/api/chats/known/messages?limit=200')
  })

  it('throws other API errors with their message', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'internal error' }, 500))
    await expect(createApiClient(config(fetch)).loadHistory('c1')).rejects.toMatchObject({ status: 500, message: 'internal error' })
  })

  it("sends only the new user message to the chat's URL, with the user header", async () => {
    const { fetch, calls } = fakeFetch(() => sse({ type: 'start' }, { type: 'finish' }))
    const client = createApiClient(config(fetch))
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'show me lipstick' }] },
    ]

    await client.transport.sendMessages({ chatId: 'chat-9', messages, trigger: 'submit-message', messageId: undefined, abortSignal: undefined })

    expect(calls[0]!.url).toBe('/api/chats/chat-9/messages')
    expect(header(calls[0]!.init, 'x-user-id')).toBe('user-1')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      message: { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'show me lipstick' }] },
    })
  })
})

describe('describeChatError', () => {
  it('explains a busy chat (409) and passes other API messages through', async () => {
    const busy = fakeFetch(() => json({ error: 'a reply for this chat is still in progress' }, 409))
    const failing = fakeFetch(() => json({ error: 'body: message text is empty' }, 400))
    const send = (fetch: typeof globalThis.fetch) => createApiClient({ apiBaseUrl: '/api', identity: { userId: 'u' }, fetch })
      .transport
      .sendMessages({
        chatId: 'c',
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }] }],
        trigger: 'submit-message',
        messageId: undefined,
        abortSignal: undefined,
      })
      .then(
        () => { throw new Error('expected a failure') },
        (error: Error) => error
      )

    expect(describeChatError(await send(busy.fetch))).toContain('still being saved')
    expect(describeChatError(await send(failing.fetch))).toBe('The request failed (400): body: message text is empty')
  })
})
