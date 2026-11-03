import { describe, expect, it } from 'vitest'

import { buildInstructions } from '../../src/agent/prompt.ts'
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
