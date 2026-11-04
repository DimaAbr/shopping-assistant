import { useEffect, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import type { UIMessage } from 'ai'

import { useApiClient, useChatList } from './provider.tsx'

/**
 * The stored history of a chat, for seeding `useShoppingChat`.
 * A new (unknown) chat id has an empty history.
 */
export function useChatHistory(chatId: string) {
  const client = useApiClient()
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready', messages: UIMessage[] }
    | { status: 'error', error: Error }
  >({ status: 'loading' })

  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    client.loadHistory(chatId).then(
      messages => { if (current) setState({ status: 'ready', messages }) },
      error => { if (current) setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) }) },
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
