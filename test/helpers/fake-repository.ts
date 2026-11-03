import { CatalogUnavailableError, type ProductRepository } from '../../src/domain/product-repository.ts'
import { CategoryListSchema, ProductPageSchema, type ProductPage } from '../../src/domain/products.ts'
import { rawFixture } from './fixtures.ts'

/**
 * An in-memory `ProductRepository` over the recorded fixtures — no HTTP.
 *
 * - search: "lipstick" → the lipstick fixture, anything else → empty
 * - listByCategory: "smartphones" → the smartphones fixture, anything else → empty
 * - listCategories: the recorded category list
 *
 * Pass overrides to replace a method, e.g. `{ search: unavailable }`.
 */

export const categories = CategoryListSchema.parse(rawFixture('category-list'))
export const lipstick   = ProductPageSchema.parse(rawFixture('search-lipstick'))
export const phones     = ProductPageSchema.parse(rawFixture('category-smartphones'))
export const emptyPage: ProductPage = { products: [], total: 0 }

export async function unavailable(): Promise<never> {
  throw new CatalogUnavailableError('catalog is down (fake)')
}

export function createFakeRepository(overrides: Partial<ProductRepository> = {}) {
  const calls: Array<{ method: string, args: unknown[] }> = []

  const base: ProductRepository = {
    search:         async (query, limit) => slice(query.toLowerCase() === 'lipstick' ? lipstick : emptyPage, limit),
    listByCategory: async (slug, limit)  => slice(slug === 'smartphones' ? phones : emptyPage, limit),
    listCategories: async ()             => [...categories],
  }

  const impl = { ...base, ...overrides }
  const repo: ProductRepository = {
    search:         (query, limit) => { calls.push({ method: 'search',         args: [query, limit] }); return impl.search(query, limit) },
    listByCategory: (slug, limit)  => { calls.push({ method: 'listByCategory', args: [slug, limit] });  return impl.listByCategory(slug, limit) },
    listCategories: ()             => { calls.push({ method: 'listCategories', args: [] });             return impl.listCategories() },
  }
  return Object.assign(repo, { calls })
}

function slice(page: ProductPage, limit: number): ProductPage {
  return { products: page.products.slice(0, limit), total: page.total }
}
