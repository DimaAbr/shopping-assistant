import type { ChatSummary } from '../../store/chat-store.ts'

/**
 * REPL input parsing (06 "CLI"). Pure, so it's unit-testable.
 *
 * A line starting with `/` + a letter is a command; anything else is a message.
 */

export type Command =
  | { kind: 'empty' }
  | { kind: 'message', text: string }
  | { kind: 'exit' }
  | { kind: 'help' }
  | { kind: 'new' }
  | { kind: 'sessions' }
  | { kind: 'switch', ref: string }
  | { kind: 'unknown', name: string }

export const HELP = '/sessions to list chats · /sessions <n|id> to switch · /new for a new chat · /exit to quit'

export function parseCommand(raw: string): Command {
  const line = raw.trim()
  if (line === '') return { kind: 'empty' }
  if (!/^\/[a-z]/i.test(line)) return { kind: 'message', text: line }

  const [name = '', ...args] = line.slice(1).split(/\s+/)
  const arg = args.join(' ')

  switch (name.toLowerCase()) {
    case 'exit':
    case 'quit':     return { kind: 'exit' }
    case 'help':     return { kind: 'help' }
    case 'new':      return { kind: 'new' }
    case 'sessions': return arg === '' ? { kind: 'sessions' } : { kind: 'switch', ref: arg }
    default:         return { kind: 'unknown', name }
  }
}

/**
 * Finds a chat by its 1-based position in the list, or by a unique id prefix.
 * Returns an error message instead of throwing.
 */
export function resolveChatRef(ref: string, chats: readonly ChatSummary[]): ChatSummary | { error: string } {
  if (/^\d+$/.test(ref)) {
    const chat = chats[Number(ref) - 1]
    return chat ?? { error: `no chat #${ref} — there ${chats.length === 1 ? 'is 1 chat' : `are ${chats.length} chats`}` }
  }

  const matches = chats.filter(chat => chat.id.startsWith(ref))
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) return { error: `no chat with id ${ref}…` }
  return { error: `${matches.length} chats start with ${ref} — use more characters or the number` }
}
