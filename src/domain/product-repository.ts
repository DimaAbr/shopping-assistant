import type { z } from 'zod'
import { CategoryListSchema, ProductPageSchema, type ProductPage } from './products.ts'

/**
 * Access to the product catalog (02 §4, §5).
 *
 * Phase 2 maps each method 1:1 to a dummyjson endpoint — no filtering in code,
 * no caching. A cached implementation can replace this one later.
 */

export interface ProductRepository {
  /** Case-insensitive substring match on title / description (dummyjson semantics). `skip` pages through results. */
  search(query: string, limit: number, skip?: number): Promise<ProductPage>
  /** An unknown slug yields an empty page, not an error. */
  listByCategory(slug: string, limit: number, skip?: number): Promise<ProductPage>
  listCategories(): Promise<string[]>
}

/** The catalog couldn't be reached or answered with something we can't use. */
export class CatalogUnavailableError extends Error {
  override name = 'CatalogUnavailableError'
}

export type DummyJsonRepositoryOptions = {
  baseUrl:    string
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?:     typeof fetch
  timeoutMs?: number
}

export function createDummyJsonRepository(options: DummyJsonRepositoryOptions): ProductRepository {
  const fetchFn   = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 10_000

  async function get<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, options.baseUrl)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

    let response: Response
    try {
      response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new CatalogUnavailableError(`request to ${url.pathname} failed: ${describe(error)}`, { cause: error })
    }
    if (!response.ok) {
      throw new CatalogUnavailableError(`${url.pathname} answered HTTP ${response.status}`)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw new CatalogUnavailableError(`${url.pathname} returned invalid JSON`, { cause: error })
    }

    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new CatalogUnavailableError(`${url.pathname} returned an unexpected shape`, { cause: parsed.error })
    }
    return parsed.data
  }

  return {
    search: (query, limit, skip = 0) =>
      get('/products/search', { q: query, ...pageParams(limit, skip) }, ProductPageSchema),

    listByCategory: (slug, limit, skip = 0) =>
      get(`/products/category/${encodeURIComponent(slug)}`, pageParams(limit, skip), ProductPageSchema),

    listCategories: () =>
      get('/products/category-list', {}, CategoryListSchema),
  }
}

/** `skip` is only sent when paging, so first-page URLs stay as they were. */
function pageParams(limit: number, skip: number): Record<string, string> {
  return skip > 0
    ? { limit: String(limit), skip: String(skip) }
    : { limit: String(limit) }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
