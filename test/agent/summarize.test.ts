import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { UIMessage } from 'ai'

import { cleanTitle, summarizeChat, TITLE_MAX_LENGTH } from '../../src/agent/summarize.ts'
import { lipstick } from '../helpers/fake-repository.ts'
import { generatedText } from '../helpers/mock-model.ts'

const exchange: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'show me lipstick' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'step-start' },
      {
        type: 'tool-searchProducts',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { query: 'lipstick' },
        output: { status: 'ok', total: lipstick.total, products: lipstick.products },
      },
      { type: 'step-start' },
      { type: 'text', text: 'Red Lipstick — $12.99', state: 'done' },
    ],
  },
]

describe('summarizeChat (title)', () => {
  it('returns a cleaned title from the summarizer model', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generatedText('"Lipstick shopping."\n') })
    expect(await summarizeChat({ model, messages: exchange, purpose: 'title' })).toBe('Lipstick shopping')
  })

  it('sends only the conversation text, not tool payloads', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generatedText('Lipstick') })
    await summarizeChat({ model, messages: exchange, purpose: 'title' })

    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt)
    expect(prompt).toContain('user: show me lipstick')
    expect(prompt).toContain('assistant: Red Lipstick — $12.99')
    expect(prompt).not.toContain('thumbnail')
    expect(prompt).not.toContain('searchProducts')
    expect(model.doGenerateCalls[0]!.tools).toBeUndefined()
  })

  it('rejects when there is no text, or the model returns none', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generatedText('  ') })
    await expect(summarizeChat({ model, messages: [], purpose: 'title' })).rejects.toThrow('nothing to summarize')
    await expect(summarizeChat({ model, messages: exchange, purpose: 'title' })).rejects.toThrow('empty title')
  })
})

describe('cleanTitle', () => {
  it.each([
    ['Budget smartphones',            'Budget smartphones'],
    ['Title: Gift ideas for wife',    'Gift ideas for wife'],
    ['“Beach holiday essentials”',    'Beach holiday essentials'],
    ['**Party supplies**!',           'Party supplies'],
    ['Phones\nand some more text',    'Phones'],
  ])('%j → %j', (raw, expected) => {
    expect(cleanTitle(raw)).toBe(expected)
  })

  it('caps the length', () => {
    const title = cleanTitle('word '.repeat(40))
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH)
    expect(title.endsWith('…')).toBe(true)
  })
})
