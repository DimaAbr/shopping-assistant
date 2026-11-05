import { tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import type { ProductRepository } from '../domain/product-repository.ts'
import type { ProductListing } from '../domain/product-card.ts'
import type { StepLogSink } from '../observability/step-log.ts'
import { ProductSearchResultSchema, type ProductSearchResult } from '../domain/product-search.ts'
import { findProducts } from './search/find-products.ts'
import { modelCallLog } from './search/log.ts'

/**
 * The shopping tool (09): one `findProducts` call per request.
 *
 * The chat agent describes what the shopper wants; the search workflow
 * (`agent/search/`) plans the catalog queries, filters and merges. Only this
 * call and its result reach chat history. The workflow's own model calls go
 * to the step log.
 *
 * The result is the widget contract (`ShoppingToolResultSchema`): products are
 * `ProductListing`s in labelled groups. It reaches clients unchanged, live on
 * the UI stream and from history. `toModelOutput` decides what the model sees.
 */

export const ShoppingToolResultSchema = ProductSearchResultSchema

export type ShoppingToolResult = ProductSearchResult

/** The tool names, as clients see them in `tool-<name>` parts. Checked against `createShoppingTools` in the tests. */
export const SHOPPING_TOOL_NAMES = ['findProducts'] as const

/** What the model sees of one product: no image URL, no currency (all prices are USD). */
export type ModelProduct = Pick<ProductListing, 'id' | 'title' | 'description' | 'category' | 'price' | 'rating' | 'brand' | 'shippingInformation'>

export type ModelToolOutput =
  | { status: 'ok', groups: Array<{ label: string, products: ModelProduct[] }>, unmet: string[] }
  | { status: 'no_match', unmet: string[] }
  | { status: 'catalog_unavailable' }

export type ShoppingToolsOptions = {
  /** The model for the search workflow's own calls (the `searcher` role). */
  searchModel: LanguageModel
  logSink?: StepLogSink
}

const priceSchema = z.number().nonnegative()

/** `findProducts` input, shared by the chat tool and the MCP tool (11). */
export const FindProductsInputSchema = z.object({
  request: z.string().trim()
    .min(1).max(300)
    .describe(
      'A short, self-contained description of what to find, using the whole conversation, including any timing ("needed by Friday") ' +
      '(e.g. "workout shoes and sports accessories for a man who is starting to exercise"). ' +
      'Leave prices out: use minPrice / maxPrice.',
    ),
  minPrice: priceSchema.optional().describe('Lowest price in USD, if the shopper gave one.'),
  maxPrice: priceSchema.optional().describe('Highest price in USD, if the shopper gave a budget.'),
})

export function createShoppingTools(repo: ProductRepository, categories: readonly string[], options: ShoppingToolsOptions) {
  if (categories[0] === undefined) throw new Error('createShoppingTools needs at least one category')

  return {
    findProducts: tool({
      description:
        'Find products in the catalog. Describe everything the shopper wants in ONE call, in plain words: ' +
        'the kinds of product, who they are for, what for, and when they are needed. The search plans the catalog queries, ' +
        'filters out what doesn\'t fit and returns the matches grouped by kind of product. ' +
        'The shopper sees the products as tiles.',
      inputSchema: FindProductsInputSchema,
      execute: (input, { toolCallId, abortSignal }) => findProducts(input, {
        repo,
        model: options.searchModel,
        categories,
        log: options.logSink === undefined ? undefined : modelCallLog(options.logSink, toolCallId),
        abortSignal,
      }),
      toModelOutput: ({ output }) => ({ type: 'json', value: toModelOutput(output) }),
    }),
  }
}

export type ShoppingTools = ReturnType<typeof createShoppingTools>

export function toModelOutput(result: ShoppingToolResult): ModelToolOutput {
  if (result.status !== 'ok') return result
  return {
    status: 'ok',
    groups: result.groups.map(group => ({ label: group.label, products: group.products.map(toModelProduct) })),
    unmet: result.unmet,
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
    ...(product.shippingInformation === undefined ? {} : { shippingInformation: product.shippingInformation }),
  }
}
