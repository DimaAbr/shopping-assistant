import type { LanguageModel } from 'ai'
import { toProductListing } from '../../domain/product-card.ts'
import { CatalogUnavailableError, type ProductRepository } from '../../domain/product-repository.ts'
import {
  dedupeById,
  hasMore,
  inPriceRange,
  isAvailable,
  runQuery,
  type PriceRange,
  type ProductSearchResult,
  type QueryPage,
} from '../../domain/product-search.ts'
import type { Product } from '../../domain/products.ts'
import type { ModelCallLog } from './log.ts'
import { planSearch, type Need } from './plan.ts'
import { filterRelevant } from './relevance.ts'

/**
 * Product search as one fixed workflow (09). A plain function: the chat tool
 * and (later) the MCP endpoint both wrap it.
 *
 * 1. plan: the request → needs → catalog queries (LLM)
 * 2. run every query in parallel, merge per need, drop out-of-stock products,
 *    apply the price bounds (code)
 * 3. keep only the relevant candidates (LLM)
 * 4. refill once: a need with too few kept products fetches the next page of
 *    its queries, and only the new candidates are judged
 * 5. one group per need, capped; a product appears in one group only
 *
 * Catalog calls are bounded (needs × queries, plus at most one more page each),
 * so a search never hammers the live API (02 §5).
 */

/** Page size for each catalog query. */
export const FETCH_LIMIT = 20
/** A need with fewer kept products than this gets the refill round. */
export const MIN_KEPT = 2
export const MAX_PER_GROUP = 4
export const MAX_TOTAL = 10

export type FindProductsResult = ProductSearchResult

export type FindProductsInput = { request: string } & PriceRange

export type FindProductsDeps = {
  repo: ProductRepository
  model: LanguageModel
  categories: readonly string[]
  log?: ModelCallLog
}

type NeedState = {
  need: Need
  pages: QueryPage[]
  /** Every product fetched for this need, so the refill only judges new ones. */
  seen: Set<number>
  kept: Product[]
}

export async function findProducts(input: FindProductsInput, deps: FindProductsDeps): Promise<FindProductsResult> {
  const plan = await planSearch({ model: deps.model, request: input.request, categories: deps.categories, log: deps.log })
  if (plan.needs.length === 0) return { status: 'no_match', unmet: [input.request] }

  try {
    const states: NeedState[] = await Promise.all(plan.needs.map(async need => ({
      need,
      pages: await Promise.all(need.queries.map(query => runQuery(deps.repo, query, FETCH_LIMIT))),
      seen: new Set<number>(),
      kept: [],
    })))
    await judge(states, states.map(state => state.pages), input, deps)

    const refill = states.filter(state => state.kept.length < MIN_KEPT && state.pages.some(hasMore))
    if (refill.length > 0) {
      const nextPages = await Promise.all(refill.map(state => Promise.all(
        state.pages.filter(hasMore).map(page => runQuery(deps.repo, page.query, FETCH_LIMIT, page.nextSkip)),
      )))
      await judge(refill, nextPages, input, deps)
    }

    return assemble(states)
  } catch (error) {
    if (error instanceof CatalogUnavailableError) return { status: 'catalog_unavailable' }
    throw error
  }
}

/** Merges each need's new pages, drops out-of-stock products, applies the price bounds and appends the relevant products to `kept`. */
async function judge(states: NeedState[], pages: QueryPage[][], input: FindProductsInput, deps: FindProductsDeps) {
  const candidates = states.map((state, index) => {
    const fetched = dedupeById(pages[index]!.flatMap(page => page.page.products)).filter(product => !state.seen.has(product.id))

    for (const product of fetched)
      state.seen.add(product.id)
    
    return fetched.filter(product => isAvailable(product) && inPriceRange(product, input))
  })

  const keptIds = await filterRelevant({
    model: deps.model,
    request: input.request,
    needs: states.map((state, index) => ({ label: state.need.label, candidates: candidates[index]! })),
    log: deps.log,
  })

  states.forEach((state, index) => {
    const byId = new Map(candidates[index]!.map(product => [product.id, product]))
    state.kept.push(...keptIds[index]!.map(id => byId.get(id)!))
  })
}

function assemble(states: NeedState[]): FindProductsResult {
  const used = new Set<number>()
  let room = MAX_TOTAL
  const groups: Array<{ label: string, products: Product[] }> = []
  const unmet: string[] = []

  for (const { need, kept } of states) {
    const fresh = kept.filter(product => !used.has(product.id))
    // A need whose products all went to an earlier group, or that only ran out of room, isn't unmet.
    if (kept.length === 0) unmet.push(need.label)

    const products = fresh.slice(0, Math.min(MAX_PER_GROUP, room))
    for (const product of products) used.add(product.id)
    room -= products.length
    if (products.length > 0) groups.push({ label: need.label, products })
  }

  return groups.length === 0
    ? { status: 'no_match', unmet }
    : { status: 'ok', groups: groups.map(group => ({ label: group.label, products: group.products.map(toProductListing) })), unmet }
}
