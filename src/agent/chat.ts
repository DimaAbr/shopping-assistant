import { isStepCount, streamText, type LanguageModel, type ModelMessage, type TextStreamPart, type ToolSet } from 'ai'
import { createStepLogger, type StepLogSink } from '../observability/step-log.ts'

/**
 * A chat session with in-memory history.
 *
 * History is the full list of `ModelMessage`s — user turns plus everything
 * the model produced (assistant text, tool calls, tool results).
 * Persistence (phase 3) and the derived context view (phase 4) build on this.
 */

export type ChatSessionOptions<TOOLS extends ToolSet = ToolSet> = {
  model: LanguageModel
  chatId: string
  instructions?: string
  tools?: TOOLS
  maxSteps: number
  logSink: StepLogSink
}

export type ChatTurn<TOOLS extends ToolSet = ToolSet> = {
  /**
   * Text deltas as they arrive. Errors are NOT surfaced here — await `done`.
   * Read either this or `fullStream`, not both.
   */
  textStream: AsyncIterable<string>
  /** Every stream part (text, tool calls, tool results, …), e.g. for tracing tool use. */
  fullStream: AsyncIterable<TextStreamPart<TOOLS>>
  /** Resolves once the turn is finished and appended to history; rejects on error. */
  done: Promise<void>
}

export function createChatSession<TOOLS extends ToolSet = ToolSet>(options: ChatSessionOptions<TOOLS>) {
  const history: ModelMessage[] = []
  let turn = 0

  function send(text: string): ChatTurn<TOOLS> {
    turn += 1
    const historyLengthBefore = history.length
    history.push({ role: 'user', content: text })

    const logger = createStepLogger({ chatId: options.chatId, turn, sink: options.logSink })
    let streamError: unknown

    const result = streamText({
      model: options.model,
      instructions: options.instructions,
      messages: [...history],
      tools: options.tools,
      stopWhen: isStepCount(options.maxSteps),
      // The last allowed step must answer in text, so a turn never ends on an
      // unanswered tool call when it hits the step limit.
      prepareStep: ({ stepNumber }) => stepNumber >= options.maxSteps - 1 ? { toolChoice: 'none' } : {},
      onStepStart: logger.onStepStart,
      onStepEnd: logger.onStepEnd,
      onError: ({ error }) => { streamError = error },
    })

    const done = Promise.resolve(result.responseMessages)
      .then(
        messages => {
          if (streamError !== undefined) throw streamError
          history.push(...messages)
        },
      )
      .catch(error => {
        // Roll back the failed turn so history never ends with an unanswered user message.
        history.length = historyLengthBefore
        // On a stream error the SDK rejects with a generic NoOutputGeneratedError —
        // the actual cause only reaches `onError`, so prefer that.
        throw streamError ?? error
      })

    return { textStream: result.textStream, fullStream: result.stream, done }
  }

  return {
    chatId: options.chatId,
    get history(): readonly ModelMessage[] { return history },
    send,
  }
}

export type ChatSession<TOOLS extends ToolSet = ToolSet> = ReturnType<typeof createChatSession<TOOLS>>
