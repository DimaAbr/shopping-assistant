import { generateText, type LanguageModel, type UIMessage } from 'ai'

/**
 * Summarizes a conversation with the `summarizer` model role (02 §2).
 *
 * A plain function, not a model tool. Only the text of user and assistant
 * messages is sent: tool calls and results (product payloads) are left out,
 * which keeps the call small and the summary about the conversation itself.
 *
 * The only purpose is a chat title. There is no context compaction: long chats
 * use a recent window plus memories instead (10).
 */

export type SummaryPurpose = 'title'

export const TITLE_MAX_LENGTH = 60

const INSTRUCTIONS: Record<SummaryPurpose, string> = {
  title: `Write a short title for this shopping conversation, as it would appear in a chat list.
- 2 to 6 words, in the language of the conversation. Sentence case.
- Say what the user is shopping for or asking about (e.g. "Gift ideas for wife", "Budget smartphones").
- No quotes, no trailing punctuation, no emoji. Reply with the title only.`,
}

export async function summarizeChat(options: {
  model: LanguageModel
  messages: readonly UIMessage[]
  purpose: SummaryPurpose
}): Promise<string> {
  const transcript = transcriptOf(options.messages)
  if (transcript === '') throw new Error('nothing to summarize: no text in the messages')

  const { text } = await generateText({
    model: options.model,
    instructions: INSTRUCTIONS[options.purpose],
    prompt: `<conversation>\n${transcript}\n</conversation>`,
  })

  const title = cleanTitle(text)
  if (title === '') throw new Error('the summarizer returned an empty title')
  return title
}

/** `user: …` / `assistant: …` lines from the text parts only. */
export function transcriptOf(messages: readonly UIMessage[]): string {
  return messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => {
      const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join(' ').trim()
      return text === '' ? undefined : `${message.role}: ${text}`
    })
    .filter(line => line !== undefined)
    .join('\n')
}

/** First line, no wrapping quotes / "Title:" prefix / trailing punctuation, capped in length. */
export function cleanTitle(raw: string): string {
  let title = firstLine(raw)
    .trim()
    .replace(/^title\s*:\s*/i, '')

  // Wrapping quotes/markdown and trailing punctuation can nest either way ("**Title**!", "“Title.”").
  for (let previous = ''; previous !== title;) {
    previous = title
    title = title
      .replace(/^["'“”‘’`*]+|["'“”‘’`*]+$/g, '')
      .replace(/[.!?,;:]+$/, '')
      .trim()
  }

  if (title.length > TITLE_MAX_LENGTH)
    title = title.slice(0, TITLE_MAX_LENGTH - 1).trimEnd() + '…'

  return title
}

function firstLine(raw: string) {
  return raw.trim().split('\n')[0] ?? ''
}

