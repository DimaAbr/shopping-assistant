import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'

import { ChatNotFoundError, DEFAULT_USER_ID } from '../../src/store/chat-store.ts'
import { users } from '../../src/store/schema.ts'
import { lipstick } from '../helpers/fake-repository.ts'
import { memoryStore } from '../helpers/store.ts'

const user = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const assistant = (id: string, text: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] })

async function storeWithUsers() {
  const store = await memoryStore()
  await store.ensureDefaultUser()
  await store.db.insert(users).values({ id: 'other', name: 'Other', createdAt: new Date() })
  return store
}

describe('chat store', () => {
  it('ensureDefaultUser is idempotent', async () => {
    const store = await memoryStore()
    expect(await store.ensureDefaultUser()).toBe(DEFAULT_USER_ID)
    expect(await store.ensureDefaultUser()).toBe(DEFAULT_USER_ID)
    expect(await store.db.select().from(users)).toHaveLength(1)
  })

  it('creates, appends and loads messages in order', async () => {
    const store = await storeWithUsers()
    await store.createChat(DEFAULT_USER_ID, { id: 'c1' })

    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('m1', 'hi'), assistant('m2', 'hello')])
    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('m3', 'lipstick?'), assistant('m4', 'sure')])

    const loaded = await store.loadMessages(DEFAULT_USER_ID, 'c1')
    expect(loaded.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(loaded[0]).toEqual(user('m1', 'hi'))
  })

  it('lists chats by latest activity, with title and first-message fallback', async () => {
    const store = await storeWithUsers()
    await store.createChat(DEFAULT_USER_ID, { id: 'old' })
    await store.createChat(DEFAULT_USER_ID, { id: 'new' })

    await store.appendMessages(DEFAULT_USER_ID, 'new', [user('n1', 'show me phones'), assistant('n2', 'ok')])
    await store.appendMessages(DEFAULT_USER_ID, 'old', [user('o1', 'a gift for my wife'), assistant('o2', 'ok')])

    await store.setTitle(DEFAULT_USER_ID, 'new', 'Phone shopping')

    const list = await store.listChats(DEFAULT_USER_ID)
    expect(list.map(c => [c.id, c.title, c.firstText])).toEqual([
      ['old', null, 'a gift for my wife'], // appended last → most recent
      ['new', 'Phone shopping', 'show me phones'],
    ])
    expect(list[0]!.updatedAt.getTime()).toBeGreaterThan(list[0]!.createdAt.getTime())
  })

  it('scopes every operation by user', async () => {
    const store = await storeWithUsers()
    await store.createChat(DEFAULT_USER_ID, { id: 'mine' })
    await store.appendMessages(DEFAULT_USER_ID, 'mine', [user('m1', 'secret')])

    expect(await store.listChats('other')).toEqual([])
    expect(await store.getChat('other', 'mine')).toBeUndefined()
    await expect(store.loadMessages('other', 'mine')).rejects.toBeInstanceOf(ChatNotFoundError)
    await expect(store.appendMessages('other', 'mine', [user('x', 'injected')])).rejects.toBeInstanceOf(ChatNotFoundError)

    await store.setTitle('other', 'mine', 'hijacked')
    expect((await store.getChat(DEFAULT_USER_ID, 'mine'))!.title).toBeNull()
    expect(await store.loadMessages(DEFAULT_USER_ID, 'mine')).toHaveLength(1)
  })

  it('a failed append writes nothing', async () => {
    const store = await storeWithUsers()
    await store.createChat(DEFAULT_USER_ID, { id: 'c1' })
    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('m1', 'hi')])

    // Duplicate id on the second message → the whole batch is rolled back.
    await expect(store.appendMessages(DEFAULT_USER_ID, 'c1', [user('m2', 'ok'), user('m1', 'dup')])).rejects.toThrow()
    expect((await store.loadMessages(DEFAULT_USER_ID, 'c1')).map(m => m.id)).toEqual(['m1'])
  })

  it('round-trips tool parts with the full raw output', async () => {
    const store = await storeWithUsers()
    await store.createChat(DEFAULT_USER_ID, { id: 'c1' })

    const withTool: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        {
          type: 'tool-searchProducts',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { query: 'lipstick' },
          output: { status: 'ok', total: lipstick.total, products: lipstick.products },
        },
        { type: 'text', text: 'Here you go.', state: 'done' },
      ],
    }
    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('u1', 'lipstick'), withTool])

    const [, loaded] = await store.loadMessages(DEFAULT_USER_ID, 'c1')
    expect(loaded).toEqual(withTool)
    expect(JSON.stringify(loaded)).toContain('thumbnail')
  })
})

describe('chat store: createIfMissing', () => {
  it('creates the chat together with its first messages', async () => {
    const store = await storeWithUsers()
    await store.appendMessages(DEFAULT_USER_ID, 'lazy', [user('m1', 'hi'), assistant('m2', 'hello')], { createIfMissing: true })

    expect((await store.listChats(DEFAULT_USER_ID)).map(c => [c.id, c.firstText])).toEqual([['lazy', 'hi']])
  })

  it("never creates or appends to another user's chat", async () => {
    const store = await storeWithUsers()
    await store.createChat('other', { id: 'theirs' })

    await expect(store.appendMessages(DEFAULT_USER_ID, 'theirs', [user('m1', 'hi')], { createIfMissing: true }))
      .rejects.toBeInstanceOf(ChatNotFoundError)
    expect(await store.loadMessages('other', 'theirs')).toEqual([])
  })

  it('leaves no chat behind when the first append fails', async () => {
    const store = await storeWithUsers()
    
    await expect(store.appendMessages(DEFAULT_USER_ID, 'lazy', [user('m1', 'a'), user('m1', 'dup')], { createIfMissing: true }))
      .rejects.toThrow()
    expect(await store.listChats(DEFAULT_USER_ID)).toEqual([])
  })
})
