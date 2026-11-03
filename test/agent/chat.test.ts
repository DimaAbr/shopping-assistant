import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'

import { createChatSession } from '../../src/agent/chat.ts'
import { createShoppingTools } from '../../src/agent/tools.ts'
import { memorySink } from '../../src/observability/step-log.ts'
import { categories, createFakeRepository, unavailable } from '../helpers/fake-repository.ts'
import { collect, textReply, toolCallReply } from '../helpers/mock-model.ts'

function newSession(model: MockLanguageModelV4) {
  const sink = memorySink()
  const session = createChatSession({
    model,
    chatId:       'chat-1',
    instructions: 'be nice',
    maxSteps:     3,
    logSink:      sink,
  })
  return { session, sink }
}

describe('chat session', () => {
  it('streams the reply text chunk by chunk', async () => {
    const model = new MockLanguageModelV4({ doStream: [textReply(['Hel', 'lo', '!'])] })
    const { session } = newSession(model)

    const turn = session.send('hi')
    expect(await collect(turn.textStream)).toBe('Hello!')
    await turn.done
  })

  it('keeps history across turns', async () => {
    const model = new MockLanguageModelV4({
      doStream: [textReply(['Nice to meet you, Dima.']), textReply(['Your name is Dima.'])],
    })
    const { session } = newSession(model)

    for (const text of ['my name is Dima', 'what is my name?']) {
      const turn = session.send(text)
      await collect(turn.textStream)
      await turn.done
    }

    // The second model call must see turn 1 (user + assistant) before the new user message.
    const prompt = model.doStreamCalls[1]!.prompt
    expect(prompt.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(JSON.stringify(prompt[2])).toContain('Nice to meet you, Dima.')

    expect(session.history.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('logs one record per step with usage and finish reason', async () => {
    const model = new MockLanguageModelV4({ doStream: [textReply(['ok'], { input: 12, output: 3 })] })
    const { session, sink } = newSession(model)

    const turn = session.send('hi')
    await collect(turn.textStream)
    await turn.done

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({
      chatId:          'chat-1',
      turn:            1,
      step:            0,
      finishReason:    'stop',
      usage:           { input: 12, output: 3, total: 15 },
      toolCalls:       [],
      toolResultBytes: 0,
    })
    expect(sink.records[0]!.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('rejects `done` and rolls back history when the model errors', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => { throw new Error('provider down') },
    })
    const { session } = newSession(model)

    const turn = session.send('hi')
    await collect(turn.textStream)
    await expect(turn.done).rejects.toThrow('provider down')
    expect(session.history).toEqual([])
  })
})

describe('chat session with shopping tools', () => {
  function newToolSession(model: MockLanguageModelV4, options: { maxSteps?: number, repo?: ReturnType<typeof createFakeRepository> } = {}) {
    const repo = options.repo ?? createFakeRepository()
    const sink = memorySink()
    const session = createChatSession({
      model,
      chatId:       'chat-1',
      instructions: 'be nice',
      tools:        createShoppingTools(repo, categories),
      maxSteps:     options.maxSteps ?? 3,
      logSink:      sink,
    })
    return { session, sink, repo }
  }

  async function runTurn(session: { send(text: string): { textStream: AsyncIterable<string>, done: Promise<void> } }, text: string) {
    const turn = session.send(text)
    const reply = await collect(turn.textStream)
    await turn.done
    return reply
  }

  it('runs the tool, answers in a second step, and keeps the tool call + result in history', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallReply('searchProducts', { query: 'lipstick' }), textReply(['Red Lipstick — $12.99'])],
    })
    const { session, repo, sink } = newToolSession(model)

    expect(await runTurn(session, 'show me lipstick')).toBe('Red Lipstick — $12.99')

    expect(repo.calls).toEqual([{ method: 'search', args: ['lipstick', 5] }])
    expect(session.history.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(sink.records.map(r => r.toolCalls)).toEqual([[{ toolName: 'searchProducts', input: { query: 'lipstick' } }], []])
  })

  it('sends the model the slim output, not the full product', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallReply('searchProducts', { query: 'lipstick' }), textReply(['ok'])],
    })
    const { session } = newToolSession(model)
    await runTurn(session, 'show me lipstick')

    const toolMessage = JSON.stringify(model.doStreamCalls[1]!.prompt.find(m => m.role === 'tool'))
    expect(toolMessage).toContain('Red Lipstick')
    expect(toolMessage).toContain('"shown":1')
    expect(toolMessage).not.toContain('thumbnail')
  })

  it('tells the model when the catalog is unavailable', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallReply('searchProducts', { query: 'lipstick' }), textReply(['The catalog is down.'])],
    })
    const { session } = newToolSession(model, { repo: createFakeRepository({ search: unavailable }) })
    await runTurn(session, 'show me lipstick')

    const toolMessage = JSON.stringify(model.doStreamCalls[1]!.prompt.find(m => m.role === 'tool'))
    expect(toolMessage).toContain('catalog_unavailable')
  })

  it('forbids tool calls on the last allowed step, so the turn ends in text', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallReply('searchProducts', { query: 'lipstick' }), textReply(['Here you go.'])],
    })
    const { session } = newToolSession(model, { maxSteps: 2 })

    expect(await runTurn(session, 'show me lipstick')).toBe('Here you go.')
    expect(model.doStreamCalls.map(call => call.toolChoice?.type)).toEqual(['auto', 'none'])
  })

  it('with a single step allowed, answers without tools', async () => {
    const model = new MockLanguageModelV4({ doStream: [textReply(['Hi!'])] })
    const { session } = newToolSession(model, { maxSteps: 1 })

    await runTurn(session, 'hi')
    expect(model.doStreamCalls[0]!.toolChoice?.type).toBe('none')
  })

  it('later turns see earlier tool results', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallReply('browseCategory', { category: 'smartphones' }),
        textReply(['Here are some phones.']),
        textReply(['I don\'t have warranty information.']),
      ],
    })
    const { session } = newToolSession(model)

    await runTurn(session, 'show me smartphones')
    await runTurn(session, 'does the first one have a warranty?')

    const prompt = model.doStreamCalls[2]!.prompt
    expect(prompt.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user'])
  })
})
