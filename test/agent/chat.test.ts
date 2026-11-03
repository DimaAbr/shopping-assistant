import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'

import { createChatSession } from '../../src/agent/chat.ts'
import { memorySink } from '../../src/observability/step-log.ts'

/** A scripted stream for one model call: plain text, split into chunks. */
function textReply(chunks: string[], usage = { input: 10, output: 5 }) {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...chunks.map(delta => ({ type: 'text-delta' as const, id: 't1', delta })),
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens:  { total: usage.input,  noCache: usage.input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: usage.output, text: usage.output,   reasoning: 0 },
      },
    },
  ]
  return { stream: convertArrayToReadableStream(parts) }
}

async function collect(stream: AsyncIterable<string>) {
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}

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
