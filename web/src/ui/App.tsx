import { useCallback, useEffect, useState } from 'react'

import { useApiClient } from '../core/index.ts'
import { Sidebar } from './Sidebar.tsx'
import { ChatView } from './Thread.tsx'
import styles from './App.module.css'

/**
 * The standalone page: the chat list and the active chat. The active chat id is
 * in the URL hash, so a reload reopens it. A new chat's id is generated here;
 * the server stores the chat with its first turn (07, "Chat ids").
 */
export function App() {
  const client = useApiClient()
  const [chatId, setChatId] = useState(() => chatIdFromHash() ?? client.newChatId())

  useEffect(() => {
    if (chatIdFromHash() !== chatId) history.replaceState(null, '', `#${chatId}`)
  }, [chatId])

  useEffect(() => {
    const onHashChange = () => setChatId(chatIdFromHash() ?? client.newChatId())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [client])

  const newChat = useCallback(() => setChatId(client.newChatId()), [client])

  return (
    <div className={styles.app}>
      <Sidebar activeChatId={chatId} onSelect={setChatId} onNewChat={newChat} />
      <main className={styles.main}>
        <ChatView chatId={chatId} />
      </main>
    </div>
  )
}

function chatIdFromHash(): string | undefined {
  const id = decodeURIComponent(location.hash.slice(1))
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined
}
