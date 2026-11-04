import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import type { UIMessage } from 'ai'

import { describeChatError, useChatHistory, useShoppingChat } from '../core/index.ts'
import { ProductTiles } from './ProductTiles.tsx'
import styles from './Thread.module.css'

/**
 * The active chat. Our `useChat` (via `useShoppingChat`) owns the state;
 * assistant-ui's unstyled primitives render it: scrolling, the composer,
 * send/stop and streaming states. Styling is ours (plain CSS modules).
 */

export function ChatView({ chatId }: { chatId: string }) {
  const history = useChatHistory(chatId)

  if (history.status === 'loading') return <div className={styles.status}>Loading…</div>
  if (history.status === 'error')
    return <div className={`${styles.status} ${styles.error}`} role="alert">Couldn't load this chat: {history.error.message}</div>

  // Keyed: `useChat` takes the history only when it creates the chat.
  return <ChatThread key={chatId} chatId={chatId} initialMessages={history.messages} />
}

function ChatThread({ chatId, initialMessages }: { chatId: string, initialMessages: UIMessage[] }) {
  const chat = useShoppingChat(chatId, initialMessages)
  const runtime = useAISDKRuntime(chat)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className={styles.thread}>
        <ThreadPrimitive.Viewport className={styles.viewport}>
          <ThreadPrimitive.Empty>
            <div className={styles.welcome}>
              <h2>What are you shopping for?</h2>
              <p>Try “a gift for my dad who likes cooking” or “show me some lipstick”.</p>
            </div>
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Messages>
            {({ message }) => message.role === 'user' ? <UserMessage /> : <AssistantMessage />}
          </ThreadPrimitive.Messages>

          {chat.error && <p className={styles.error} role="alert">{describeChatError(chat.error)}</p>}

          <ThreadPrimitive.ViewportFooter className={styles.footer}>
            <ThreadPrimitive.ScrollToBottom className={styles.scrollToBottom} aria-label="Scroll to the latest message">
              ↓
            </ThreadPrimitive.ScrollToBottom>
            <Composer />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className={`${styles.message} ${styles.user}`}>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className={`${styles.message} ${styles.assistant}`}>
      <MessagePrimitive.Parts
        components={{
          Text: () => <MarkdownTextPrimitive className={styles.markdown} smooth />,
          // Stored reasoning parts are provider-encrypted (02 §14.7); nothing to show.
          Reasoning: () => null,
          tools: {
            by_name: { searchProducts: ProductTiles, browseCategory: ProductTiles },
            Fallback: ({ toolName }) => <p className={styles.toolNote}>Used {toolName}</p>,
          },
        }}
      />
    </MessagePrimitive.Root>
  )
}

function Composer() {
  return (
    <ComposerPrimitive.Root className={styles.composer}>
      <ComposerPrimitive.Input className={styles.input} placeholder="Ask about products…" rows={1} autoFocus />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send className={styles.button}>Send</ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel className={styles.button}>Stop</ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  )
}
