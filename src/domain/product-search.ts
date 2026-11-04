import { z } from 'zod'
import { ProductListingSchema } from './product-card.ts'
import type { ProductRepository } from './product-repository.ts'
import type { Product, ProductPage } from './products.ts'

/**
 * The deterministic half of product search (09): one catalog query, price
 * bounds, merging. The LLM steps (planning, relevance) live in `agent/search/`.
 */

/**
 * What a product search returns: the `findProducts` tool output, and the product
 * widget's contract (07, 09). Products come in labelled groups, one per need.
 */
export const ProductSearchResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    groups: z.array(z.object({ label: z.string(), products: z.array(ProductListingSchema) })),
    /** Labels of the needs nothing was found for. */
    unmet: z.array(z.string()),
  }),
  z.object({ status: z.literal('no_match'), unmet: z.array(z.string()) }),
  z.object({ status: z.literal('catalog_unavailable') }),
])

export type ProductSearchResult = z.infer<typeof ProductSearchResultSchema>

/** One call to the catalog: a keyword search or a category listing. */
export type CatalogQuery =
  | { kind: 'search', q: string }
  | { kind: 'category', slug: string }

/** Hard price bounds, in USD. Both ends are inclusive. */
export type PriceRange = { minPrice?: number, maxPrice?: number }

/** One page of a query's results, and where the next page would start. */
export type QueryPage = { query: CatalogQuery, page: ProductPage, nextSkip: number }

export async function runQuery(repo: ProductRepository, query: CatalogQuery, limit: number, skip?: number): Promise<QueryPage> {
  const page = query.kind === 'search'
    ? await repo.search(query.q, limit, skip)
    : await repo.listByCategory(query.slug, limit, skip)
  return { query, page, nextSkip: (skip ?? 0) + page.products.length }
}

/** Whether another page of this query exists. */
export function hasMore({ page, nextSkip }: QueryPage): boolean {
  return page.products.length > 0 && nextSkip < page.total
}

/** Out-of-stock products are filtered out silently (09). An unknown status counts as available. */
export function isAvailable(product: Product): boolean {
  return product.availabilityStatus?.trim().toLowerCase() !== 'out of stock'
}

export function inPriceRange(product: Product, range: PriceRange): boolean {
  return (
    (range.minPrice === undefined || product.price >= range.minPrice) &&
    (range.maxPrice === undefined || product.price <= range.maxPrice)
  )
}

/** First occurrence wins, so the order of the queries is kept. */
export function dedupeById<T extends { id: number }>(products: Iterable<T>): T[] {
  const seen = new Set<number>()
  const unique: T[] = []
  for (const product of products) {
    if (seen.has(product.id)) continue
    seen.add(product.id)
    unique.push(product)
  }
  return unique
}

export function describeQuery(query: CatalogQuery): string {
  return query.kind === 'search' ? `search "${query.q}"` : `category ${query.slug}`
}
