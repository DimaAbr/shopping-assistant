import type { Check, TurnRecord } from './harness.ts'

/** Code-based checks (02 §11). Each returns `undefined` on success, or a reason. */

type CatalogEntry = { id: number, title: string, price: number }

const lastTurn = (turns: TurnRecord[]) => turns.at(-1)!

/** Models write typographic apostrophes (don’t); the patterns use plain ones. */
const normalize = (text: string) => text.replace(/[\u2018\u2019]/g, "'")
const lastReply = (turns: TurnRecord[]) => normalize(lastTurn(turns).reply)

function returnedProducts(turns: TurnRecord[]) {
  return turns.flatMap(turn => turn.results.flatMap(result => result.status === 'ok' ? result.products : []))
}

// ── tool use ────────────────────────────────────────────────────────────────

export const noToolCall: Check = turns => lastTurn(turns).toolCalls.length === 0
  ? undefined
  : `expected no tool call, got ${JSON.stringify(lastTurn(turns).toolCalls)}`

export const someToolCall: Check = turns => lastTurn(turns).toolCalls.length > 0
  ? undefined
  : 'expected a tool call'

export function calledEither(accept: (call: { toolName: string, input: Record<string, unknown> }) => boolean, label: string): Check {
  return turns => lastTurn(turns).toolCalls.some(accept)
    ? undefined
    : `expected ${label}, got ${JSON.stringify(lastTurn(turns).toolCalls)}`
}

/** Browsed 1–3 categories, all from the plausible set. */
export function browsedPlausible(plausible: readonly string[]): Check {
  return turns => {
    const browsed = lastTurn(turns).toolCalls
      .filter(call => call.toolName === 'browseCategory')
      .map(call => String(call.input.category))
    if (browsed.length < 1 || browsed.length > 3) return `expected 1–3 browseCategory calls, got ${JSON.stringify(browsed)}`

    const odd = browsed.filter(slug => !plausible.includes(slug))
    return odd.length === 0
      ? undefined
      : `browsed implausible categories ${JSON.stringify(odd)}`
  }
}

// ── reply content ───────────────────────────────────────────────────────────

export function replyMatches(pattern: RegExp, label = String(pattern)): Check {
  return turns => pattern.test(lastReply(turns))
    ? undefined
    : `reply doesn't match ${label}`
}

export function replyDoesNotMatch(pattern: RegExp, label = String(pattern)): Check {
  return turns => pattern.test(lastReply(turns))
    ? `reply matches forbidden ${label}`
    : undefined
}

export const asksAQuestion: Check = replyMatches(/\?/, 'a question mark')

/**
 * How a reply refers to each category in plain words. Some words cover several
 * slugs ("watches" → mens- and womens-watches); a mention counts as plausible
 * if any of its slugs is in the case's plausible set.
 */
const CATEGORY_WORDS: Array<{ pattern: RegExp, slugs: string[] }> = [
  { pattern: /\b(beauty|make-?up|cosmetics?|mascara|lipsticks?)\b/i,                     slugs: ['beauty'] },
  { pattern: /\b(fragrances?|perfumes?|colognes?)\b/i,                                   slugs: ['fragrances'] },
  { pattern: /\bfurniture\b/i,                                                           slugs: ['furniture'] },
  { pattern: /\b(groceries|grocery|snacks?|drinks?|food)\b/i,                            slugs: ['groceries'] },
  { pattern: /\b(home[- ]?d[eé]cor(ation)?s?|decorations?|d[eé]cor)\b/i,                 slugs: ['home-decoration'] },
  { pattern: /\b(kitchen|cookware)\b/i,                                                  slugs: ['kitchen-accessories'] },
  { pattern: /\blaptops?\b/i,                                                            slugs: ['laptops'] },
  { pattern: /\bshirts?\b/i,                                                             slugs: ['mens-shirts'] },
  { pattern: /\b(shoes|sneakers|trainers|footwear)\b/i,                                  slugs: ['mens-shoes', 'womens-shoes'] },
  { pattern: /\bwatch(es)?\b/i,                                                          slugs: ['mens-watches', 'womens-watches'] },
  { pattern: /\b(phone accessories|mobile accessories|headphones|earbuds|chargers?)\b/i, slugs: ['mobile-accessories'] },
  { pattern: /\bmotorcycles?\b/i,                                                        slugs: ['motorcycle'] },
  { pattern: /\b(skin[- ]?care|sunscreen|moisturi[sz]ers?)\b/i,                          slugs: ['skin-care'] },
  { pattern: /\b(smart)?phones?\b(?! accessor)/i,                                        slugs: ['smartphones'] },
  { pattern: /\b(sports?|fitness|gym)\b/i,                                               slugs: ['sports-accessories'] },
  { pattern: /\bsunglasses\b/i,                                                          slugs: ['sunglasses'] },
  { pattern: /\b(tablets?|ipads?)\b/i,                                                   slugs: ['tablets'] },
  { pattern: /\b(tops?|blouses?)\b/i,                                                    slugs: ['tops'] },
  { pattern: /\b(vehicles?|cars?)\b/i,                                                   slugs: ['vehicle'] },
  { pattern: /\b(bags?|handbags?|purses?|totes?)\b/i,                                    slugs: ['womens-bags'] },
  { pattern: /\bdress(es)?\b/i,                                                          slugs: ['womens-dresses'] },
  { pattern: /\b(jewell?ery|necklaces?|earrings?|bracelets?)\b/i,                        slugs: ['womens-jewellery'] },
]

/**
 * The reply suggests ≥ `min` plausible categories and no implausible ones.
 * Limitation: a suggestion that matches no category word at all (e.g. an
 * invented "swimwear") isn't caught here — check failures by hand.
 */
export function suggestsCategories(plausible: readonly string[], min = 2): Check {
  return turns => {
    const reply = lastReply(turns)
    const mentioned = CATEGORY_WORDS.filter(({ pattern }) => pattern.test(reply))
    const good = mentioned.filter(({ slugs }) => slugs.some(slug => plausible.includes(slug)))
    const bad = mentioned.filter(({ slugs }) => !slugs.some(slug => plausible.includes(slug)))
    if (bad.length > 0)   return `suggested implausible categories ${JSON.stringify(bad.map(b => b.slugs.join('|')))}`
    if (good.length < min) return `suggested ${good.length} plausible categories, wanted ≥ ${min}`
    return undefined
  }
}

// ── grounding ───────────────────────────────────────────────────────────────

/**
 * Every catalog product named in any reply was returned by a tool in this conversation.
 * Single-word titles ("Sunglasses", "Apple", "Water") are skipped — they can't be
 * told apart from ordinary words. `groundedPrices` still catches invented prices.
 */
export function groundedProducts(catalog: readonly CatalogEntry[]): Check {
  const named = catalog.filter(entry => entry.title.trim().includes(' '))

  return turns => {
    const returned = new Set(returnedProducts(turns).map(product => product.id))
    const replies = turns.map(turn => normalize(turn.reply).toLowerCase()).join('\n')
    const invented = named.filter(entry => replies.includes(normalize(entry.title).toLowerCase()) && !returned.has(entry.id))
    return invented.length === 0
      ? undefined
      : `mentioned products no tool returned: ${invented.map(entry => `#${entry.id} ${entry.title}`).join(', ')}`
  }
}

/** Every dollar amount in any reply is the price of a product a tool returned. */
export const groundedPrices: Check = turns => {
  const prices  = new Set(returnedProducts(turns).map(product => product.price.toFixed(2)))
  const unknown = turns
    .flatMap(turn => [...turn.reply.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)])
    .map(match => Number(match[1]!.replaceAll(',', '')).toFixed(2))
    .filter(amount => !prices.has(amount))

  return unknown.length === 0
    ? undefined
    : `prices not from tool results: ${unknown.map(a => `$${a}`).join(', ')}`
}
