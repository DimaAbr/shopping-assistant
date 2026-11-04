import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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

function fakeApi() {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

    if (url === '/api/chats')
      return reply([{ id: 'chat-1', title: 'Lipstick shopping', firstText: 'show me lipstick', createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z' }])
    if (url.startsWith('/api/chats/chat-1/messages'))
      return reply({ messages: history, hasMore: false })
    return reply({ error: 'chat not found' }, 404)
  }) as typeof fetch
}

const renderApp = () =>
  render(
    <ShoppingProvider config={{ apiBaseUrl: '/api', identity: { userId: 'u' }, fetch: fakeApi() }}>
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
})
