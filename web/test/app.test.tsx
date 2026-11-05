import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UIMessage } from 'ai'

import { ShoppingProvider } from '../src/core/index.ts'
import { App } from '../src/ui/App.tsx'

/**
 * The whole page against a fake API: the seam between our core (`useChat` +
 * history) and assistant-ui's primitives, including tool parts → product tiles.
 */

beforeAll(() => {
  // jsdom lacks these; assistant-ui's viewport uses them for autoscroll.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  globalThis.MutationObserver ??= class { observe() {} disconnect() {} takeRecords() { return [] } } as unknown as typeof MutationObserver
  Element.prototype.scrollTo ??= function () {}
})

afterEach(() => {
  cleanup()
  location.hash = ''
})

/** A stored chat, shaped like `GET /chats/:id/messages` returns it. */
const history: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'show me lipstick' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'step-start' },
      {
        type: 'tool-findProducts',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { request: 'lipstick' },
        output: {
          status: 'ok',
          groups: [{
            label: 'Lipstick',
            products: [{ id: 1, title: 'Red Lipstick', description: 'A classic bold red.', price: 12.99, currency: 'USD', imageUrl: 'https://cdn.dummyjson.com/x.png', category: 'beauty', rating: 4.5 }],
          }],
          unmet: [],
        },
      },
      { type: 'step-start' },
      { type: 'text', text: 'Here is a **red lipstick** for $12.99.', state: 'done' },
    ],
  },
]

const text = (id: string, role: 'user' | 'assistant', value: string): UIMessage => ({ id, role, parts: [{ type: 'text', text: value }] })
const older: UIMessage[] = [text('u1', 'user', 'first question'), text('a1', 'assistant', 'first answer')]
const newer: UIMessage[] = [text('u2', 'user', 'second question'), text('a2', 'assistant', 'second answer')]

/** A reply stream that starts and never finishes: a turn still in progress. */
const hangingReply = () => new Response(
  new ReadableStream({ start: controller => controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n')) }),
  { headers: { 'content-type': 'text/event-stream' } },
)

function fakeApi(posts: string[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

    if (init?.method === 'POST') {
      posts.push(url)
      return hangingReply()
    }

    if (url === '/api/chats')
      return reply([{ id: 'chat-1', title: 'Lipstick shopping', firstText: 'show me lipstick', createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z' }])
    if (url.startsWith('/api/chats/chat-1/messages'))
      return reply({ messages: history, hasMore: false })
    // A longer chat in two pages: the newest one, then the one before `u2`.
    if (url.startsWith('/api/chats/chat-2/messages'))
      return reply(url.includes('before=u2') ? { messages: older, hasMore: false } : { messages: newer, hasMore: true })
    return reply({ error: 'chat not found' }, 404)
  }) as typeof fetch
}

const renderApp = (posts?: string[]) =>
  render(
    <ShoppingProvider config={{ apiBaseUrl: '/api', identity: { userId: 'u' }, fetch: fakeApi(posts) }}>
      <App />
    </ShoppingProvider>,
  )

describe('app', () => {
  it('reopens the chat in the URL with its history, tiles and markdown', async () => {
    location.hash = '#chat-1'
    renderApp()

    expect(await screen.findByRole('heading', { name: 'Red Lipstick' })).toBeTruthy()
    expect(screen.getByText('show me lipstick', { selector: 'main *' })).toBeTruthy()
    expect(screen.getByText('red lipstick', { selector: 'strong' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Lipstick shopping' }).getAttribute('aria-current')).toBe('page')
  })

  it('starts a new, empty chat without a hash', async () => {
    renderApp()

    expect(await screen.findByText('What are you shopping for?')).toBeTruthy()
    expect(location.hash).toMatch(/^#[0-9a-f-]{36}$/)
  })

  it('loads earlier history pages on demand', async () => {
    location.hash = '#chat-2'
    renderApp()

    const button = await screen.findByRole('button', { name: 'Load earlier messages' })
    expect(screen.getByText('second question', { selector: 'main *' })).toBeTruthy()
    expect(screen.queryByText('first question', { selector: 'main *' })).toBeNull()

    fireEvent.click(button)

    expect(await screen.findByText('first question', { selector: 'main *' })).toBeTruthy()
    expect(screen.getByText('second question', { selector: 'main *' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull()
  })

  it('swallows Enter while a reply is streaming, instead of adding a newline', async () => {
    const posts: string[] = []
    renderApp(posts)
    const input = await screen.findByPlaceholderText('Ask about products…')

    fireEvent.change(input, { target: { value: 'shorts' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Send is disabled while the reply streams.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true))

    fireEvent.change(input, { target: { value: 'hello?' } })
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter' })

    expect(notPrevented).toBe(false)
    expect(posts).toHaveLength(1)
  })

  it('opens the chat list from the menu button and closes it on select', async () => {
    renderApp()
    const menu = screen.getByRole('button', { name: 'Chats' })
    expect(menu.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(menu)
    expect(menu.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(await screen.findByRole('button', { name: 'Lipstick shopping' }))
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    expect(location.hash).toBe('#chat-1')
  })
})
