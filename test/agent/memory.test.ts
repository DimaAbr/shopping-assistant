import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { UIMessage } from 'ai'

import { buildMemoryPrompt, extractMemories, MAX_TASK, normalizeChanges, type MemoryChanges } from '../../src/agent/memory.ts'
import type { Memory } from '../../src/store/types.ts'
import { generatedText } from '../helpers/mock-model.ts'

const current: Memory[] = [
  { id: 'db-1', scope: 'user', subject: 'self', text: 'Is a man' },
  { id: 'db-2', scope: 'chat', subject: 'wife', text: 'Budget $100' },
]

const noChanges: MemoryChanges = { add: [], update: [], remove: [] }

const turn: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'a gift for my wife, she loves gold' }] },
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Here are some ideas.' }] },
]

describe('memory extraction', () => {
  it('shows the model short ids and the latest exchange', () => {
    const prompt = buildMemoryPrompt(current, 'user: hi')
    expect(prompt).toContain('m1 (lasting, about: self) Is a man')
    expect(prompt).toContain('m2 (task, about: wife) Budget $100')
    expect(prompt).not.toContain('db-1')
    expect(prompt).toContain('<latest_exchange>\nuser: hi\n</latest_exchange>')
    expect(buildMemoryPrompt([], 'user: hi')).toContain('(none yet)')
  })

  it('maps short ids back to stored ids', async () => {
    const changes: MemoryChanges = {
      add: [{ scope: 'lasting', about: 'Wife', text: 'Loves gold jewellery' }],
      update: [{ id: 'm2', text: 'Budget $150' }],
      remove: [],
    }
    const model = new MockLanguageModelV4({ doGenerate: generatedText(JSON.stringify(changes)) })

    const ops = await extractMemories({ model, current, newMessages: turn })
    expect(ops).toEqual([
      { op: 'update', id: 'db-2', text: 'Budget $150' },
      { op: 'add', scope: 'user', subject: 'wife', text: 'Loves gold jewellery' },
    ])
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('she loves gold')
  })

  it('skips the model call when the messages have no text', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generatedText(JSON.stringify(noChanges)) })
    const toolOnly: UIMessage[] = [{ id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }] }]

    expect(await extractMemories({ model, current, newMessages: toolOnly })).toEqual([])
    expect(model.doGenerateCalls).toEqual([])
  })

  it('drops unknown ids, empty texts, duplicates and no-op updates; remove wins over update', () => {
    expect(normalizeChanges({
      add: [
        { scope: 'lasting', about: 'self', text: 'is a man' },
        { scope: 'task', about: 'me', text: '  ' },
        { scope: 'task', about: 'my son', text: 'Turns 8 next week' },
        { scope: 'task', about: 'son', text: 'Turns 8 next week' },
      ],
      update: [{ id: 'm9', text: 'x' }, { id: 'm1', text: 'Is a man' }, { id: 'M2', text: 'Budget $50' }],
      remove: ['m2', 'm7'],
    }, current)).toEqual([
      { op: 'remove', id: 'db-2' },
      { op: 'add', scope: 'chat', subject: 'son', text: 'Turns 8 next week' },
    ])
  })

  it('normalizes who a note is about', () => {
    const ops = normalizeChanges({
      ...noChanges,
      add: ['', 'Me', 'the shopper', 'my wife', 'Best Friend'].map((about, i) => ({ scope: 'lasting' as const, about, text: `fact ${i}` })),
    }, [])
    expect(ops.map(op => op.op === 'add' && op.subject)).toEqual(['self', 'self', 'self', 'wife', 'best friend'])
  })

  it('caps the notes per scope, counting the ones removed in the same change', () => {
    const full: Memory[] = Array.from({ length: MAX_TASK }, (_, i) => ({ id: `t${i}`, scope: 'chat', subject: 'self', text: `task ${i}` }))
    const add = [{ scope: 'task' as const, about: 'self', text: 'new 1' }, { scope: 'task' as const, about: 'self', text: 'new 2' }]

    expect(normalizeChanges({ ...noChanges, add }, full)).toEqual([])
    expect(normalizeChanges({ ...noChanges, add, remove: ['m1'] }, full)).toEqual([
      { op: 'remove', id: 't0' },
      { op: 'add', scope: 'chat', subject: 'self', text: 'new 1' },
    ])
  })
})
