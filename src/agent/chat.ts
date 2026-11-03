import { isStepCount, streamText, type LanguageModel, type ModelMessage } from 'ai'
import { createStepLogger, type StepLogSink } from '../observability/step-log.ts'

/**
 * A chat session with in-memory history (phase 1).
 *
 * History is the full list of `ModelMessage`s — user turns plus everything
 * the model produced (assistant text, and later tool calls / tool results).
 * Persistence (phase 3) and the derived context view (phase 4) build on this.
 */

export type ChatSessionOptions = {
  model:        LanguageModel
  chatId:       string
  instructions?: string
  maxSteps:     number
  logSink:      StepLogSink
}

export type ChatTurn = {
  /** Text deltas as they arrive. Errors are NOT surfaced here — await `done`. */
  textStream: AsyncIterable<string>
  /** Resolves once the turn is finished and appended to history; rejects on error. */
  done:       Promise<void>
}

export function createChatSession(options: ChatSessionOptions) {
  const history: ModelMessage[] = []
  let turn = 0

  function send(text: string): ChatTurn {
    turn += 1
    const historyLengthBefore = history.length
    history.push({ role: 'user', content: text })

    const logger = createStepLogger({ chatId: options.chatId, turn, sink: options.logSink })
    let streamError: unknown

    const result = streamText({
      model:        options.model,
      instructions: options.instructions,
      messages:     [...history],
      stopWhen:     isStepCount(options.maxSteps),
      onStepStart:  logger.onStepStart,
      onStepEnd:    logger.onStepEnd,
      onError:      ({ error }) => { streamError = error },
    })

    const done = Promise.resolve(result.responseMessages).then(
      messages => {
        if (streamError !== undefined) throw streamError
        history.push(...messages)
      },
    ).catch(error => {
      // Roll back the failed turn so history never ends with an unanswered user message.
      history.length = historyLengthBefore
      // On a stream error the SDK rejects with a generic NoOutputGeneratedError —
      // the actual cause only reaches `onError`, so prefer that.
      throw streamError ?? error
    })

    return { textStream: result.textStream, done }
  }

  return {
    chatId: options.chatId,
    get history(): readonly ModelMessage[] { return history },
    send,
  }
}

export type ChatSession = ReturnType<typeof createChatSession>
