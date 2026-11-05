import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react'
import type { UIMessage } from 'ai'

import { describeChatError, useChatHistory, useEarlierMessages, useShoppingChat } from '../core/index.ts'
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
  return <ChatThread key={chatId} chatId={chatId} initialMessages={history.messages} initialHasMore={history.hasMore} />
}

function ChatThread({ chatId, initialMessages, initialHasMore }: {
  chatId: string
  initialMessages: UIMessage[]
  initialHasMore: boolean
}) {
  const chat = useShoppingChat(chatId, initialMessages)
  const earlier = useEarlierMessages(chat, initialHasMore)
  const runtime = useAISDKRuntime(chat)
  const viewport = useRef<HTMLDivElement>(null)
  const keepScroll = useKeepScrollOnPrepend(viewport, chat.messages[0]?.id)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className={styles.thread}>
        <ThreadPrimitive.Viewport ref={viewport} className={styles.viewport}>
          <ThreadPrimitive.Empty>
            <div className={styles.welcome}>
              <h2>What are you shopping for?</h2>
              <p>Try “a gift for my dad who likes cooking” or “show me some lipstick”.</p>
            </div>
          </ThreadPrimitive.Empty>

          {earlier.hasEarlier && <LoadEarlier earlier={earlier} beforeLoad={keepScroll} />}

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

/**
 * Loads the previous history page. Our own button, not `ThreadPrimitive.LoadEarlier`:
 * `useAISDKRuntime` doesn't pass `hasEarlier`/`onLoadEarlier` through to the runtime.
 */
function LoadEarlier({ earlier, beforeLoad }: {
  earlier: ReturnType<typeof useEarlierMessages>
  beforeLoad: () => void
}) {
  const load = () => {
    beforeLoad()
    void earlier.loadEarlier()
  }

  return (
    <div className={styles.loadEarlier}>
      <button type="button" className={styles.loadEarlierButton} onClick={load} disabled={earlier.loading}>
        {earlier.loading ? 'Loading…' : 'Load earlier messages'}
      </button>
      {earlier.error && <p className={styles.error} role="alert">Couldn't load earlier messages: {earlier.error.message}</p>}
    </div>
  )
}

/**
 * Prepending grows the viewport from the top. Call the returned function before
 * a load: once the first message changes, the distance from the bottom is
 * restored, so the messages that were on screen stay in place.
 */
function useKeepScrollOnPrepend(viewport: RefObject<HTMLDivElement | null>, firstMessageId: string | undefined) {
  const fromBottom = useRef<number>(undefined)

  useLayoutEffect(() => {
    const element = viewport.current
    if (element && fromBottom.current !== undefined) element.scrollTop = element.scrollHeight - fromBottom.current
    fromBottom.current = undefined
  }, [viewport, firstMessageId])

  return useCallback(() => {
    const element = viewport.current
    if (element) fromBottom.current = element.scrollHeight - element.scrollTop
  }, [viewport])
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
            by_name: { findProducts: ProductTiles },
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
