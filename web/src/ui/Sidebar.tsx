import { useChatList } from '../core/index.ts'
import styles from './Sidebar.module.css'

/**
 * The user's chats. Our own, not assistant-ui's thread list: the core owns the list (08).
 * `open` only matters on narrow screens, where the list is a drawer.
 */
export function Sidebar({ id, open, activeChatId, onSelect, onNewChat }: {
  id: string
  open: boolean
  activeChatId: string
  onSelect: (chatId: string) => void
  onNewChat: () => void
}) {
  const { chats, loading, error } = useChatList()

  return (
    <nav id={id} className={styles.sidebar} aria-label="Chats" data-open={open || undefined}>
      <div className={styles.header}>
        <button type="button" className={`${styles.item} ${styles.newChat}`} onClick={onNewChat}>+ New chat</button>
      </div>

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
