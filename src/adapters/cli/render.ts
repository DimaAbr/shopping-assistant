import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import type { ShoppingToolResult } from '../../agent/tools.ts'
import type { ChatSummary } from '../../store/chat-store.ts'

/** Console output formatting. Pure: returns strings, never writes. */

export const dim = (text: string) => `\x1b[2m${text}\x1b[0m`

/** A dim one-liner per tool call, so replies can be checked against what the tools returned. */
export function traceLine(toolName: string, input: unknown, rawOutput: unknown) {
  // findProducts returns a ShoppingToolResult; `undefined` means the tool threw.
  const output = rawOutput as ShoppingToolResult | undefined

  return dim(`· ${toolName} ${JSON.stringify(input)} → ${outcomeOf(output)}`)
}

/** `Shoes: #1 #2 · Accessories: #3 · unmet: Tops` */
function outcomeOf(output: ShoppingToolResult | undefined): string {
  if (output === undefined) return 'error'
  if (output.status === 'catalog_unavailable') return output.status

  const parts = output.status === 'ok'
    ? output.groups.map(group => `${group.label}: ${group.products.map(p => `#${p.id}`).join(' ')}`)
    : [output.status]

  if (output.unmet.length > 0)
    parts.push(`unmet: ${output.unmet.join(', ')}`)

  return parts.join(' · ')
}

export function chatLabel(chat: ChatSummary, maxLength = 50): string {
  const label = chat.title ?? chat.firstText ?? '(empty chat)'
  return label.length > maxLength
    ? label.slice(0, maxLength - 1) + '…'
    : label
}

/** The numbered `/sessions` list; `*` marks the current chat. */
export function formatChatList(chats: readonly ChatSummary[], currentId: string | undefined, now = new Date()): string {
  if (chats.length === 0) return dim('no saved chats yet — a chat is saved after its first reply')

  const width = String(chats.length).length
  return chats
    .map((chat, i) => {
      const marker = chat.id === currentId ? '*' : ' '
      const number = String(i + 1).padStart(width)
      const label = chat.title === null ? dim(chatLabel(chat)) : chatLabel(chat)
      return `${marker} ${number}. ${label}  ${dim(`${relativeTime(chat.updatedAt, now)} · ${chat.id.slice(0, 8)}`)}`
    })
    .join('\n')
}

/** The tail of a chat, as it looked live: user/assistant text plus trace lines for tool calls. */
export function formatReplay(messages: readonly UIMessage[], maxMessages = 6): string {
  const shown = messages.slice(-maxMessages)
  const lines: string[] = []
  if (shown.length < messages.length)
    lines.push(dim(`… ${messages.length - shown.length} earlier messages`))

  for (const message of shown) {
    if (message.role === 'user') {
      lines.push(`you> ${textOf(message)}`)
      continue
    }

    const out: string[] = []
    for (const part of message.parts) {
      if (part.type === 'text') {
        out.push(part.text)
      } else if (isToolUIPart(part)) {
        const output = part.state === 'output-available' ? part.output : undefined
        out.push(`\n${traceLine(getToolName(part), part.input, output)}\n`)
      }
    }
    lines.push(`assistant> ${out.join('').trim()}`)
  }
  return lines.join('\n')
}

export function relativeTime(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000))
  if (seconds < 60)         return 'just now'
  if (seconds < 3600)       return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400)     return `${Math.floor(seconds / 3600)} h ago`
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)} d ago`
  return then.toISOString().slice(0, 10)
}

function textOf(message: UIMessage) {
  return message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join(' ').trim()
}
