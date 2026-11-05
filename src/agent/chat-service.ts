import { generateId, type LanguageModel, type ToolSet, type UIMessage } from 'ai'
import { createStepLogger, type StepLogSink } from '../observability/step-log.ts'
import type { ChatStore, Memory } from '../store/chat-store.ts'
import { createChatSession, type ChatSession } from './chat.ts'
import { extractMemories } from './memory.ts'
import { summarizeChat } from './summarize.ts'

/**
 * Persistent chats — what the adapters (CLI, HTTP) call. `forUser(userId)` gives
 * one user's chats. Background work (titles) is shared, so `settled()` covers every user.
 *
 * - `newChat()` is not stored until its first successful turn, so empty chats
 *   never appear in the list. The user row (if new), the chat row and the first
 *   messages are written in one transaction.
 * - After that first turn, a title is generated in the background with the
 *   `summarizer` model. If it fails the chat stays untitled and lists fall back
 *   to its first message; the turn itself is never affected.
 * - With a `memoryModel`, every turn is followed by memory extraction in the
 *   background (10, "Memories"), one at a time per chat. Each turn's
 *   instructions are built from the user's memories at that moment. A failed
 *   extraction loses that turn's facts; the turn is never affected.
 * - With a `historyWindow`, the model sees only the most recent messages, and a
 *   resumed chat loads only that many.
 */

export type ChatServiceOptions<TOOLS extends ToolSet = ToolSet> = {
  store: ChatStore
  model: LanguageModel
  summarizer: LanguageModel
  /** The model for memory extraction. Without one, nothing is remembered. */
  memoryModel?: LanguageModel
  /** A fixed string, or built per turn from the user's memories (lasting ones and this chat's). */
  instructions?: string | ((memories: readonly Memory[]) => string)
  tools?: TOOLS
  /** See `ChatSessionOptions.historyWindow`. Default: the whole history. */
  historyWindow?: number
  maxSteps: number
  /** See `ChatSessionOptions.stepTimeoutMs`. */
  stepTimeoutMs: number
  logSink: StepLogSink
  /** Background failures (title generation, memory extraction). Default: ignored. */
  onBackgroundError?: (error: unknown, context: { chatId: string, task: 'title' | 'memory' }) => void
}

export function createChatService<TOOLS extends ToolSet = ToolSet>(options: ChatServiceOptions<TOOLS>) {
  const { store } = options
  const background = new Set<Promise<void>>()
  /** The last memory extraction queued per chat, so they run one at a time. */
  const memoryQueues = new Map<string, Promise<void>>()

  function track(task: Promise<void>) {
    background.add(task)
    void task.finally(() => background.delete(task))
  }

  /** Resolves when background work (title generation) has finished — e.g. before exiting. */
  async function settled(): Promise<void> {
    while (background.size > 0)
      await Promise.allSettled([...background])
  }

  /**
   * Queues a memory extraction for the turn. Extractions of one chat run in order,
   * so each sees the previous one's changes. Two chats of the same user can still
   * both change lasting memories at once; the later write wins.
   */
  function rememberTurn(userId: string, chatId: string, newMessages: UIMessage[]) {
    const memoryModel = options.memoryModel
    if (memoryModel === undefined) return

    const task = (memoryQueues.get(chatId) ?? Promise.resolve())
      .then(async () => {
        const ops = await extractMemories({
          model: memoryModel,
          current: await store.loadMemories(userId, chatId),
          newMessages,
          log: createStepLogger({ chatId, turn: 0, scope: 'memory', sink: options.logSink }),
        })
        await store.applyMemoryOps(userId, chatId, ops, { sourceMessageId: newMessages.find(message => message.role === 'user')?.id })
      })
      .catch(error => options.onBackgroundError?.(error, { chatId, task: 'memory' }))

    memoryQueues.set(chatId, task)

    void task.finally(() => {
      if (memoryQueues.get(chatId) === task)
        memoryQueues.delete(chatId)
    })
    
    track(task)
  }

  function instructionsFor(userId: string, chatId: string): string | (() => Promise<string>) | undefined {
    const build = options.instructions
    if (typeof build !== 'function') return build
    return async () => build(options.memoryModel === undefined ? [] : await store.loadMemories(userId, chatId))
  }

  function session(userId: string, chatId: string, initialMessages: UIMessage[], initialTurns?: number): ChatSession<TOOLS> {
    let stored = initialMessages.length > 0

    return createChatSession({
      model: options.model,
      chatId,
      instructions: instructionsFor(userId, chatId),
      tools: options.tools,
      maxSteps: options.maxSteps,
      stepTimeoutMs: options.stepTimeoutMs,
      logSink: options.logSink,
      initialMessages,
      initialTurns,
      historyWindow: options.historyWindow,
      onTurnEnd: async newMessages => {
        const isFirst = !stored
        await store.appendMessages(userId, chatId, newMessages, { createIfMissing: isFirst })
        stored = true

        if (isFirst) track(
          summarizeChat({ model: options.summarizer, messages: newMessages, purpose: 'title' })
            .then(title => store.setTitle(userId, chatId, title))
            .catch(error => options.onBackgroundError?.(error, { chatId, task: 'title' })),
        )
        rememberTurn(userId, chatId, newMessages)
      },
    })
  }

  return {
    /** One user's chats. Nothing is stored for a user until their first chat is. */
    forUser(userId: string) {
      return {
        userId,

        /**
         * A fresh chat, stored on its first successful turn. The id can come from
         * the client (07, "Chat ids"); by default one is generated.
         */
        newChat(chatId = generateId()): ChatSession<TOOLS> {
          return session(userId, chatId, [])
        },

        /**
         * Resumes a stored chat: its last `historyWindow` messages, or all of them.
         * Throws `ChatNotFoundError` if this user has no such chat.
         */
        async openChat(chatId: string): Promise<ChatSession<TOOLS>> {
          if (options.historyWindow === undefined)
            return session(userId, chatId, await store.loadMessages(userId, chatId))

          const [page, turns] = await Promise.all([
            store.loadMessagesPage(userId, chatId, { limit: options.historyWindow }),
            store.countTurns(userId, chatId),
          ])
          return session(userId, chatId, page.messages, turns)
        },

        listChats: () => store.listChats(userId),

        /** A page of stored history, oldest first. Throws `ChatNotFoundError` like `openChat`. */
        loadMessagesPage: (chatId: string, page: { before?: string, limit: number }) =>
          store.loadMessagesPage(userId, chatId, page),

        /** The service's `settled()`: background work is shared across users. */
        settled,
      }
    },

    settled,
  }
}

export type ChatService<TOOLS extends ToolSet = ToolSet> = ReturnType<typeof createChatService<TOOLS>>
export type UserChats<TOOLS extends ToolSet = ToolSet> = ReturnType<ChatService<TOOLS>['forUser']>
