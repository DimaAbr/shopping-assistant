import { describe, expect, it } from 'vitest'

import { catalog, REQUIRED, runCase, TRIALS, type Check } from './harness.ts'
import * as c from './checks.ts'

/**
 * Phase 2 golden set (05, "Evals"). Each case runs TRIALS times and must pass ≥ 80%.
 * Grounding checks run on every case.
 */

const grounding: Check[] = [c.groundedProducts(catalog), c.groundedPrices]

function evalCase(name: string, userTurns: string[], checks: Check[]) {
  it(name, async () => {
    const passes = await runCase(name, userTurns, [...checks, ...grounding])
    console.log(`[${name}] ${passes}/${TRIALS}`)
    expect(passes).toBeGreaterThanOrEqual(REQUIRED)
  })
}

const VAGUE: Array<{ prompt: string, plausible: string[] }> = [
  {
    prompt: 'I need a gift for my wife',
    plausible: ['womens-jewellery', 'fragrances', 'beauty', 'skin-care', 'womens-bags', 'womens-watches', 'womens-dresses', 'womens-shoes']
  },
  {
    prompt: "I'm throwing a party",
    plausible: ['groceries', 'home-decoration', 'kitchen-accessories', 'womens-dresses', 'tops', 'mens-shirts']
  },
  {
    prompt: "My son's starting school",
    plausible: ['laptops', 'tablets', 'mobile-accessories', 'smartphones', 'mens-shirts', 'mens-shoes', 'sports-accessories']
  },
  {
    prompt: 'I just moved into a new apartment',
    plausible: ['furniture', 'home-decoration', 'kitchen-accessories']
  },
  {
    prompt: 'Going on a beach holiday next week',
    plausible: ['sunglasses', 'skin-care', 'womens-bags', 'tops', 'womens-dresses', 'mens-shoes', 'womens-shoes']
  },
  {
    prompt: 'I want to start working out',
    plausible: ['sports-accessories', 'mens-shoes', 'womens-shoes', 'mens-watches', 'womens-watches', 'tops']
  },
]

const NOT_FOUND = /\b(don'?t|do not|doesn'?t|does not|couldn'?t|could not|can'?t|cannot|didn'?t|did not)\b[^.?!]*\b(have|find|carry|sell|stock|see|match|found)\b|\bno (results|matches|products)\b|\bnot (find|found|available)\b|\bsorry\b/i

describe('phase 2 golden set', () => {
  evalCase('small talk', ['hi, how are you?'], [c.noToolCall])

  evalCase(
    'direct request',
    ['show me some lipstick'],
    [
      c.calledEither(
        call =>
          (call.toolName === 'searchProducts' && /lipstick/i.test(String(call.input.query))) ||
          (call.toolName === 'browseCategory' && call.input.category === 'beauty'),
        'searchProducts(/lipstick/) or browseCategory(beauty)'
      ),
      c.replyMatches(/red lipstick/i),
    ]
  )

  for (const { prompt, plausible } of VAGUE) {
    evalCase(
      `vague: ${prompt}`,
      [prompt],
      [
        c.noToolCall,
        c.asksAQuestion,
        c.suggestsCategories(plausible)
      ]
    )
  }

  evalCase(
    'vague, still vague',
    ['I need a gift for my wife', 'not sure, surprise me'],
    [c.browsedPlausible(VAGUE[0]!.plausible)]
  )

  evalCase(
    'no results: phone model',
    ['do you have the Google Pixel?'],
    [c.someToolCall, c.replyMatches(NOT_FOUND, 'a not-found statement')]
  )
  evalCase(
    'no results: appliance',
    ['I want an air fryer'],
    [c.someToolCall, c.replyMatches(NOT_FOUND, 'a not-found statement')]
  )

  evalCase(
    'out of catalog',
    ['do you sell books?'],
    [
      c.replyMatches(
        /\b(don'?t|do not|doesn'?t|does not)\b[^.?!]*\b(carry|sell|have|stock|offer)\b/i,
        'a "we don\'t carry it" statement'
      )
    ]
  )

  evalCase(
    'missing information: warranty',
    ['show me smartphones', 'does the first one have a warranty?'],
    [
      c.replyMatches(
        /\b(don'?t|do not|doesn'?t|does not)\b[^.?!]*\b(have|include|list|show)\b|\bno (warranty )?(information|details|info)\b|\bnot (available|listed|included)\b/i,
        'a "no information" statement'
      ),
      c.replyDoesNotMatch(
        /\b\d+[- ](year|month|week|day)s?\b|\blifetime\b/i,
        'a stated warranty term'
      ),
    ]
  )
})
