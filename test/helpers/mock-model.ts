import { convertArrayToReadableStream } from 'ai/test'
import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider'

/** Scripted streams for `MockLanguageModelV4` — one per model call ("step"). */

type Usage = { input: number, output: number }

function usageOf(usage: Usage) {
  return {
    inputTokens: { total: usage.input, noCache: usage.input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: usage.output, text: usage.output, reasoning: 0 },
  }
}

function finish(reason: 'stop' | 'tool-calls', usage: Usage): LanguageModelV4StreamPart {
  return { type: 'finish', finishReason: { unified: reason, raw: reason }, usage: usageOf(usage) }
}

/** A non-streaming text reply, for `doGenerate` (e.g. `generateText` in the summarizer). */
export function generatedText(text: string, usage: Usage = { input: 10, output: 5 }): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: usageOf(usage),
    warnings: [],
  }
}

/** A plain text reply, split into chunks. */
export function textReply(chunks: string[], usage: Usage = { input: 10, output: 5 }) {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...chunks.map(delta => ({ type: 'text-delta' as const, id: 't1', delta })),
    { type: 'text-end', id: 't1' },
    finish('stop', usage),
  ]
  return { stream: convertArrayToReadableStream(parts) }
}

/**
 * A text reply that sends `first`, then waits for `release()` before sending `rest`.
 * For holding a turn open mid-stream (busy chats, client disconnects).
 */
export function gatedTextReply(first: string, rest: string, usage: Usage = { input: 10, output: 5 }) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })

  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      controller.enqueue({ type: 'text-start', id: 't1' })
      controller.enqueue({ type: 'text-delta', id: 't1', delta: first })
      await gate
      controller.enqueue({ type: 'text-delta', id: 't1', delta: rest })
      controller.enqueue({ type: 'text-end', id: 't1' })
      controller.enqueue(finish('stop', usage))
      controller.close()
    },
  })
  return { reply: { stream }, release }
}

/** A step that only calls one tool. */
export function toolCallReply(toolName: string, input: unknown, toolCallId = 'call-1', usage: Usage = { input: 10, output: 5 }) {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    finish('tool-calls', usage),
  ]
  return { stream: convertArrayToReadableStream(parts) }
}

export async function collect(stream: AsyncIterable<string>) {
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}
