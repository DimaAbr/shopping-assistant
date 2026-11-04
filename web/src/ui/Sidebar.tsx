import { useChatList } from '../core/index.ts'
import styles from './Sidebar.module.css'

/** The user's chats. Our own, not assistant-ui's thread list: the core owns the list (08). */
export function Sidebar({ activeChatId, onSelect, onNewChat }: {
  activeChatId: string
  onSelect: (chatId: string) => void
  onNewChat: () => void
}) {
  const { chats, loading, error } = useChatList()

  return (
    <nav className={styles.sidebar} aria-label="Chats">
      <button type="button" className={styles.newChat} onClick={onNewChat}>+ New chat</button>

      {error && <p className={styles.error} role="alert">Couldn't load chats: {error.message}</p>}
      {!loading && !error && chats.length === 0 && <p className={styles.empty}>No chats yet.</p>}

      <ul className={styles.list}>
        {chats.map(chat => (
          <li key={chat.id}>
            <button
              type="button"
              className={styles.item}
              aria-current={chat.id === activeChatId ? 'page' : undefined}
              onClick={() => onSelect(chat.id)}
              title={chat.title ?? chat.firstText ?? undefined}
            >
              {chat.title ?? chat.firstText ?? 'Untitled chat'}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
