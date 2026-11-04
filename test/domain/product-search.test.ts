import { describe, expect, it } from 'vitest'

import { dedupeById, hasMore, inPriceRange, isAvailable, runQuery } from '../../src/domain/product-search.ts'
import { createCatalogRepository, product } from '../helpers/fake-repository.ts'

const cheap = product({ id: 1, title: 'Cheap Ball', price: 10 })
const mid = product({ id: 2, title: 'Mid Ball', price: 50 })
const pricey = product({ id: 3, title: 'Pricey Ball', price: 100 })

describe('price range', () => {
  it('is inclusive at both ends, and open when a bound is missing', () => {
    expect([cheap, mid, pricey].filter(p => inPriceRange(p, { minPrice: 10, maxPrice: 50 })).map(p => p.id)).toEqual([1, 2])
    expect([cheap, mid, pricey].filter(p => inPriceRange(p, { maxPrice: 49.99 })).map(p => p.id)).toEqual([1])
    expect([cheap, mid, pricey].filter(p => inPriceRange(p, { minPrice: 51 })).map(p => p.id)).toEqual([3])
    expect([cheap, mid, pricey].filter(p => inPriceRange(p, {}))).toHaveLength(3)
  })
})

describe('availability', () => {
  it('only out-of-stock products are unavailable; an unknown status counts as available', () => {
    expect(isAvailable(product({ id: 1, title: 'A', availabilityStatus: 'In Stock' }))).toBe(true)
    expect(isAvailable(product({ id: 2, title: 'B', availabilityStatus: 'Low Stock' }))).toBe(true)
    expect(isAvailable(product({ id: 3, title: 'C', availabilityStatus: 'Out of Stock' }))).toBe(false)
    expect(isAvailable(product({ id: 4, title: 'D', availabilityStatus: ' out of stock ' }))).toBe(false)
    expect(isAvailable(product({ id: 5, title: 'E' }))).toBe(true)
  })
})

describe('dedupeById', () => {
  it('keeps the first occurrence and the order', () => {
    expect(dedupeById([mid, cheap, mid, pricey, cheap]).map(p => p.id)).toEqual([2, 1, 3])
  })
})

describe('runQuery', () => {
  const repo = createCatalogRepository([cheap, mid, pricey])

  it('runs a search or a category listing, and says where the next page starts', async () => {
    const search = await runQuery(repo, { kind: 'search', q: 'ball' }, 2)
    expect(search.page.products.map(p => p.id)).toEqual([1, 2])
    expect(search.nextSkip).toBe(2)
    expect(hasMore(search)).toBe(true)

    const next = await runQuery(repo, { kind: 'category', slug: 'sports-accessories' }, 2, 2)
    expect(next.page.products.map(p => p.id)).toEqual([3])
    expect(next.nextSkip).toBe(3)
    expect(hasMore(next)).toBe(false)

    expect(repo.calls).toEqual([
      { method: 'search', args: ['ball', 2] },
      { method: 'listByCategory', args: ['sports-accessories', 2, 2] },
    ])
  })

  it('an empty page has no more pages', async () => {
    expect(hasMore(await runQuery(repo, { kind: 'search', q: 'surfboard' }, 2))).toBe(false)
  })
})
