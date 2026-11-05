import type { CatalogEntry, Check, TurnRecord } from './harness.ts'

/** Code-based checks (02 §11). Each returns `undefined` on success, or a reason. */


const lastTurn = (turns: TurnRecord[]) => turns.at(-1)!

/** Models write typographic apostrophes (don’t); the patterns use plain ones. */
const normalize = (text: string) => text.replace(/[\u2018\u2019]/g, "'")
const lastReply = (turns: TurnRecord[]) => normalize(lastTurn(turns).reply)

function productsOf(turn: TurnRecord) {
  return turn.results
    .filter(result => result.status === 'ok')
    .flatMap(result => result.groups)
    .flatMap(group => group.products)
}

function returnedProducts(turns: TurnRecord[]) {
  return turns.flatMap(productsOf)
}

// ── tool use ────────────────────────────────────────────────────────────────

export const noToolCall: Check = turns => lastTurn(turns).toolCalls.length === 0
  ? undefined
  : `expected no tool call, got ${JSON.stringify(lastTurn(turns).toolCalls)}`

export const someToolCall: Check = turns => lastTurn(turns).toolCalls.length > 0
  ? undefined
  : 'expected a tool call'

/** Exactly one findProducts call in the last turn: one consolidated search per request (09). */
export const oneSearch: Check = turns => {
  const calls = lastTurn(turns).toolCalls
  return calls.length === 1 && calls[0]!.toolName === 'findProducts'
    ? undefined
    : `expected one findProducts call, got ${JSON.stringify(calls)}`
}

/** The last turn's findProducts requests don't match (e.g. facts about the wrong person). */
export function requestDoesNotMatch(pattern: RegExp, label = String(pattern)): Check {
  return turns => {
    const bad = lastTurn(turns)
      .toolCalls
      .map(call => String(call.input.request ?? ''))
      .find(request => pattern.test(request))
      
    return bad === undefined
      ? undefined
      : `request "${bad}" matches ${label}`
  }
}

// ── memories (Conversation cases, 10) ───────────────────────────────────────

/** Some memory about `subject` after the last turn matches. */
export function remembers(subject: string, pattern: RegExp, label = String(pattern)): Check {
  return turns => (lastTurn(turns).memories ?? []).some(memory => memory.subject === subject && pattern.test(memory.text))
    ? undefined
    : `no memory about ${subject} matches ${label}: ${JSON.stringify(lastTurn(turns).memories)}`
}

/** No memory about `subject` after the last turn matches. */
export function doesNotRemember(subject: string, pattern: RegExp, label = String(pattern)): Check {
  return turns => {
    const bad = (lastTurn(turns).memories ?? []).find(memory => memory.subject === subject && pattern.test(memory.text))
    return bad === undefined
      ? undefined
      : `memory about ${subject} matches ${label}: "${bad.text}"`
  }
}

// ── search results (last turn) ──────────────────────────────────────────────

/** The last turn returned at least one product, and all of them are from the plausible categories. */
export function returnedPlausible(plausible: readonly string[]): Check {
  return turns => {
    const products = productsOf(lastTurn(turns))
    if (products.length === 0) return 'no products returned'

    const odd = products.filter(product => !plausible.includes(product.category))
    return odd.length === 0
      ? undefined
      : `returned implausible products ${odd.map(p => `#${p.id} ${p.title} (${p.category})`).join(', ')}`
  }
}

/** The last turn returned no product from these categories. */
export function returnedNoneFrom(categories: readonly string[]): Check {
  return turns => {
    const odd = productsOf(lastTurn(turns)).filter(product => categories.includes(product.category))
    return odd.length === 0
      ? undefined
      : `returned ${odd.map(p => `#${p.id} ${p.title} (${p.category})`).join(', ')}`
  }
}

/** Some returned product's title matches. */
export function returnedTitle(pattern: RegExp): Check {
  return turns => productsOf(lastTurn(turns)).some(product => pattern.test(product.title))
    ? undefined
    : `no returned product matches ${pattern}`
}

export function returnedGroups(min: number): Check {
  return turns => {
    const groups = lastTurn(turns).results.flatMap(result => result.status === 'ok' ? result.groups.map(g => g.label) : [])
    return groups.length >= min
      ? undefined
      : `expected ≥ ${min} groups, got ${JSON.stringify(groups)}`
  }
}

export function pricesAtMost(max: number): Check {
  return turns => {
    const over = productsOf(lastTurn(turns)).filter(product => product.price > max)
    return over.length === 0
      ? undefined
      : `returned products over $${max}: ${over.map(p => `#${p.id} $${p.price}`).join(', ')}`
  }
}

/**
 * The reply doesn't repeat the tiles: at most one returned product title and
 * one dollar amount (09, "Reply").
 */
export const noProductListing: Check = turns => {
  const reply = lastReply(turns).toLowerCase()
  const titles = productsOf(lastTurn(turns)).filter(product => reply.includes(normalize(product.title).toLowerCase()))
  const prices = [...reply.matchAll(/\$\s?\d/g)]
  return titles.length <= 1 && prices.length <= 1
    ? undefined
    : `reply lists products (${titles.length} titles, ${prices.length} prices)`
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
  { slugs: ['beauty'],                           pattern: /\b(beauty|make-?up|cosmetics?|mascara|lipsticks?)\b/i },
  { slugs: ['fragrances'],                       pattern: /\b(fragrances?|perfumes?|colognes?)\b/i },
  { slugs: ['furniture'],                        pattern: /\bfurniture\b/i },
  { slugs: ['groceries'],                        pattern: /\b(groceries|grocery|snacks?|drinks?|food)\b/i },
  { slugs: ['home-decoration'],                  pattern: /\b(home[- ]?d[eé]cor(ation)?s?|decorations?|d[eé]cor)\b/i },
  { slugs: ['kitchen-accessories'],              pattern: /\b(kitchen|cookware)\b/i },
  { slugs: ['laptops'],                          pattern: /\blaptops?\b/i },
  { slugs: ['mens-shirts'],                      pattern: /\bshirts?\b/i },
  { slugs: ['mens-shoes', 'womens-shoes'],       pattern: /\b(shoes|sneakers|trainers|footwear)\b/i },
  { slugs: ['mens-watches', 'womens-watches'],   pattern: /\bwatch(es)?\b/i },
  { slugs: ['mobile-accessories'],               pattern: /\b(phone accessories|mobile accessories|headphones|earbuds|chargers?)\b/i },
  { slugs: ['motorcycle'],                       pattern: /\bmotorcycles?\b/i },
  { slugs: ['skin-care'],                        pattern: /\b(skin[- ]?care|sunscreen|moisturi[sz]ers?)\b/i },
  { slugs: ['smartphones'],                      pattern: /\b(smart)?phones?\b(?! accessor)/i },
  { slugs: ['sports-accessories'],               pattern: /\b(sports?|fitness|gym)\b/i },
  { slugs: ['sunglasses'],                       pattern: /\bsunglasses\b/i },
  { slugs: ['tablets'],                          pattern: /\b(tablets?|ipads?)\b/i },
  { slugs: ['tops'],                             pattern: /\b(tops?|blouses?)\b/i },
  { slugs: ['vehicle'],                          pattern: /\b(vehicles?|cars?)\b/i },
  { slugs: ['womens-bags'],                      pattern: /\b(bags?|handbags?|purses?|totes?)\b/i },
  { slugs: ['womens-dresses'],                   pattern: /\bdress(es)?\b/i },
  { slugs: ['womens-jewellery'],                 pattern: /\b(jewell?ery|necklaces?|earrings?|bracelets?)\b/i },
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

/** No search ever returns an out-of-stock product (09: filtered silently in code). */
export function inStockOnly(catalog: readonly CatalogEntry[]): Check {
  const soldOut = new Set(catalog.filter(entry => entry.availabilityStatus === 'Out of Stock').map(entry => entry.id))
  return turns => {
    const odd = returnedProducts(turns).filter(product => soldOut.has(product.id))
    return odd.length === 0
      ? undefined
      : `returned out-of-stock products: ${odd.map(p => `#${p.id} ${p.title}`).join(', ')}`
  }
}

/** Every returned product (last turn) ships within the pattern's times, e.g. /overnight|1-2 business days/. */
export function shipsWithin(pattern: RegExp, label: string): Check {
  return turns => {
    const products = productsOf(lastTurn(turns))
    if (products.length === 0) return 'no products returned'
    const slow = products.filter(product => !pattern.test(product.shippingInformation ?? ''))
    return slow.length === 0
      ? undefined
      : `returned products that don't ship ${label}: ${slow.map(p => `#${p.id} ${p.shippingInformation ?? '(unknown)'}`).join(', ')}`
  }
}

/** Every dollar amount in any reply is the price of a product a tool returned, or an amount the user gave ("under $100"). */
export const groundedPrices: Check = turns => {
  const amountsIn = (text: string) => [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars|usd)\b/gi)]
    .map(match => Number((match[1] ?? match[2])!.replaceAll(',', '')).toFixed(2))

  const known = new Set([
    ...returnedProducts(turns).map(product => product.price.toFixed(2)),
    ...turns.flatMap(turn => amountsIn(turn.user)),
  ])
  const unknown = turns
    .flatMap(turn => amountsIn(turn.reply))
    .filter(amount => !known.has(amount))

  return unknown.length === 0
    ? undefined
    : `prices not from tool results: ${unknown.map(a => `$${a}`).join(', ')}`
}
