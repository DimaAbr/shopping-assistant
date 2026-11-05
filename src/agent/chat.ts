import {
  convertToModelMessages,
  generateId,
  isStepCount,
  toUIMessageStream,
  streamText,
  type LanguageModel,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { createStepLogger, type StepLogSink } from '../observability/step-log.ts'

/**
 * A chat session.
 *
 * History is a list of AI SDK `UIMessage`s — the stored source of truth (02 §6, §7).
 * Tool parts keep the tool's full raw output (e.g. thumbnails, for the UI);
 * `convertToModelMessages(…, { tools })` derives the model's view per turn,
 * applying each tool's `toModelOutput`.
 *
 * Persistence is a port: `onTurnEnd` receives each successful turn's new
 * messages ([user, assistant]). The session itself knows nothing about storage.
 */

export type ChatSessionOptions<TOOLS extends ToolSet = ToolSet> = {
  model: LanguageModel
  chatId: string
  instructions?: string
  tools?: TOOLS
  maxSteps: number
  /**
   * The longest one step may take: the model call plus its tool calls. A step
   * that runs longer fails the turn, so a hung model call can't hold a chat forever.
   */
  stepTimeoutMs: number
  logSink: StepLogSink
  /** Prior history, e.g. loaded from the store when a chat is resumed. */
  initialMessages?: readonly UIMessage[]
  /**
   * Called once per successful turn with the messages it added, before `done` resolves.
   * If it throws, the turn fails and history is rolled back.
   */
  onTurnEnd?: (newMessages: UIMessage[]) => Promise<void>
}

export type ChatTurn<TOOLS extends ToolSet = ToolSet> = {
  /**
   * Text deltas as they arrive. Errors are NOT surfaced here — await `done`.
   * Read at most one of `textStream` / `fullStream`; `uiStream` can be read alongside either.
   */
  textStream: AsyncIterable<string>
  /** Every stream part (text, tool calls, tool results, …), e.g. for tracing tool use. */
  fullStream: AsyncIterable<TextStreamPart<TOOLS>>
  /**
   * The UI message stream for this turn (what `useChat` consumes). Optional to read,
   * and safe to cancel: the session reads its own copy, so the turn still finishes and is saved.
   */
  uiStream: ReadableStream<UIMessageChunk>
  /** Resolves once the turn is finished, appended to history and passed to `onTurnEnd`; rejects on error. */
  done: Promise<void>
}

export function createChatSession<TOOLS extends ToolSet = ToolSet>(options: ChatSessionOptions<TOOLS>) {
  const history: UIMessage[] = [...options.initialMessages ?? []]
  // Turn numbers in the step log continue across restarts.
  let turn = history.filter(message => message.role === 'user').length

  async function send(text: string): Promise<ChatTurn<TOOLS>> {
    turn += 1
    const historyLengthBefore = history.length
    history.push({
      id: generateId(),
      role: 'user',
      parts: [{ type: 'text', text }],
    })
    const originalMessages = [...history]

    const logger = createStepLogger({ chatId: options.chatId, turn, sink: options.logSink })
    let streamError: unknown

    const result = streamText({
      model: options.model,
      instructions: options.instructions,
      messages: await convertToModelMessages(originalMessages, { tools: options.tools }),
      tools: options.tools,
      stopWhen: isStepCount(options.maxSteps),
      timeout: { stepMs: options.stepTimeoutMs },
      // The last allowed step must answer in text, so a turn never ends on an
      // unanswered tool call when it hits the step limit.
      prepareStep: ({ stepNumber }) => stepNumber >= options.maxSteps - 1 ? { toolChoice: 'none' } : {},
      onStepStart: logger.onStepStart,
      onStepEnd: logger.onStepEnd,
      onError: ({ error }) => { streamError = error },
    })

    // The UI stream builds the assistant `UIMessage`. One branch is drained here,
    // so the turn completes (and is saved) whether or not the adapter reads `uiStream`.
    let resolveMessages!: (messages: UIMessage[]) => void
    const uiMessages = new Promise<UIMessage[]>(resolve => { resolveMessages = resolve })
    const [uiForAdapter, uiForSession] = toUIMessageStream({
      stream: result.stream,
      originalMessages,
      generateMessageId: generateId,
      onEnd: ({ messages }) => resolveMessages(messages),
    }).tee()
    void drain(uiForSession)

    const done = Promise.all([result.responseMessages, uiMessages])
      .then(async ([, messages]) => {
        if (streamError !== undefined) throw streamError

        const newMessages = messages.slice(historyLengthBefore)
        await options.onTurnEnd?.(newMessages)
        history.length = historyLengthBefore
        history.push(...newMessages)
      })
      .catch(error => {
        // Roll back the failed turn so history never ends with an unanswered user message.
        history.length = historyLengthBefore
        // On a stream error the SDK rejects with a generic NoOutputGeneratedError —
        // the actual cause only reaches `onError`, so prefer that.
        throw streamError ?? error
      })

    return {
      textStream: result.textStream,
      fullStream: result.stream,
      uiStream: uiForAdapter.pipeThrough(timeoutAsError()),
      done,
    }
  }

  return {
    chatId: options.chatId,
    get history(): readonly UIMessage[] { return history },
    send,
  }
}

export type ChatSession<TOOLS extends ToolSet = ToolSet> = ReturnType<typeof createChatSession<TOOLS>>

export const TIMEOUT_ERROR_TEXT = 'The reply took too long. Please try again.'

/**
 * Only a timeout aborts a turn: client disconnects never reach the session. The
 * SDK reports it as an `abort` chunk, which `useChat` treats as the user pressing
 * stop, so the client is told it failed instead.
 */
function timeoutAsError() {
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      controller.enqueue(chunk.type === 'abort'
        ? { type: 'error', errorText: TIMEOUT_ERROR_TEXT }
        : chunk
      )
    },
  })
}

async function drain(stream: ReadableStream<unknown>) {
  const reader = stream.getReader()
  try {
    while (!(await reader.read()).done) { /* discard */ }
  } catch {
    // Errors surface through `done`, not here.
  }
}
