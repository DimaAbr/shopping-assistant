import { useCallback, useEffect, useState } from 'react'

import { useApiClient } from '../core/index.ts'
import { Sidebar } from './Sidebar.tsx'
import { ChatView } from './Thread.tsx'
import styles from './App.module.css'

const sidebarId = 'chat-list'

/**
 * The standalone page: the chat list and the active chat. The active chat id is
 * in the URL hash, so a reload reopens it. A new chat's id is generated here;
 * the server stores the chat with its first turn (07, "Chat ids").
 * On narrow screens the chat list is a drawer behind a menu button.
 */
export function App() {
  const client = useApiClient()
  const [chatId, setChatId] = useState(() => chatIdFromHash() ?? client.newChatId())
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (chatIdFromHash() !== chatId) history.replaceState(null, '', `#${chatId}`)
  }, [chatId])

  useEffect(() => {
    const onHashChange = () => setChatId(chatIdFromHash() ?? client.newChatId())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [client])

  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  const selectChat = useCallback((id: string) => {
    setChatId(id)
    setMenuOpen(false)
  }, [])

  const newChat = useCallback(() => {
    setChatId(client.newChatId())
    setMenuOpen(false)
  }, [client])

  return (
    <div className={styles.app}>
      <Sidebar id={sidebarId} open={menuOpen} activeChatId={chatId} onSelect={selectChat} onNewChat={newChat} />
      {menuOpen && (
        <button type="button" className={styles.backdrop} aria-label="Close chats" onClick={() => setMenuOpen(false)} />
      )}
      <main className={styles.main}>
        <header className={styles.topBar}>
          <button
            type="button"
            className={styles.menuButton}
            aria-label="Chats"
            aria-expanded={menuOpen}
            aria-controls={sidebarId}
            onClick={() => setMenuOpen(open => !open)}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <ChatView chatId={chatId} />
      </main>
    </div>
  )
}

function chatIdFromHash(): string | undefined {
  const id = decodeURIComponent(location.hash.slice(1))
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined
}
