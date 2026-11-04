import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'

import { parseCommand, resolveChatRef } from '../../src/adapters/cli/commands.ts'
import { formatChatList, formatReplay, relativeTime } from '../../src/adapters/cli/render.ts'
import type { ChatSummary } from '../../src/store/chat-store.ts'

const at = (iso: string) => new Date(iso)
const chat = (id: string, title: string | null, firstText: string | null = 'hi'): ChatSummary => ({
  id,
  title,
  firstText,
  createdAt: at('2026-11-04T10:00:00Z'),
  updatedAt: at('2026-11-04T11:55:00Z'),
})

describe('parseCommand', () => {
  it.each([
    ['',                   { kind: 'empty' }],
    ['   ',                { kind: 'empty' }],
    ['show me lipstick',   { kind: 'message', text: 'show me lipstick' }],
    ['  padded  ',         { kind: 'message', text: 'padded' }],
    ['/exit',              { kind: 'exit' }],
    ['/QUIT',              { kind: 'exit' }],
    ['/help',              { kind: 'help' }],
    ['/new',               { kind: 'new' }],
    ['/sessions',          { kind: 'sessions' }],
    ['/sessions 2',        { kind: 'switch', ref: '2' }],
    ['/sessions  ab12 ',   { kind: 'switch', ref: 'ab12' }],
    ['/foo bar',           { kind: 'unknown', name: 'foo' }],
    ['/ not a command',    { kind: 'message', text: '/ not a command' }],
    ['/50% off?',          { kind: 'message', text: '/50% off?' }],
  ])('%j', (input, expected) => {
    expect(parseCommand(input)).toEqual(expected)
  })
})

describe('resolveChatRef', () => {
  const chats = [chat('abc123', 'One'), chat('abd456', 'Two'), chat('xyz789', 'Three')]

  it('by 1-based number', () => {
    expect(resolveChatRef('2', chats)).toBe(chats[1])
    expect(resolveChatRef('4', chats)).toEqual({ error: 'no chat #4 — there are 3 chats' })
    expect(resolveChatRef('0', chats)).toHaveProperty('error')
  })

  it('by unique id prefix', () => {
    expect(resolveChatRef('xy', chats)).toBe(chats[2])
    expect(resolveChatRef('abc', chats)).toBe(chats[0])
    expect(resolveChatRef('ab', chats)).toEqual({ error: '2 chats start with ab — use more characters or the number' })
    expect(resolveChatRef('q', chats)).toEqual({ error: 'no chat with id q…' })
  })
})

describe('render', () => {
  const strip = (text: string) => text.replace(/\x1b\[\d+m/g, '')

  it('lists chats with the current one marked and a first-message fallback', () => {
    const list = strip(
      formatChatList([chat('abc12345xx', 'Phones'), chat('def67890yy', null, 'a gift for my wife')],
      'def67890yy',
      at('2026-11-04T12:00:00Z')
    ))

    expect(list.split('\n')).toEqual([
      '  1. Phones  5 min ago · abc12345',
      '* 2. a gift for my wife  5 min ago · def67890',
    ])
  })

  it('replays text and tool calls', () => {
    const messages: UIMessage[] = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'lipstick?' }] },
      {
        id: 'a',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-searchProducts',
            toolCallId: 'c',
            state: 'output-available',
            input: { query: 'lipstick' },
            output: { status: 'ok', total: 1, products: [{ id: 7 }] }
          },
          { type: 'step-start' },
          { type: 'text', text: 'Red Lipstick — $12.99', state: 'done' },
        ]
      },
    ]
    expect(strip(formatReplay(messages)))
      .toBe('you> lipstick?\nassistant> · searchProducts {"query":"lipstick"} → 1 of 1: #7\nRed Lipstick — $12.99')
  })

  it('relative times', () => {
    const now = at('2026-11-04T12:00:00Z')
    
    expect(relativeTime(at('2026-11-04T11:59:30Z'), now)).toBe('just now')
    expect(relativeTime(at('2026-11-04T09:00:00Z'), now)).toBe('3 h ago')
    expect(relativeTime(at('2026-11-01T12:00:00Z'), now)).toBe('3 d ago')
    expect(relativeTime(at('2026-10-01T12:00:00Z'), now)).toBe('2026-10-01')
  })
})
