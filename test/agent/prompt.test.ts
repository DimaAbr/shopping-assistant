import { describe, expect, it } from 'vitest'

import { buildInstructions, renderMemories } from '../../src/agent/prompt.ts'
import type { Memory } from '../../src/store/types.ts'
import { categories } from '../helpers/fake-repository.ts'

describe('instructions', () => {
  it('lists every category slug it is given', () => {
    const instructions = buildInstructions(categories)
    for (const slug of categories) expect(instructions).toContain(`- ${slug}\n`)
  })

  it('only lists the categories it is given', () => {
    const instructions = buildInstructions(['beauty'])
    expect(instructions).toContain('- beauty')
    expect(instructions).not.toContain('- smartphones')
  })
})

describe('instructions: memories', () => {
  const memories: Memory[] = [
    { id: '1', scope: 'user', subject: 'self', text: 'Is a man' },
    { id: '2', scope: 'user', subject: 'wife', text: 'Likes gold jewellery' },
    { id: '3', scope: 'chat', subject: 'wife', text: 'Birthday gift, budget $100' },
  ]

  it('renders lasting and task memories, tagged with who they are about', () => {
    const lines = renderMemories(memories).split('\n')
    expect(lines[0]).toBe('# What you know about the user')
    expect(lines.slice(3)).toEqual([
      '## Lasting',
      '- [the user] Is a man',
      '- [wife] Likes gold jewellery',
      '## Current shopping task',
      '- [wife] Birthday gift, budget $100',
    ])
  })

  it('leaves out empty sections, and the whole block without memories', () => {
    expect(renderMemories([memories[2]!])).not.toContain('## Lasting')
    expect(renderMemories([])).toBe('')
    expect(buildInstructions(categories)).not.toContain('# What you know about the user')
    expect(buildInstructions(categories, memories).endsWith(renderMemories(memories))).toBe(true)
  })
})
