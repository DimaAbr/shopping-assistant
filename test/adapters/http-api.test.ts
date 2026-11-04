import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { UIMessage } from 'ai'

import { createChatService } from '../../src/agent/chat-service.ts'
import { createShoppingTools, ShoppingToolResultSchema } from '../../src/agent/tools.ts'
import { createApi, MAX_PAGE_LIMIT, USER_ID_HEADER } from '../../src/adapters/http/app.ts'
import { ProductCardSchema } from '../../src/domain/product-card.ts'
import { DEFAULT_USER_ID } from '../../src/store/chat-store.ts'
import { memorySink } from '../../src/observability/step-log.ts'
import { categories, createFakeRepository } from '../helpers/fake-repository.ts'
import { gatedTextReply, generatedText, textReply, toolCallReply } from '../helpers/mock-model.ts'
import { memoryStore } from '../helpers/store.ts'

type Reply = ReturnType<typeof textReply>

async function newApi(replies: Reply[]) {
  const store = await memoryStore()
  await store.ensureDefaultUser()

  const service = createChatService({
    store,
    model: new MockLanguageModelV4({ doStream: replies }),
    summarizer: new MockLanguageModelV4({ doGenerate: generatedText('Lipstick shopping') }),
    tools: createShoppingTools(createFakeRepository(), categories),
    maxSteps: 3,
    logSink: memorySink(),
  })

  const turnErrors: unknown[] = []
  const api = createApi({ service, defaultUserId: DEFAULT_USER_ID, onTurnError: error => { turnErrors.push(error) } })

  async function settled() {
    await api.settled()
    await service.settled()
  }

  return { app: api.app, store, settled, turnErrors }
}

function send(app: ReturnType<typeof createApi>['app'], chatId: string, body: unknown, userId?: string) {
  return app.request(`/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...asUser(userId) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const asUser = (userId?: string): Record<string, string> => userId === undefined ? {} : { [USER_ID_HEADER]: userId }

const userMessage = (text: string) => ({ message: { id: 'client-1', role: 'user', parts: [{ type: 'text', text }] } })

/** The JSON chunks of a UI message stream (SSE), without the final `[DONE]`. */
async function chunksOf(response: Response): Promise<Array<{ type: string, [key: string]: unknown }>> {
  return (await response.text())
    .split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice('data: '.length)))
}

const lipstickTurn = () => [toolCallReply('searchProducts', { query: 'lipstick' }), textReply(['Red Lipstick — $12.99'])]

describe('POST /chats/:id/messages', () => {
  it('streams the turn, with product cards in the tool output', async () => {
    const { app, settled } = await newApi(lipstickTurn())

    const response = await send(app, 'chat-1', userMessage('show me lipstick'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const chunks = await chunksOf(response)
    const output = chunks.find(chunk => chunk.type === 'tool-output-available')?.output

    const result = ShoppingToolResultSchema.parse(output)
    expect(result.status).toBe('ok')

    const [card] = result.status === 'ok' ? result.products : []
    expect(ProductCardSchema.parse(card)).toMatchObject({ title: 'Red Lipstick', price: 12.99, currency: 'USD' })
    expect(card!.imageUrl).toMatch(/^https:\/\/cdn\.dummyjson\.com\//)
    expect(card!.description.length).toBeGreaterThan(100)   // sent whole

    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta).join('')).toBe('Red Lipstick — $12.99')
    expect(chunks.at(-1)?.type).toBe('finish')
    await settled()
  })

  it('stores the chat under the client id, and GET /chats lists it', async () => {
    const { app, settled } = await newApi(lipstickTurn())

    await (await send(app, 'chat-1', userMessage('show me lipstick'))).text()
    await settled()

    const list = await (await app.request('/chats')).json() as Array<{ id: string, title: string, firstText: string }>
    expect(list).toMatchObject([{ id: 'chat-1', title: 'Lipstick shopping', firstText: 'show me lipstick' }])
  })

  it('continues an existing chat', async () => {
    const { app, store, settled } = await newApi([textReply(['Hi!']), textReply(['Still here.'])])

    await (await send(app, 'chat-1', userMessage('hello'))).text()
    await settled()
    await (await send(app, 'chat-1', userMessage('are you there?'))).text()
    await settled()

    const messages = await store.loadMessages(DEFAULT_USER_ID, 'chat-1')
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('rejects a second turn while one is running (409), and accepts it afterwards', async () => {
    const gated = gatedTextReply('Hel', 'lo')
    const { app, settled } = await newApi([gated.reply, textReply(['Next.'])])

    const first = await send(app, 'chat-1', userMessage('hello'))
    const busy = await send(app, 'chat-1', userMessage('again'))
    expect(busy.status).toBe(409)
    expect(await busy.json()).toEqual({ error: expect.stringContaining('in progress') })

    gated.release()
    await first.text()
    await settled()

    expect((await send(app, 'chat-1', userMessage('again'))).status).toBe(200)
    await settled()
  })

  it('still finishes and saves the turn when the client disconnects mid-stream', async () => {
    const gated = gatedTextReply('Hel', 'lo, the rest of the reply')
    const { app, store, settled } = await newApi([gated.reply])

    const response = await send(app, 'chat-1', userMessage('hello'))
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()   // the client goes away
    gated.release()

    await vi.waitFor(async () => {
      const messages = await store.loadMessages(DEFAULT_USER_ID, 'chat-1')
      expect(messages).toHaveLength(2)
    })
    const [, reply] = await store.loadMessages(DEFAULT_USER_ID, 'chat-1')
    expect(JSON.stringify(reply!.parts)).toContain('Hello, the rest of the reply')
    await settled()
  })

  it('reports a failed turn through onTurnError and stores nothing', async () => {
    const { app, store, settled, turnErrors } = await newApi([])
    // No scripted replies left: the model call throws.

    const response = await send(app, 'chat-1', userMessage('hello'))
    const chunks = await chunksOf(response)
    await settled()

    expect(chunks.map(chunk => chunk.type)).toContain('error')
    expect(turnErrors).toHaveLength(1)
    expect(await store.listChats(DEFAULT_USER_ID)).toEqual([])
  })

  it.each([
    ['not JSON',         '{'],
    ['no message',       {}],
    ['assistant role',   { message: { role: 'assistant', parts: [{ type: 'text', text: 'hi' }] } }],
    ['no parts',         { message: { role: 'user', parts: [] } }],
    ['blank text',       userMessage('   ')],
    ['non-text part',    { message: { role: 'user', parts: [{ type: 'file', url: 'x', mediaType: 'image/png' }] } }],
  ])('rejects a bad body (%s) with 400', async (_, body) => {
    const { app } = await newApi([])
    const response = await send(app, 'chat-1', body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: expect.any(String) })
  })

  it('rejects a malformed chat id with 400', async () => {
    const { app } = await newApi([])
    expect((await send(app, 'bad%20id', userMessage('hi'))).status).toBe(400)
    expect((await send(app, 'x'.repeat(65), userMessage('hi'))).status).toBe(400)
  })
})

describe('GET /chats/:id/messages', () => {
  async function apiWithTwoTurns() {
    const ctx = await newApi([...lipstickTurn(), textReply(['It is $12.99.'])])
    await (await send(ctx.app, 'chat-1', userMessage('show me lipstick'))).text()
    await ctx.settled()
    await (await send(ctx.app, 'chat-1', userMessage('how much is it?'))).text()
    await ctx.settled()
    return ctx
  }

  type Page = { messages: UIMessage[], hasMore: boolean }

  it('returns history with the same product cards as the live stream', async () => {
    const { app } = await apiWithTwoTurns()

    const page = await (await app.request('/chats/chat-1/messages')).json() as Page
    expect(page.hasMore).toBe(false)
    expect(page.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])

    const toolPart = page.messages[1]!.parts.find(part => part.type === 'tool-searchProducts') as { output: unknown }
    const result = ShoppingToolResultSchema.parse(toolPart.output)
    expect(result.status === 'ok' && result.products.map(p => ProductCardSchema.parse(p).title)).toEqual(['Red Lipstick'])
  })

  it('pages backwards with before and limit', async () => {
    const { app } = await apiWithTwoTurns()

    const newest = await (await app.request('/chats/chat-1/messages?limit=2')).json() as Page
    expect(newest.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(newest.hasMore).toBe(true)

    const older = await (await app.request(`/chats/chat-1/messages?limit=2&before=${newest.messages[0]!.id}`)).json() as Page
    expect(older.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(older.hasMore).toBe(false)
    expect(older.messages[0]!.parts).toEqual([{ type: 'text', text: 'show me lipstick' }])
  })

  it('answers 404 for an unknown chat or `before` id', async () => {
    const { app } = await apiWithTwoTurns()
    expect((await app.request('/chats/nope/messages')).status).toBe(404)
    expect((await app.request('/chats/chat-1/messages?before=nope')).status).toBe(404)
  })

  it('rejects out-of-range limits with 400', async () => {
    const { app } = await newApi([])
    expect((await app.request(`/chats/chat-1/messages?limit=${MAX_PAGE_LIMIT + 1}`)).status).toBe(400)
    expect((await app.request('/chats/chat-1/messages?limit=0')).status).toBe(400)
  })
})

describe('identity (X-User-Id)', () => {
  it('creates a new user with their first chat, and scopes their list to them', async () => {
    const { app, store, settled } = await newApi([textReply(['Hi anon!']), textReply(['Hi default!'])])

    await (await send(app, 'anon-chat', userMessage('hello'), 'anon-123')).text()
    await settled()
    await (await send(app, 'default-chat', userMessage('hello'))).text()
    await settled()

    const ids = async (userId?: string) =>
      (await (await app.request('/chats', { headers: asUser(userId) })).json() as Array<{ id: string }>).map(chat => chat.id)

    expect(await ids('anon-123')).toEqual(['anon-chat'])
    expect(await ids()).toEqual(['default-chat'])   // no header: the default user
    expect(await ids('someone-else')).toEqual([])
    expect(await store.loadMessages('anon-123', 'anon-chat')).toHaveLength(2)
  })

  it("hides another user's chat: history is 404 and a POST to its id is not saved", async () => {
    const { app, store, settled, turnErrors } = await newApi([textReply(['Hi!']), textReply(['Intruder reply'])])

    await (await send(app, 'chat-a', userMessage('hello'), 'user-a')).text()
    await settled()

    expect((await app.request('/chats/chat-a/messages', { headers: asUser('user-b') })).status).toBe(404)

    await (await send(app, 'chat-a', userMessage('let me in'), 'user-b')).text()
    await settled()

    expect(turnErrors).toHaveLength(1)
    expect(await store.loadMessages('user-a', 'chat-a')).toHaveLength(2)
  })

  it('rejects a malformed user id with 400', async () => {
    const { app } = await newApi([])
    const response = await app.request('/chats', { headers: asUser('not a valid id!') })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: expect.stringContaining('user id') })
  })
})

describe('routing', () => {
  it('answers JSON 404 for unknown routes', async () => {
    const { app } = await newApi([])
    const response = await app.request('/nope')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not found' })
  })
})
