import { describe, expect, it } from 'vitest'

import { catalog, REQUIRED, runCase, TRIALS, type Check } from './harness.ts'
import * as c from './checks.ts'

/**
 * Golden set: phase 2 (05, "Evals") plus the search cases from 09.
 * Each case runs TRIALS times and must pass ≥ 80%. Grounding checks run on every case.
 */

const grounding: Check[] = [c.groundedProducts(catalog), c.groundedPrices, c.inStockOnly(catalog)]

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

const NOT_FOUND = /\b(don'?t|do not|doesn'?t|does not|couldn'?t|could not|can'?t|cannot|didn'?t|did not)\b[^.?!]*\b(have|find|carry|sell|stock|see|match|found)\b|\bno (results|matches|products)\b|\b(nothing|no)\b[^.?!]*\b(matched|found)\b|\bnot (find|found|available)\b|\bsorry\b/i

describe('phase 2 golden set', () => {
  evalCase('small talk', ['hi, how are you?'], [c.noToolCall])

  evalCase(
    'direct request',
    ['show me some lipstick'],
    [c.oneSearch, c.returnedTitle(/lipstick/i), c.noProductListing]
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
    [c.oneSearch, c.returnedPlausible(VAGUE[0]!.plausible), c.noProductListing]
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

describe('search golden set (09)', () => {
  evalCase(
    'multi-need: workout accessories and shoes',
    ["I'm a guy and I want to start working out", "I'm looking for some accessories and shoes"],
    [
      c.oneSearch,
      c.returnedGroups(2),
      c.returnedPlausible(['sports-accessories', 'mens-shoes', 'mens-watches']),
      c.returnedNoneFrom(['womens-shoes', 'tops']),
      c.noProductListing,
    ]
  )

  evalCase(
    'budget',
    ["show me men's shoes under $100"],
    [c.oneSearch, c.returnedPlausible(['mens-shoes']), c.pricesAtMost(100), c.noProductListing]
  )

  evalCase(
    'budget refinement',
    ["show me men's shoes", 'something cheaper please'],
    [c.oneSearch, c.returnedPlausible(['mens-shoes']), c.pricesAtMost(119.99)]
  )

  // There are no boys' clothes. Saying so without a search is fine; offering tops or dresses isn't.
  evalCase(
    'category confusion: clothes for a boy',
    ["My son's starting school, show me some clothes for him"],
    [
      c.returnedNoneFrom(['tops', 'womens-dresses']),
      c.replyDoesNotMatch(/\b(here are|here's|take a look|check out)\b[^.?!]*\b(tops?|dress(es)?|frocks?)\b/i, 'tops or dresses offered'),
    ]
  )

  evalCase(
    'shipping deadline',
    ["I need men's running shoes for a race this weekend, they have to arrive within 2 days"],
    [c.oneSearch, c.returnedPlausible(['mens-shoes']), c.shipsWithin(/overnight|1-2 business days/i, 'within 2 days')]
  )

  evalCase(
    'shipping question',
    ['show me sunglasses', 'how soon would the first one ship?'],
    [
      c.replyMatches(/\bships?\b[^.?!]*\b(overnight|\d+(-\d+)? (business )?(days?|weeks?|months?))\b/i, 'a shipping time'),
      c.replyDoesNotMatch(/\b(don'?t|do not) have\b[^.?!]*\b(shipping|information)\b/i, 'a "no shipping info" statement'),
    ]
  )
})
