import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'

import { createChatService } from '../../src/agent/chat-service.ts'
import { createShoppingTools } from '../../src/agent/tools.ts'
import { ChatNotFoundError, DEFAULT_USER_ID } from '../../src/store/chat-store.ts'
import { memorySink } from '../../src/observability/step-log.ts'
import { categories, createFakeRepository } from '../helpers/fake-repository.ts'
import { generatedText, textReply, toolCallReply } from '../helpers/mock-model.ts'
import { memoryStore } from '../helpers/store.ts'

async function newService(chat: MockLanguageModelV4, summarizer = new MockLanguageModelV4({ doGenerate: generatedText('Lipstick shopping') })) {
  const store = await memoryStore()
  await store.ensureDefaultUser()

  const errors: unknown[] = []
  const service = createChatService({
    store,
    model: chat,
    summarizer,
    tools: createShoppingTools(createFakeRepository(), categories),
    maxSteps: 3,
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
        toolCallReply('browseCategory', { category: 'smartphones' }),
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
