import { createShoppingTools } from '../../src/agent/tools.ts'
import { CatalogUnavailableError, type ProductRepository } from '../../src/domain/product-repository.ts'
import { toProductListing } from '../../src/domain/product-card.ts'
import { CategoryListSchema, ProductPageSchema, type Product, type ProductPage } from '../../src/domain/products.ts'
import { rawFixture } from './fixtures.ts'
import { fixturePlan, searchModel } from './search-model.ts'

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
export const lipstick = ProductPageSchema.parse(rawFixture('search-lipstick'))
export const phones = ProductPageSchema.parse(rawFixture('category-smartphones'))
export const emptyPage: ProductPage = { products: [], total: 0 }

/** The lipstick results as the tools return them. */
export const lipstickListings = lipstick.products.map(toProductListing)

export async function unavailable(): Promise<never> {
  throw new CatalogUnavailableError('catalog is down (fake)')
}

/** The shopping tools over a fake repository, with a scripted search model (`fixturePlan`, keeps everything). */
export function testShoppingTools(repo: ProductRepository = createFakeRepository()) {
  return createShoppingTools(repo, categories, { searchModel: searchModel({ plan: fixturePlan }) })
}

export function createFakeRepository(overrides: Partial<ProductRepository> = {}) {
  const base: ProductRepository = {
    search:         async (query, limit, skip = 0) => slice(query.toLowerCase() === 'lipstick' ? lipstick : emptyPage, limit, skip),
    listByCategory: async (slug, limit, skip = 0)  => slice(slug === 'smartphones' ? phones : emptyPage, limit, skip),
    listCategories: async ()                       => [...categories],
  }
  return recording({ ...base, ...overrides })
}

/**
 * A fake over an in-memory catalog, with dummyjson semantics: search is one
 * case-insensitive substring of title or description; `limit` / `skip` page.
 */
export function createCatalogRepository(products: readonly Product[]) {
  const page = (matches: Product[], limit: number, skip = 0): ProductPage => ({
    products: matches.slice(skip, skip + limit),
    total: matches.length,
  })

  return recording({
    search: async (query, limit, skip) => {
      const q = query.toLowerCase()
      return page(products.filter(p => p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)), limit, skip)
    },
    listByCategory: async (slug, limit, skip) => page(products.filter(p => p.category === slug), limit, skip),
    listCategories: async () => [...new Set(products.map(p => p.category))],
  })
}

/** A product for catalog fakes; only the fields a test cares about need passing. */
export function product(fields: Partial<Product> & Pick<Product, 'id' | 'title'>): Product {
  return {
    description: `${fields.title}.`,
    category: 'sports-accessories',
    price: 10,
    rating: 4,
    thumbnail: `https://cdn.dummyjson.com/products/${fields.id}/thumbnail.png`,
    tags: [],
    ...fields,
  }
}

/** Records every call as `{ method, args }`, skipping trailing `undefined`s. */
function recording(impl: ProductRepository) {
  const calls: Array<{ method: string, args: unknown[] }> = []
  const record = (method: string, args: unknown[]) => {
    while (args.length > 0 && args.at(-1) === undefined) args = args.slice(0, -1)
    calls.push({ method, args })
  }

  const repo: ProductRepository = {
    search:         (query, limit, skip)  => { record('search',         [query, limit, skip]);  return impl.search(query, limit, skip) },
    listByCategory: (slug, limit, skip)   => { record('listByCategory', [slug, limit, skip]);   return impl.listByCategory(slug, limit, skip) },
    listCategories: ()                    => { record('listCategories', []);                    return impl.listCategories() },
  }
  return Object.assign(repo, { calls })
}

function slice(page: ProductPage, limit: number, skip: number): ProductPage {
  return { products: page.products.slice(skip, skip + limit), total: page.total }
}
