import { useCallback, useEffect, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import type { UIMessage } from 'ai'

import { useApiClient, useChatList } from './provider.tsx'

/**
 * The newest page of a chat's stored history, for seeding `useShoppingChat`.
 * A new (unknown) chat id has an empty history.
 */
export function useChatHistory(chatId: string) {
  const client = useApiClient()
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready', messages: UIMessage[], hasMore: boolean }
    | { status: 'error', error: Error }
  >({ status: 'loading' })

  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    client.loadHistory(chatId).then(
      page => { if (current) setState({ status: 'ready', ...page }) },
      error => { if (current) setState({ status: 'error', error: toError(error) }) },
    )
    return () => { current = false }
  }, [client, chatId])

  return state
}

/**
 * One chat: `useChat` over our transport, seeded with stored history.
 * `useChat` reads `messages` only when it creates the chat, so mount this once
 * the history has loaded, keyed by chat id.
 */
export function useShoppingChat(chatId: string, initialMessages: UIMessage[]) {
  const client = useApiClient()
  const { refresh } = useChatList()

  return useChat({
    id: chatId,
    messages: initialMessages,
    transport: client.transport,
    // A first turn creates the chat server-side; later turns move it up the list.
    onFinish: () => refresh(),
  })
}

/**
 * Older history pages for a chat opened on its newest page: `loadEarlier`
 * fetches the page before the first loaded message and prepends it.
 * One load at a time; a failed load can be retried.
 */
export function useEarlierMessages(chat: ReturnType<typeof useShoppingChat>, initialHasMore: boolean) {
  const client = useApiClient()
  const [hasEarlier, setHasEarlier] = useState(initialHasMore)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error>()
  const { id: chatId, messages, setMessages } = chat
  const firstId = messages[0]?.id

  const loadEarlier = useCallback(async () => {
    if (loading || !hasEarlier || firstId === undefined) return
    setLoading(true)
    setError(undefined)
    try {
      const page = await client.loadHistory(chatId, firstId)
      setMessages(current => {
        const loaded = new Set(current.map(message => message.id))
        return [...page.messages.filter(message => !loaded.has(message.id)), ...current]
      })
      setHasEarlier(page.hasMore)
    } catch (caught) {
      setError(toError(caught))
    } finally {
      setLoading(false)
    }
  }, [client, chatId, firstId, hasEarlier, loading, setMessages])

  return { hasEarlier, loading, error, loadEarlier }
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}
