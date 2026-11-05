import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'

import { createChatService } from '../../src/agent/chat-service.ts'
import { ChatNotFoundError, DEFAULT_USER_ID } from '../../src/store/chat-store.ts'
import { memorySink } from '../../src/observability/step-log.ts'
import { testShoppingTools } from '../helpers/fake-repository.ts'
import { generatedText, textReply, toolCallReply } from '../helpers/mock-model.ts'
import { memoryStore } from '../helpers/store.ts'
import { memories } from '../../src/store/schema.ts'

async function newService(chat: MockLanguageModelV4, summarizer = new MockLanguageModelV4({ doGenerate: generatedText('Lipstick shopping') })) {
  const store = await memoryStore()
  await store.ensureDefaultUser()

  const errors: unknown[] = []
  const service = createChatService({
    store,
    model: chat,
    summarizer,
    tools: testShoppingTools(),
    maxSteps: 3,
    stepTimeoutMs: 10_000,
    logSink: memorySink(),
    onBackgroundError: error => { errors.push(error) },
  }).forUser(DEFAULT_USER_ID)
  
  return { service, store, summarizer, errors }
}

describe('chat service', () => {
  it('stores a new chat only once its first turn succeeds', async () => {
    const model = new MockLanguageModelV4({ doStream: [textReply(['Hi!'])] })
    const { service } = await newService(model)

    const chat = service.newChat()
    expect(await service.listChats()).toEqual([])

    await (await chat.send('hello')).done
    await service.settled()

    const list = await service.listChats()
    expect(list.map(c => [c.id, c.firstText])).toEqual([[chat.chatId, 'hello']])
  })

  it('does not store a chat whose first turn fails', async () => {
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error('provider down') } })
    const { service, summarizer } = await newService(model)

    const chat = service.newChat()
    await expect((await chat.send('hello')).done).rejects.toThrow('provider down')
    await service.settled()

    expect(await service.listChats()).toEqual([])
    expect(summarizer.doGenerateCalls).toEqual([])
  })

  it('titles the chat after the first turn, once', async () => {
    const model = new MockLanguageModelV4({ doStream: [textReply(['Sure.']), textReply(['Here.'])] })
    const { service, summarizer } = await newService(model)

    const chat = service.newChat()
    await (await chat.send('show me lipstick')).done
    await (await chat.send('cheaper?')).done
    await service.settled()

    expect((await service.listChats())[0]!.title).toBe('Lipstick shopping')
    expect(summarizer.doGenerateCalls).toHaveLength(1)
    expect(JSON.stringify(summarizer.doGenerateCalls[0]!.prompt)).toContain('show me lipstick')
  })

  it('a failing title leaves the chat untitled and the turn intact', async () => {
    const model = new MockLanguageModelV4({ doStream: [textReply(['Hi!'])] })
    const summarizer = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('summarizer down') } })
    const { service, errors } = await newService(model, summarizer)

    const chat = service.newChat()
    await (await chat.send('hello')).done
    await service.settled()

    const [stored] = await service.listChats()
    expect(stored).toMatchObject({ title: null, firstText: 'hello' })
    expect(errors).toHaveLength(1)
    expect(chat.history).toHaveLength(2)
  })

  it('resumes a stored chat: history, tool results and new turns are kept', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallReply('findProducts', { request: 'smartphones' }),
        textReply(['Here are some phones.']),
        textReply(['The first one.']),
      ],
    })
    const { service, store } = await newService(model)

    const original = service.newChat()
    await (await original.send('show me smartphones')).done
    await service.settled()

    const resumed = await service.openChat(original.chatId)
    expect(resumed.history).toEqual(original.history)

    await (await resumed.send('which one is best?')).done
    const prompt = model.doStreamCalls[2]!.prompt
    expect(prompt.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])

    expect(await store.loadMessages(DEFAULT_USER_ID, original.chatId)).toHaveLength(4)
    expect(await service.listChats()).toHaveLength(1)
  })

  it('openChat rejects unknown chats', async () => {
    const { service } = await newService(new MockLanguageModelV4())
    await expect(service.openChat('nope')).rejects.toBeInstanceOf(ChatNotFoundError)
  })
})

describe('chat service: memory and recent window', () => {
  type Changes = { add?: Array<{ scope: 'lasting' | 'task', about: string, text: string }>, update?: Array<{ id: string, text: string }>, remove?: string[] }

  /** A memory model that answers each call with the next scripted change. */
  function memoryModel(script: Array<Changes | Error>, options: { gate?: Promise<void> } = {}) {
    let call = 0
    return new MockLanguageModelV4({
      doGenerate: async () => {
        const next = script[call++] ?? {}
        if (call === 1) await options.gate
        if (next instanceof Error) throw next
        return generatedText(JSON.stringify({ add: next.add ?? [], update: next.update ?? [], remove: next.remove ?? [] }))
      },
    })
  }

  async function newMemoryService(chat: MockLanguageModelV4, memory: MockLanguageModelV4, historyWindow?: number) {
    const store = await memoryStore()
    await store.ensureDefaultUser()

    const errors: Array<{ error: unknown, task: string }> = []
    const service = createChatService({
      store,
      model: chat,
      summarizer: new MockLanguageModelV4({ doGenerate: generatedText('A title') }),
      memoryModel: memory,
      instructions: memories => `be nice\n${memories.map(memory => `${memory.subject}: ${memory.text}`).join('\n')}`,
      tools: testShoppingTools(),
      historyWindow,
      maxSteps: 3,
      stepTimeoutMs: 10_000,
      logSink: memorySink(),
      onBackgroundError: (error, { task }) => { errors.push({ error, task }) },
    }).forUser(DEFAULT_USER_ID)

    return { service, store, errors }
  }

  const systemOf = (model: MockLanguageModelV4, call: number) => model.doStreamCalls[call]!.prompt.find(m => m.role === 'system')!.content

  it('remembers facts after a turn and uses them in later turns and other chats', async () => {
    const chat = new MockLanguageModelV4({ doStream: [textReply(['Noted.']), textReply(['Sure.']), textReply(['Here.'])] })
    const memory = memoryModel([
      { add: [{ scope: 'lasting', about: 'self', text: 'Is a man' }, { scope: 'task', about: 'wife', text: 'Gift for her birthday' }] },
    ])
    const { service, store } = await newMemoryService(chat, memory)

    const first = service.newChat()
    await (await first.send("I'm a guy looking for a gift for my wife's birthday")).done
    await service.settled()
    await (await first.send('something gold?')).done

    expect(systemOf(chat, 0)).toBe('be nice\n')
    expect(systemOf(chat, 1)).toBe('be nice\nself: Is a man\nwife: Gift for her birthday')

    const second = service.newChat()
    await (await second.send('hi')).done
    expect(systemOf(chat, 2)).toBe('be nice\nself: Is a man')

    await service.settled()
    expect(memory.doGenerateCalls).toHaveLength(3)
    const [stored] = await store.db.select().from(memories)
    expect(stored!.sourceMessageId).toBe(first.history[0]!.id)
  })

  it('runs the extractions of one chat in order, each seeing the previous changes', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const chat = new MockLanguageModelV4({ doStream: [textReply(['a']), textReply(['b'])] })
    const memory = memoryModel([
      { add: [{ scope: 'task', about: 'self', text: 'Budget $100' }] },
      { update: [{ id: 'm1', text: 'Budget $150' }] },
    ], { gate })
    const { service, store } = await newMemoryService(chat, memory)

    const session = service.newChat()
    await (await session.send('budget is 100')).done
    await (await session.send('make it 150')).done
    expect(memory.doGenerateCalls).toHaveLength(1)

    release()
    await service.settled()
    expect(JSON.stringify(memory.doGenerateCalls[1]!.prompt)).toContain('m1 (task, about: self) Budget $100')
    expect((await store.loadMemories(DEFAULT_USER_ID, session.chatId)).map(m => m.text)).toEqual(['Budget $150'])
  })

  it('a failed extraction is reported and leaves the turn intact', async () => {
    const chat = new MockLanguageModelV4({ doStream: [textReply(['Hi!'])] })
    const { service, errors } = await newMemoryService(chat, memoryModel([new Error('memory down')]))

    const session = service.newChat()
    await (await session.send('hello')).done
    await service.settled()

    expect(errors.map(e => e.task)).toEqual(['memory'])
    expect(session.history).toHaveLength(2)
    expect(await service.listChats()).toHaveLength(1)
  })

  it('resumes a chat with only its recent messages', async () => {
    const replies = Array.from({ length: 4 }, (_, i) => textReply([`reply ${i}`]))
    const chat = new MockLanguageModelV4({ doStream: replies })
    const { service } = await newMemoryService(chat, memoryModel([]), 4)

    const original = service.newChat()
    for (const text of ['one', 'two', 'three']) await (await original.send(text)).done
    await service.settled()

    const resumed = await service.openChat(original.chatId)
    expect(resumed.history.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(JSON.stringify(resumed.history[0])).toContain('two')

    await (await resumed.send('four')).done
    expect(chat.doStreamCalls[3]!.prompt.filter(m => m.role !== 'system').map(m => m.role)).toEqual(['user', 'assistant', 'user'])
  })
})
