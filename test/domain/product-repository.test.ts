import { describe, expect, it } from 'vitest'

import { CatalogUnavailableError, createDummyJsonRepository } from '../../src/domain/product-repository.ts'
import { rawFixture } from '../helpers/fixtures.ts'

/** A fake `fetch` that records the URLs it was asked for and answers with `respond`. */
function fakeFetch(respond: (url: URL) => Response | Promise<Response>) {
  const urls: URL[] = []
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    urls.push(url)
    return respond(url)
  }) as typeof globalThis.fetch
  return { fetch, urls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function repoWith(respond: (url: URL) => Response | Promise<Response>, timeoutMs?: number) {
  const fake = fakeFetch(respond)
  const repo = createDummyJsonRepository({ baseUrl: 'https://catalog.test', fetch: fake.fetch, timeoutMs })
  return { repo, urls: fake.urls }
}

describe('dummyjson repository', () => {
  it('searches with the query and limit as URL params', async () => {
    const { repo, urls } = repoWith(() => json(rawFixture('search-lipstick')))

    const page = await repo.search('red lipstick & co', 5)

    expect(urls[0]!.pathname).toBe('/products/search')
    expect(urls[0]!.searchParams.get('q')).toBe('red lipstick & co')
    expect(urls[0]!.searchParams.get('limit')).toBe('5')
    expect(page.total).toBe(1)
    expect(page.products[0]!.title).toBe('Red Lipstick')
  })

  it('strips fields we do not model (stock, warranty, shipping, reviews, …)', async () => {
    const { repo } = repoWith(() => json(rawFixture('category-smartphones')))

    const page = await repo.listByCategory('smartphones', 5)

    expect(Object.keys(page.products[0]!).sort()).toEqual(
      ['brand', 'category', 'description', 'id', 'price', 'rating', 'thumbnail', 'title'])
  })

  it('lists a category by slug', async () => {
    const { repo, urls } = repoWith(() => json(rawFixture('category-smartphones')))

    const page = await repo.listByCategory('smartphones', 3)

    expect(urls[0]!.pathname).toBe('/products/category/smartphones')
    expect(urls[0]!.searchParams.get('limit')).toBe('3')
    expect(page.total).toBe(16)
  })

  it('returns an empty page when nothing matches', async () => {
    const { repo } = repoWith(() => json(rawFixture('search-empty')))
    expect(await repo.search('surfboard', 5)).toEqual({ products: [], total: 0 })
  })

  it('lists category slugs', async () => {
    const { repo, urls } = repoWith(() => json(rawFixture('category-list')))

    const categories = await repo.listCategories()

    expect(urls[0]!.pathname).toBe('/products/category-list')
    expect(categories).toContain('smartphones')
    expect(categories).toHaveLength(24)
  })

  describe('turns failures into CatalogUnavailableError', () => {
    const cases: Array<[string, (url: URL) => Response | Promise<Response>]> = [
      ['HTTP 500', () => json({ message: 'boom' }, 500)],
      ['network error', () => { throw new TypeError('fetch failed') }],
      ['invalid JSON', () => new Response('<html>oops</html>', { status: 200 })],
      ['unexpected shape', () => json({ items: [] })],
    ]

    for (const [name, respond] of cases) {
      it(name, async () => {
        const { repo } = repoWith(respond)
        await expect(repo.search('lipstick', 5)).rejects.toBeInstanceOf(CatalogUnavailableError)
        await expect(repo.listCategories()).rejects.toBeInstanceOf(CatalogUnavailableError)
      })
    }

    it('timeout', async () => {
      // Never answers on its own; only the abort signal ends the request.
      const fetch = ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })) as typeof globalThis.fetch
      const repo = createDummyJsonRepository({ baseUrl: 'https://catalog.test', fetch, timeoutMs: 20 })

      await expect(repo.search('lipstick', 5)).rejects.toBeInstanceOf(CatalogUnavailableError)
    })
  })
})
