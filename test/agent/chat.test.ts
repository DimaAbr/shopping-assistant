import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { UIMessage } from 'ai'

import { createChatSession, TIMEOUT_ERROR_TEXT } from '../../src/agent/chat.ts'
import { memorySink } from '../../src/observability/step-log.ts'
import { createFakeRepository, testShoppingTools, unavailable } from '../helpers/fake-repository.ts'
import { collect, gatedTextReply, textReply, toolCallReply } from '../helpers/mock-model.ts'

function newSession(model: MockLanguageModelV4) {
  const sink = memorySink()
  const session = createChatSession({
    model,
    chatId: 'chat-1',
    instructions: 'be nice',
    maxSteps: 3,
    stepTimeoutMs: 10_000,
    logSink: sink,
  })
  return { session, sink }
}

describe('chat session', () => {
  it('streams the reply text chunk by chunk', async () => {
    const model = new MockLanguageModelV4({ doStream: [textReply(['Hel', 'lo', '!'])] })
    const { session } = newSession(model)

    const turn = await session.send('hi')
    expect(await collect(turn.textStream)).toBe('Hello!')
    await turn.done
  })

  it('keeps history across turns', async () => {
    const model = new MockLanguageModelV4({
      doStream: [textReply(['Nice to meet you, Dima.']), textReply(['Your name is Dima.'])],
    })
    const { session } = newSession(model)

    for (const text of ['my name is Dima', 'what is my name?']) {
      const turn = await session.send(text)
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

    const turn = await session.send('hi')
    await collect(turn.textStream)
    await turn.done

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({
      chatId: 'chat-1',
      turn: 1,
      step: 0,
      finishReason: 'stop',
      usage: { input: 12, output: 3, total: 15 },
      toolCalls: [],
      toolResultBytes: 0,
    })
    expect(sink.records[0]!.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('rejects `done` and rolls back history when the model errors', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => { throw new Error('provider down') },
    })
    const { session } = newSession(model)

    const turn = await session.send('hi')
    await collect(turn.textStream)
    await expect(turn.done).rejects.toThrow('provider down')
    expect(session.history).toEqual([])
  })
})

describe('chat session step timeout', () => {
  it('fails a step that runs too long, rolls back, and reports an error chunk instead of an abort', async () => {
    const hung = gatedTextReply('Hel', 'never sent')
    const saved: UIMessage[][] = []
    const session = createChatSession({
      model: new MockLanguageModelV4({ doStream: [hung.reply] }),
      chatId: 'chat-1',
      maxSteps: 3,
      stepTimeoutMs: 50,
      logSink: memorySink(),
      onTurnEnd: async messages => { saved.push(messages) },
    })

    const turn = await session.send('hi')
    const chunks = []
    for await (const chunk of turn.uiStream) chunks.push(chunk)

    await expect(turn.done).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(chunks.map(chunk => chunk.type)).not.toContain('abort')
    expect(chunks).toContainEqual({ type: 'error', errorText: TIMEOUT_ERROR_TEXT })
    expect(session.history).toEqual([])
    expect(saved).toEqual([])
  })
})

describe('chat session with shopping tools', () => {
  function newToolSession(model: MockLanguageModelV4, options: { maxSteps?: number, repo?: ReturnType<typeof createFakeRepository> } = {}) {
    const repo = options.repo ?? createFakeRepository()
    const sink = memorySink()
    const session = createChatSession({
      model,
      chatId: 'chat-1',
      instructions: 'be nice',
      tools: testShoppingTools(repo),
      maxSteps: options.maxSteps ?? 3,
      stepTimeoutMs: 10_000,
      logSink: sink,
    })
    return { session, sink, repo }
  }

  async function runTurn(session: { send(text: string): Promise<{ textStream: AsyncIterable<string>, done: Promise<void> }> }, text: string) {
    const turn = await session.send(text)
    const reply = await collect(turn.textStream)
    await turn.done
    return reply
  }

  it('runs the tool, answers in a second step, and keeps the tool call + result in history', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallReply('findProducts', { request: 'lipstick' }), textReply(['Red Lipstick — $12.99'])],
    })
    const { session, repo, sink } = newToolSession(model)

    expect(await runTurn(session, 'show me lipstick')).toBe('Red Lipstick — $12.99')

    expect(repo.calls).toEqual([{ method: 'search', args: ['lipstick', 20] }])
    // One UI message per side; the tool call + result are parts of the assistant message.
    expect(session.history.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(session.history[1]!.parts.map(p => p.type)).toContain('tool-findProducts')
    expect(sink.records.map(r => r.toolCalls)).toEqual([[{ toolName: 'findProducts', input: { request: 'lipstick' } }], []])
  })

  it('sends the model the slim output, not the full product', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallReply('findProducts', { request: 'lipstick' }), textReply(['ok'])],
    })
    const { session } = newToolSession(model)
    await runTurn(session, 'show me lipstick')

    const toolMessage = JSON.stringify(model.doStreamCalls[1]!.prompt.find(m => m.role === 'tool'))
    expect(toolMessage).toContain('Red Lipstick')
    expect(toolMessage).toContain('"label":"Lipstick"')
    expect(toolMessage).not.toContain('imageUrl')
  })

  it('tells the model when the catalog is unavailable', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallReply('findProducts', { request: 'lipstick' }), textReply(['The catalog is down.'])],
    })
    const { session } = newToolSession(model, { repo: createFakeRepository({ search: unavailable }) })
    await runTurn(session, 'show me lipstick')

    const toolMessage = JSON.stringify(model.doStreamCalls[1]!.prompt.find(m => m.role === 'tool'))
    expect(toolMessage).toContain('catalog_unavailable')
  })

  it('forbids tool calls on the last allowed step, so the turn ends in text', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallReply('findProducts', { request: 'lipstick' }), textReply(['Here you go.'])],
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
        toolCallReply('findProducts', { request: 'smartphones' }),
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

describe('chat session persistence hooks', () => {
  function persistingSession(model: MockLanguageModelV4, options: { initialMessages?: UIMessage[], onTurnEnd?: (m: UIMessage[]) => Promise<void> } = {}) {
    const saved: UIMessage[][] = []
    const session = createChatSession({
      model,
      chatId: 'chat-1',
      instructions: 'be nice',
      tools: testShoppingTools(),
      maxSteps: 3,
      stepTimeoutMs: 10_000,
      logSink: memorySink(),
      initialMessages: options.initialMessages,
      onTurnEnd: options.onTurnEnd ?? (async messages => { saved.push(messages) }),
    })
    return { session, saved }
  }

  it('passes [user, assistant] to onTurnEnd on success', async () => {
    const model = new MockLanguageModelV4({ doStream: [textReply(['Hello!'])] })
    const { session, saved } = persistingSession(model)

    const turn = await session.send('hi')
    await collect(turn.textStream)
    await turn.done

    expect(saved).toHaveLength(1)
    expect(saved[0]!.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(saved[0]![0]!.parts).toEqual([{ type: 'text', text: 'hi' }])
    expect(saved[0]![1]!.id).toBeTruthy()
    expect(saved[0]).toEqual(session.history)
  })

  it('does not call onTurnEnd when the model errors', async () => {
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error('provider down') } })
    const { session, saved } = persistingSession(model)

    const turn = await session.send('hi')
    await expect(turn.done).rejects.toThrow('provider down')
    expect(saved).toEqual([])
  })

  it('rolls back history when onTurnEnd fails', async () => {
    const model = new MockLanguageModelV4({ doStream: [textReply(['Hello!'])] })
    const { session } = persistingSession(model, { onTurnEnd: async () => { throw new Error('disk full') } })

    const turn = await session.send('hi')
    await expect(turn.done).rejects.toThrow('disk full')
    expect(session.history).toEqual([])
  })

  it('stores the full tool output, while the model only sees the slim view', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallReply('findProducts', { request: 'lipstick' }), textReply(['Red Lipstick — $12.99'])],
    })
    const { session, saved } = persistingSession(model)

    const turn = await session.send('show me lipstick')
    await turn.done

    const toolPart = saved[0]![1]!.parts.find(p => p.type === 'tool-findProducts')
    expect(toolPart).toMatchObject({ state: 'output-available', input: { request: 'lipstick' }, output: { status: 'ok' } })
    expect(JSON.stringify(toolPart)).toContain('imageUrl')
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).not.toContain('imageUrl')
  })

  it('resumes from initialMessages: the model sees prior tool results, turn numbers continue', async () => {
    // Record a turn with a tool call, then start a new session from what was saved.
    const first = new MockLanguageModelV4({
      doStream: [toolCallReply('findProducts', { request: 'smartphones' }), textReply(['Here are some phones.'])],
    })
    const { session: original, saved } = persistingSession(first)
    await (await original.send('show me smartphones')).done
    const stored = JSON.parse(JSON.stringify(saved.flat())) as UIMessage[]   // as if read back from the DB

    const second = new MockLanguageModelV4({ doStream: [textReply(['The first one is the cheapest.'])] })
    const sink = memorySink()
    const resumed = createChatSession({
      model: second,
      chatId: 'chat-1',
      tools: testShoppingTools(),
      maxSteps: 3,
      stepTimeoutMs: 10_000,
      logSink: sink,
      initialMessages: stored,
    })
    await (await resumed.send('which is cheapest?')).done

    const prompt = second.doStreamCalls[0]!.prompt
    expect(prompt.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    expect(JSON.stringify(prompt.find(m => m.role === 'tool'))).toContain('"groups"')
    expect(sink.records[0]!.turn).toBe(2)
    expect(resumed.history).toHaveLength(4)
  })

  it('exposes the UI message stream for adapters', async () => {
    const model = new MockLanguageModelV4({ doStream: [textReply(['Hel', 'lo'])] })
    const { session } = persistingSession(model)

    const turn = await session.send('hi')
    const chunks: string[] = []
    for await (const chunk of turn.uiStream) chunks.push(chunk.type)
    await turn.done

    expect(chunks).toContain('start')
    expect(chunks).toContain('text-delta')
    expect(chunks.at(-1)).toBe('finish')
  })
})
