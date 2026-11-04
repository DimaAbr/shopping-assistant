import { generateId, type LanguageModel, type ToolSet } from 'ai'
import type { StepLogSink } from '../observability/step-log.ts'
import type { ChatStore } from '../store/chat-store.ts'
import { createChatSession, type ChatSession } from './chat.ts'
import { summarizeChat } from './summarize.ts'

/**
 * Persistent chats for one user — what the adapters (CLI now, HTTP in phase 5) call.
 *
 * - `newChat()` is not stored until its first successful turn, so empty chats
 *   never appear in the list. The chat row and the first messages are written
 *   in one transaction.
 * - After that first turn, a title is generated in the background with the
 *   `summarizer` model. If it fails the chat stays untitled and lists fall back
 *   to its first message; the turn itself is never affected.
 */

export type ChatServiceOptions<TOOLS extends ToolSet = ToolSet> = {
  store: ChatStore
  userId: string
  model: LanguageModel
  summarizer: LanguageModel
  instructions?: string
  tools?: TOOLS
  maxSteps: number
  logSink: StepLogSink
  /** Background failures (title generation). Default: ignored. */
  onBackgroundError?: (error: unknown, context: { chatId: string, task: 'title' }) => void
}

export function createChatService<TOOLS extends ToolSet = ToolSet>(options: ChatServiceOptions<TOOLS>) {
  const { store, userId } = options
  const background = new Set<Promise<void>>()

  function track(task: Promise<void>) {
    background.add(task)
    void task.finally(() => background.delete(task))
  }

  function session(chatId: string, initialMessages: Awaited<ReturnType<ChatStore['loadMessages']>>): ChatSession<TOOLS> {
    let stored = initialMessages.length > 0

    return createChatSession({
      model: options.model,
      chatId,
      instructions: options.instructions,
      tools: options.tools,
      maxSteps: options.maxSteps,
      logSink: options.logSink,
      initialMessages,
      onTurnEnd: async newMessages => {
        const isFirst = !stored
        await store.appendMessages(userId, chatId, newMessages, { createIfMissing: isFirst })
        stored = true

        if (isFirst) track(
          summarizeChat({ model: options.summarizer, messages: newMessages, purpose: 'title' })
            .then(title => store.setTitle(userId, chatId, title))
            .catch(error => options.onBackgroundError?.(error, { chatId, task: 'title' })),
        )
      },
    })
  }

  return {
    userId,

    /** A fresh chat. Stored on its first successful turn. */
    newChat(): ChatSession<TOOLS> {
      return session(generateId(), [])
    },

    /** Resumes a stored chat. Throws `ChatNotFoundError` if this user has no such chat. */
    async openChat(chatId: string): Promise<ChatSession<TOOLS>> {
      return session(chatId, await store.loadMessages(userId, chatId))
    },

    listChats: () => store.listChats(userId),

    /** Resolves when background work (title generation) has finished — e.g. before exiting. */
    async settled(): Promise<void> {
      while (background.size > 0)
        await Promise.allSettled([...background])
    },
  }
}

export type ChatService<TOOLS extends ToolSet = ToolSet> = ReturnType<typeof createChatService<TOOLS>>
