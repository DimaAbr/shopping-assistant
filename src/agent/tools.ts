import { tool } from 'ai'
import { z } from 'zod'
import { CatalogUnavailableError, type ProductRepository } from '../domain/product-repository.ts'
import { ProductListingSchema, toProductListing, type ProductListing } from '../domain/product-card.ts'
import type { ProductPage } from '../domain/products.ts'

/**
 * The shopping tools (05, "Tools").
 *
 * Every tool returns a discriminated `status` instead of throwing, so the model
 * always gets an unambiguous signal ("nothing matched", "catalog is down")
 * to report — rather than a raw error it might paper over.
 *
 * The tool result is the widget contract (`ShoppingToolResultSchema`): each
 * product is a `ProductListing`, i.e. a `ProductCard` plus the fields the model
 * uses. It reaches clients unchanged, live on the UI stream and from history.
 * `toModelOutput` decides what the model actually sees.
 */

export const DEFAULT_LIMIT = 5
export const MAX_LIMIT = 10

/**
 * The output of both shopping tools: what `tool-searchProducts` /
 * `tool-browseCategory` parts carry as `output` (07, "Product card contract").
 */
export const ShoppingToolResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), total: z.number().int(), products: z.array(ProductListingSchema) }),
  z.object({ status: z.literal('empty') }),
  z.object({ status: z.literal('catalog_unavailable') }),
])

export type ShoppingToolResult = z.infer<typeof ShoppingToolResultSchema>

/** What the model sees of one product: no image URL, no currency (all prices are USD). */
export type ModelProduct = Pick<ProductListing, 'id' | 'title' | 'description' | 'category' | 'price' | 'rating' | 'brand'>

export type ModelToolOutput =
  | { status: 'ok', total: number, shown: number, products: ModelProduct[] }
  | { status: 'empty' }
  | { status: 'catalog_unavailable' }

const limitSchema = z.number().int()
  .min(1).max(MAX_LIMIT)
  .optional()
  .describe(`How many products to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`)

export function createShoppingTools(repo: ProductRepository, categories: readonly string[]) {
  if (categories[0] === undefined) throw new Error('createShoppingTools needs at least one category')
  const categorySchema = z.enum(categories)

  return {
    searchProducts: tool({
      description:
        'Search the catalog by keyword. Matches the query as ONE case-insensitive substring of a ' +
        'product title or description, so use a short singular phrase in the order it would appear ' +
        'in a title ("lipstick", "red lipstick", "laptop") — not a sentence, not plurals.',
      inputSchema: z.object({
        query: z.string().trim()
          .min(1).max(60)
          .describe('A short singular keyword phrase.'),
        limit: limitSchema,
      }),
      execute: ({ query, limit }) => run(() => repo.search(query, limit ?? DEFAULT_LIMIT)),
      toModelOutput: ({ output }) => ({ type: 'json', value: toModelOutput(output) }),
    }),

    browseCategory: tool({
      description: 'List products in one catalog category. Use when the request maps to a category.',
      inputSchema: z.object({
        category: categorySchema.describe('A category slug from the catalog.'),
        limit: limitSchema,
      }),
      execute: ({ category, limit }) => run(() => repo.listByCategory(category, limit ?? DEFAULT_LIMIT)),
      toModelOutput: ({ output }) => ({ type: 'json', value: toModelOutput(output) }),
    }),
  }
}

export type ShoppingTools = ReturnType<typeof createShoppingTools>

async function run(fetchPage: () => Promise<ProductPage>): Promise<ShoppingToolResult> {
  try {
    const page = await fetchPage()
    if (page.products.length === 0) return { status: 'empty' }
    else return { status: 'ok', total: page.total, products: page.products.map(toProductListing) }
  } catch (error) {
    if (error instanceof CatalogUnavailableError) return { status: 'catalog_unavailable' }
    throw error
  }
}

export function toModelOutput(result: ShoppingToolResult): ModelToolOutput {
  if (result.status !== 'ok') return result
  return {
    status: 'ok',
    total: result.total,
    shown: result.products.length,
    products: result.products.map(toModelProduct),
  }
}

/** An explicit whitelist, so a new card field never reaches the model by accident. */
function toModelProduct(product: ProductListing): ModelProduct {
  return {
    id: product.id,
    title: product.title,
    description: product.description,
    category: product.category,
    price: product.price,
    rating: product.rating,
    ...(product.brand === undefined ? {} : { brand: product.brand }),
  }
}
