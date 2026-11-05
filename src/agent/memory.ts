import { generateText, Output, type LanguageModel, type UIMessage } from 'ai'
import { z } from 'zod'
import type { createStepLogger } from '../observability/step-log.ts'
import { SELF, type Memory, type MemoryOp, type MemoryScope } from '../store/types.ts'
import { transcriptOf } from './summarize.ts'

/**
 * Memory extraction (10, "Memories"): after each turn, a background call reads
 * the new messages and returns changes to the stored facts. A plain function
 * with one structured-output call, like `planSearch`.
 *
 * The model sees the facts under short ids (`m1`, `m2`, …), never database ids.
 * Ops on ids it wasn't given are dropped, and the facts per scope are capped.
 * Only the text of the messages is sent, not tool results.
 */

export const MAX_LASTING = 30
export const MAX_TASK = 10
const MAX_TEXT_LENGTH = 200

export const MEMORY_INSTRUCTIONS = `You keep notes about a shopper for an online store's shopping assistant. You never talk to the shopper.

You get the notes kept so far and the latest exchange between the shopper and the assistant.
Return the changes to the notes: notes to add, to update and to remove. Usually nothing changes: then return three empty lists.

# What to note
Facts that help choose products for the shopper or for the people they shop for:
who they are (age group, gender), their household and the people they buy for, sizes, tastes and style, brands or materials they like or avoid, how they shop (budget habits, what matters to them).
- Only what the shopper said or clearly implied. The assistant's messages are only context: never note a product the assistant showed unless the shopper said they want or like it.
- Never guess. Not gender or age from a name, and nothing about the shopper from what they buy for someone else: buying a dress for a wife says nothing about the shopper's own style or gender.
- One fact per note, in a short plain sentence that makes sense on its own later ("Wears shoe size 43", "Prefers gold jewellery to silver").
- Leave out anything that doesn't help with shopping (health details beyond what they shop for, addresses, contact details).

# about
Who the note is about: "self" for the shopper, otherwise the person as the shopper refers to them, short and lowercase ("wife", "son", "best friend"). Never mix facts about different people in one note.

# scope
- lasting: still true after this shopping task (sizes, household, tastes). Kept across all the shopper's chats.
- task: only about what they're shopping for right now: what they're looking for, for whom, the occasion, budget and deadline.
  When the shopper moves on to something else, remove the old task notes or update them: they don't apply to the new task.

# Changing notes
- update: the new information replaces or refines a note (a new budget, a corrected size). Use its id. A note stays about the same person.
- remove: the shopper contradicts or takes back a note, or a task note no longer applies.
- Don't add what's already noted.`

const SCOPES = { lasting: 'user', task: 'chat' } as const satisfies Record<string, MemoryScope>
const SCOPE_NAMES = { user: 'lasting', chat: 'task' } as const satisfies Record<MemoryScope, keyof typeof SCOPES>

const changesSchema = z.object({
  add: z.array(z.object({
    scope: z.enum(['lasting', 'task']),
    about: z.string().describe('"self" for the shopper, or who the note is about ("wife", "son").'),
    text: z.string(),
  })),
  update: z.array(z.object({
    id: z.string().describe('The note id, e.g. "m2".'),
    text: z.string().describe('The new text of the note.'),
  })),
  remove: z.array(z.string().describe('The note id, e.g. "m2".')),
})

export type MemoryChanges = z.infer<typeof changesSchema>

export async function extractMemories(options: {
  model: LanguageModel
  current: readonly Memory[]
  newMessages: readonly UIMessage[]
  log?: ReturnType<typeof createStepLogger>
  abortSignal?: AbortSignal
}): Promise<MemoryOp[]> {
  const transcript = transcriptOf(options.newMessages)
  if (transcript === '') return []

  const { output } = await generateText({
    model: options.model,
    abortSignal: options.abortSignal,
    instructions: MEMORY_INSTRUCTIONS,
    prompt: buildMemoryPrompt(options.current, transcript),
    output: Output.object({ schema: changesSchema, name: 'note_changes' }),
    ...options.log,
  })

  return normalizeChanges(output, options.current)
}

export function buildMemoryPrompt(current: readonly Memory[], transcript: string): string {
  const notes = current.map((memory, index) => `m${index + 1} (${SCOPE_NAMES[memory.scope]}, about: ${memory.subject}) ${memory.text}`)
  return `<notes>\n${notes.join('\n') || '(none yet)'}\n</notes>\n\n<latest_exchange>\n${transcript}\n</latest_exchange>`
}

/**
 * Maps short ids back, drops ops on unknown ids, empty texts and notes that are
 * already there, and caps the notes per scope. A note that is both updated and
 * removed is removed.
 */
export function normalizeChanges(changes: MemoryChanges, current: readonly Memory[]): MemoryOp[] {
  const byShortId = new Map(current.map((memory, index) => [`m${index + 1}`, memory]))
  const resolve = (shortId: string) => byShortId.get(shortId.trim().toLowerCase())

  const removed = new Set(changes.remove.flatMap(id => resolve(id)?.id ?? []))
  const ops: MemoryOp[] = [...removed].map(id => ({ op: 'remove', id }))

  const updated = new Set<string>()
  for (const change of changes.update) {
    const memory = resolve(change.id)
    const text = cleanText(change.text)
    if (
      memory === undefined ||
      removed.has(memory.id) ||
      updated.has(memory.id) ||
      text === '' ||
      text === memory.text
    ) continue

    updated.add(memory.id)
    ops.push({ op: 'update', id: memory.id, text })
  }

  const room: Record<MemoryScope, number> = { user: MAX_LASTING, chat: MAX_TASK }
  for (const memory of current)
    if (!removed.has(memory.id)) room[memory.scope] -= 1

  const known = new Set(current.map(memory => key(memory.subject, memory.text)))
  for (const change of changes.add) {
    const scope = SCOPES[change.scope]
    const subject = cleanSubject(change.about)
    const text = cleanText(change.text)
    if (text === '' || room[scope] <= 0 || known.has(key(subject, text))) continue
    
    known.add(key(subject, text))
    room[scope] -= 1
    ops.push({ op: 'add', scope, subject, text })
  }

  return ops
}

function cleanText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT_LENGTH)
}

function cleanSubject(about: string): string {
  const subject = about.trim().toLowerCase().replace(/^(my|the shopper'?s|their)\s+/, '')
  return subject === '' || ['self', 'me', 'myself', 'user', 'shopper', 'the shopper'].includes(subject) ? SELF : subject
}

function key(subject: string, text: string) {
  return `${subject}\n${text.toLowerCase()}`
}
