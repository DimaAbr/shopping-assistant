import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatSummaryJson } from 'shopping-assistant/contract'

import { createApiClient, type ApiClient } from './api-client.ts'
import type { ShoppingConfig } from './config.ts'

/**
 * The root of a chat UI: builds the API client from the host's config once,
 * and owns the chat list, which the sidebar and the active chat share.
 */

/** Titles are generated in the background after a chat's first turn; look again after this. */
export const TITLE_RETRY_MS = 3000

type ChatList = {
  chats: ChatSummaryJson[]
  loading: boolean
  error: Error | undefined
  /** Re-fetches now, and again shortly after, in case a title is still being generated. */
  refresh: () => void
}

type ShoppingContextValue = { client: ApiClient, chatList: ChatList }

const ShoppingContext = createContext<ShoppingContextValue | undefined>(undefined)

export function ShoppingProvider({ config, children }: { config: ShoppingConfig, children: ReactNode }) {
  // Built once: a host that changes config remounts the provider (e.g. with a `key`).
  const [client] = useState(() => createApiClient(config))
  const [chats, setChats] = useState<ChatSummaryJson[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error>()
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined)

  const load = useCallback(async () => {
    try {
      setChats(await client.listChats())
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }, [client])

  const refresh = useCallback(() => {
    void load()
    clearTimeout(retry.current)
    retry.current = setTimeout(() => void load(), TITLE_RETRY_MS)
  }, [load])

  useEffect(() => {
    void load()
    return () => clearTimeout(retry.current)
  }, [load])

  const value = useMemo(() => ({ client, chatList: { chats, loading, error, refresh } }), [client, chats, loading, error, refresh])

  return <ShoppingContext.Provider value={value}>{children}</ShoppingContext.Provider>
}

function useShoppingContext() {
  const value = useContext(ShoppingContext)
  if (!value) throw new Error('useShopping* hooks must be used inside <ShoppingProvider>')
  return value
}

export const useApiClient = () => useShoppingContext().client

/** The user's chats, newest activity first. */
export const useChatList = () => useShoppingContext().chatList
