import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'

import { ChatNotFoundError, DEFAULT_USER_ID } from '../../src/store/chat-store.ts'
import { users } from '../../src/store/schema.ts'
import { lipstickListings } from '../helpers/fake-repository.ts'
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

  it('creates an unknown user together with their first chat', async () => {
    const store = await memoryStore()
    await store.appendMessages('anon-1', 'c1', [user('u1', 'hi'), assistant('a1', 'hello')], { createIfMissing: true })

    expect(await store.db.select({ id: users.id }).from(users)).toEqual([{ id: 'anon-1' }])
    expect(await store.loadMessages('anon-1', 'c1')).toHaveLength(2)
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
          type: 'tool-findProducts',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { request: 'lipstick' },
          output: { status: 'ok', groups: [{ label: 'Lipstick', products: lipstickListings }], unmet: [] },
        },
        { type: 'text', text: 'Here you go.', state: 'done' },
      ],
    }
    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('u1', 'lipstick'), withTool])

    const [, loaded] = await store.loadMessages(DEFAULT_USER_ID, 'c1')
    expect(loaded).toEqual(withTool)
    expect(JSON.stringify(loaded)).toContain('imageUrl')
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

describe('chat store: loadMessagesPage', () => {
  async function storeWithSixMessages() {
    const store = await storeWithUsers()
    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('m1', '1'), assistant('m2', '2')], { createIfMissing: true })
    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('m3', '3'), assistant('m4', '4')])
    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('m5', '5'), assistant('m6', '6')])
    return store
  }

  const ids = (page: { messages: UIMessage[] }) => page.messages.map(m => m.id)

  it('returns the newest messages in chronological order', async () => {
    const store = await storeWithSixMessages()

    const page = await store.loadMessagesPage(DEFAULT_USER_ID, 'c1', { limit: 4 })
    expect(ids(page)).toEqual(['m3', 'm4', 'm5', 'm6'])
    expect(page.hasMore).toBe(true)
  })

  it('pages backwards with `before`', async () => {
    const store = await storeWithSixMessages()

    const page = await store.loadMessagesPage(DEFAULT_USER_ID, 'c1', { before: 'm3', limit: 4 })
    expect(ids(page)).toEqual(['m1', 'm2'])
    expect(page.hasMore).toBe(false)
  })

  it('reports no more pages when the limit exactly covers the rest', async () => {
    const store = await storeWithSixMessages()

    const page = await store.loadMessagesPage(DEFAULT_USER_ID, 'c1', { limit: 6 })
    expect(ids(page)).toHaveLength(6)
    expect(page.hasMore).toBe(false)
  })

  it("scopes by user and rejects a `before` id that isn't in the chat", async () => {
    const store = await storeWithSixMessages()
    await store.appendMessages('other', 'c2', [user('x1', 'x')], { createIfMissing: true })

    await expect(store.loadMessagesPage('other', 'c1', { limit: 10 })).rejects.toBeInstanceOf(ChatNotFoundError)
    await expect(store.loadMessagesPage(DEFAULT_USER_ID, 'c1', { before: 'x1', limit: 10 })).rejects.toBeInstanceOf(ChatNotFoundError)
  })
})

describe('chat store: countTurns', () => {
  it('counts user messages, scoped by user', async () => {
    const store = await storeWithUsers()
    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('u1', 'hi'), assistant('a1', 'hello')], { createIfMissing: true })
    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('u2', 'lipstick?'), assistant('a2', 'sure')])

    expect(await store.countTurns(DEFAULT_USER_ID, 'c1')).toBe(2)
    await expect(store.countTurns('other', 'c1')).rejects.toBeInstanceOf(ChatNotFoundError)
  })
})

describe('chat store: memories', () => {
  async function storeWithChats() {
    const store = await storeWithUsers()
    await store.appendMessages(DEFAULT_USER_ID, 'c1', [user('u1', 'hi'), assistant('a1', 'hello')], { createIfMissing: true })
    await store.appendMessages(DEFAULT_USER_ID, 'c2', [user('u2', 'hi'), assistant('a2', 'hello')], { createIfMissing: true })
    await store.appendMessages('other', 'o1', [user('u3', 'hi'), assistant('a3', 'hello')], { createIfMissing: true })
    return store
  }

  const texts = (memories: Array<{ text: string }>) => memories.map(memory => memory.text)

  it('adds lasting memories to every chat of the user, and task memories to one chat', async () => {
    const store = await storeWithChats()
    await store.applyMemoryOps(DEFAULT_USER_ID, 'c1', [
      { op: 'add', scope: 'chat', subject: 'wife', text: 'Birthday gift, budget $100' },
      { op: 'add', scope: 'user', subject: 'self', text: 'Is a man' },
    ], { sourceMessageId: 'u1' })

    expect(await store.loadMemories(DEFAULT_USER_ID, 'c1')).toMatchObject([
      { scope: 'user', subject: 'self', text: 'Is a man' },
      { scope: 'chat', subject: 'wife', text: 'Birthday gift, budget $100' },
    ])
    expect(texts(await store.loadMemories(DEFAULT_USER_ID, 'c2'))).toEqual(['Is a man'])
    expect(texts(await store.loadMemories(DEFAULT_USER_ID, 'not-stored-yet'))).toEqual(['Is a man'])
    expect(await store.loadMemories('other', 'o1')).toEqual([])
  })

  it('updates and removes memories', async () => {
    const store = await storeWithChats()
    await store.applyMemoryOps(DEFAULT_USER_ID, 'c1', [
      { op: 'add', scope: 'user', subject: 'self', text: 'Shoe size 42' },
      { op: 'add', scope: 'chat', subject: 'self', text: 'Wants running shoes' },
    ])
    const [size, task] = await store.loadMemories(DEFAULT_USER_ID, 'c1')

    await store.applyMemoryOps(DEFAULT_USER_ID, 'c1', [
      { op: 'update', id: size!.id, text: 'Shoe size 43' },
      { op: 'remove', id: task!.id },
    ])
    expect(await store.loadMemories(DEFAULT_USER_ID, 'c1')).toEqual([{ id: size!.id, scope: 'user', subject: 'self', text: 'Shoe size 43' }])
  })

  it("never changes another user's memories or another chat's task memories", async () => {
    const store = await storeWithChats()
    await store.applyMemoryOps('other', 'o1', [{ op: 'add', scope: 'user', subject: 'self', text: 'Theirs' }])
    await store.applyMemoryOps(DEFAULT_USER_ID, 'c2', [{ op: 'add', scope: 'chat', subject: 'self', text: 'Chat 2 task' }])
    const [theirs] = await store.loadMemories('other', 'o1')
    const [chat2] = await store.loadMemories(DEFAULT_USER_ID, 'c2')

    await store.applyMemoryOps(DEFAULT_USER_ID, 'c1', [
      { op: 'update', id: theirs!.id, text: 'changed' },
      { op: 'remove', id: chat2!.id },
    ])
    expect(texts(await store.loadMemories('other', 'o1'))).toEqual(['Theirs'])
    expect(texts(await store.loadMemories(DEFAULT_USER_ID, 'c2'))).toEqual(['Chat 2 task'])

    await expect(store.applyMemoryOps(DEFAULT_USER_ID, 'o1', [{ op: 'add', scope: 'user', subject: 'self', text: 'x' }]))
      .rejects.toBeInstanceOf(ChatNotFoundError)
  })
})
