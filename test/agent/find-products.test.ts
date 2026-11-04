import { describe, expect, it } from 'vitest'

import { FETCH_LIMIT, findProducts, MAX_PER_GROUP, MAX_TOTAL, type FindProductsResult } from '../../src/agent/search/find-products.ts'
import { modelCallLog } from '../../src/agent/search/log.ts'
import { MAX_NEEDS, MAX_QUERIES_PER_NEED, normalizePlan } from '../../src/agent/search/plan.ts'
import { buildRelevancePrompt } from '../../src/agent/search/relevance.ts'
import { memorySink } from '../../src/observability/step-log.ts'
import type { Product } from '../../src/domain/products.ts'
import { categories, createCatalogRepository, createFakeRepository, product, unavailable } from '../helpers/fake-repository.ts'
import { offeredIdsByNeed, searchModel, type RawPlan } from '../helpers/search-model.ts'

const basketball = product({ id: 1, title: 'Basketball', price: 14.99 })
const racket = product({ id: 2, title: 'Tennis Racket', price: 49.99 })
const sneakers = product({ id: 3, title: 'Sports Sneakers', category: 'mens-shoes', price: 119.99 })
const trainers = product({ id: 4, title: 'Puma Trainers', category: 'mens-shoes', price: 89.99, description: 'Running shoe.' })
const heels = product({ id: 5, title: 'Heel Shoes', category: 'womens-shoes', price: 79.99 })
const dress = product({ id: 6, title: 'Girl Summer Dress', category: 'tops', price: 19.99 })

const catalog = [basketball, racket, sneakers, trainers, heels, dress]

const workout: RawPlan = {
  needs: [
    { label: 'Shoes', categories: ['mens-shoes'], searches: ['shoe'] },
    { label: 'Sports Accessories', categories: ['sports-accessories'] },
  ],
}

function setup(options: { plan: RawPlan, keep?: (need: number, offered: number[]) => number[], products?: readonly Product[] }) {
  const repo = createCatalogRepository(options.products ?? catalog)
  const offered: number[][][] = []
  const model = searchModel({
    plan: options.plan,
    keep: (need, ids) => {
      ;(offered[need - 1] ??= []).push(ids)
      return options.keep?.(need, ids) ?? ids
    },
  })
  return { repo, model, offered, deps: { repo, model, categories } }
}

const ids = (result: FindProductsResult) => result.status === 'ok'
  ? result.groups.map(group => [group.label, group.products.map(p => p.id)])
  : result

describe('findProducts', () => {
  it('plans, runs every query, and returns one labelled group per need', async () => {
    const { repo, model, deps } = setup({ plan: workout })

    const result = await findProducts({ request: 'workout gear for a man' }, deps)

    expect(model.calls).toEqual(['plan', 'relevance'])
    expect(repo.calls).toEqual([
      { method: 'listByCategory', args: ['mens-shoes', FETCH_LIMIT] },
      { method: 'search', args: ['shoe', FETCH_LIMIT] },
      { method: 'listByCategory', args: ['sports-accessories', FETCH_LIMIT] },
    ])
    expect(ids(result)).toEqual([['Shoes', [3, 4, 5]], ['Sports Accessories', [1, 2]]])
    expect(result).toMatchObject({ status: 'ok', unmet: [] })
  })

  it('returns products in the widget contract', async () => {
    const { deps } = setup({ plan: workout })
    const result = await findProducts({ request: 'workout gear' }, deps)

    const first = result.status === 'ok' ? result.groups[0]!.products[0]! : undefined
    expect(first).toMatchObject({ id: 3, currency: 'USD', imageUrl: sneakers.thumbnail, category: 'mens-shoes' })
  })

  it('keeps only what the relevance step keeps, in its order, and ignores ids it was not offered', async () => {
    const { deps } = setup({ plan: workout, keep: need => need === 1 ? [999, 4, 3] : [2] })

    const result = await findProducts({ request: 'workout gear for a man' }, deps)

    expect(ids(result)).toEqual([['Shoes', [4, 3]], ['Sports Accessories', [2]]])
  })

  it('applies the price bounds before the relevance step sees the candidates', async () => {
    const { deps, offered } = setup({ plan: workout })

    const result = await findProducts({ request: 'workout gear', minPrice: 15, maxPrice: 100 }, deps)

    expect(offered[0]![0]).toEqual([4, 5])
    expect(offered[1]![0]).toEqual([2])
    expect(ids(result)).toEqual([['Shoes', [4, 5]], ['Sports Accessories', [2]]])
  })

  it('silently drops out-of-stock products before the relevance step', async () => {
    const soldOut = product({ id: 7, title: 'Volleyball', price: 11.99, availabilityStatus: 'Out of Stock' })
    const lowStock = product({ id: 8, title: 'Tennis Ball', price: 6.99, availabilityStatus: 'Low Stock' })
    const { deps, offered } = setup({ plan: workout, products: [...catalog, soldOut, lowStock] })

    const result = await findProducts({ request: 'workout gear' }, deps)

    expect(offered[1]![0]).toEqual([1, 2, 8])
    expect(ids(result)).toEqual([['Shoes', [3, 4, 5]], ['Sports Accessories', [1, 2, 8]]])
  })

  it('refills once from the next page when a need keeps too few products', async () => {
    // 20 expensive balls on the first page, the affordable ones only on the second.
    const balls = Array.from({ length: 25 }, (_, i) => product({ id: 100 + i, title: `Ball ${i}`, price: i < 20 ? 200 : 10 }))
    const { repo, model, deps } = setup({ plan: { needs: [{ label: 'Balls', categories: ['sports-accessories'] }] }, products: balls })

    const result = await findProducts({ request: 'a cheap ball', maxPrice: 50 }, deps)

    expect(repo.calls).toEqual([
      { method: 'listByCategory', args: ['sports-accessories', FETCH_LIMIT] },
      { method: 'listByCategory', args: ['sports-accessories', FETCH_LIMIT, FETCH_LIMIT] },
    ])
    // Round 1 had no candidates within budget, so only the refill was judged.
    expect(model.calls).toEqual(['plan', 'relevance'])
    expect(ids(result)).toEqual([['Balls', [120, 121, 122, 123]]])
  })

  it('refills at most once, and only judges products it has not seen', async () => {
    const balls = Array.from({ length: 60 }, (_, i) => product({ id: 100 + i, title: `Ball ${i}`, price: 10 }))
    const { repo, offered, deps } = setup({
      plan: { needs: [{ label: 'Balls', categories: ['sports-accessories'] }] },
      products: balls,
      keep: () => [],
    })

    const result = await findProducts({ request: 'a ball' }, deps)

    expect(repo.calls).toHaveLength(2)
    expect(offered[0]).toHaveLength(2)
    expect(offered[0]![1]![0]).toBe(120)
    expect(result).toEqual({ status: 'no_match', unmet: ['Balls'] })
  })

  it('does not refill a need that kept enough', async () => {
    const balls = Array.from({ length: 30 }, (_, i) => product({ id: 100 + i, title: `Ball ${i}` }))
    const { repo, deps } = setup({ plan: { needs: [{ label: 'Balls', categories: ['sports-accessories'] }] }, products: balls })

    await findProducts({ request: 'a ball' }, deps)

    expect(repo.calls).toHaveLength(1)
  })

  it('shows a product in one group only, and caps each group and the total', async () => {
    const balls = Array.from({ length: 12 }, (_, i) => product({ id: 100 + i, title: `Ball ${i}` }))
    const plan: RawPlan = {
      needs: [
        { label: 'A', categories: ['sports-accessories'] },
        { label: 'B', categories: ['sports-accessories'] },
        { label: 'C', categories: ['sports-accessories'] },
      ],
    }
    const { deps } = setup({ plan, products: balls })

    const result = await findProducts({ request: 'balls' }, deps)

    expect(ids(result)).toEqual([
      ['A', [100, 101, 102, 103]],
      ['B', [104, 105, 106, 107]],
      ['C', [108, 109]],
    ])
    const all = result.status === 'ok' ? result.groups.flatMap(group => group.products) : []
    expect(all).toHaveLength(MAX_TOTAL)
    expect(Math.max(...(result.status === 'ok' ? result.groups.map(g => g.products.length) : []))).toBe(MAX_PER_GROUP)
    expect(result).toMatchObject({ unmet: [] })
  })

  it('reports needs with nothing found as unmet, next to the groups that were found', async () => {
    const plan: RawPlan = { needs: [...workout.needs, { label: 'Workout Tops' }] }
    const { deps } = setup({ plan })

    const result = await findProducts({ request: 'workout gear for a man' }, deps)

    expect(result).toMatchObject({ status: 'ok', unmet: ['Workout Tops'] })
    expect(result.status === 'ok' && result.groups.map(g => g.label)).toEqual(['Shoes', 'Sports Accessories'])
  })

  it('returns no_match when nothing is kept, and when the plan has no needs', async () => {
    const dropAll = setup({ plan: workout, keep: () => [] })
    expect(await findProducts({ request: 'x' }, dropAll.deps)).toEqual({ status: 'no_match', unmet: ['Shoes', 'Sports Accessories'] })

    const nothing = setup({ plan: { needs: [] } })
    expect(await findProducts({ request: 'books' }, nothing.deps)).toEqual({ status: 'no_match', unmet: ['books'] })
    expect(nothing.model.calls).toEqual(['plan'])
  })

  it('reports catalog failures as catalog_unavailable', async () => {
    const repo = createFakeRepository({ search: unavailable, listByCategory: unavailable })
    const model = searchModel({ plan: workout })

    expect(await findProducts({ request: 'shoes' }, { repo, model, categories })).toEqual({ status: 'catalog_unavailable' })
  })

  it('still throws unexpected errors', async () => {
    const repo = createFakeRepository({ listByCategory: async () => { throw new RangeError('bug') } })
    const model = searchModel({ plan: workout })

    await expect(findProducts({ request: 'shoes' }, { repo, model, categories })).rejects.toThrow('bug')
  })

  it('logs its model calls to the step log, tagged by stage', async () => {
    const sink = memorySink()
    const { deps } = setup({ plan: workout })

    await findProducts({ request: 'workout gear' }, { ...deps, log: modelCallLog(sink, 'call-7') })

    expect(sink.records.map(r => [r.chatId, r.scope])).toEqual([
      ['tool:call-7', 'findProducts:plan'],
      ['tool:call-7', 'findProducts:relevance'],
    ])
  })
})

describe('search plan', () => {
  it('caps needs and queries, trims and dedupes searches, and puts categories first', () => {
    const plan = normalizePlan({
      needs: [
        { label: ' Shoes ', categories: ['mens-shoes', 'mens-shoes'], searches: [' Sneaker', 'sneaker', 'trainer', 'cleat'] },
        { label: '', categories: [], searches: [] },
        { label: 'C', categories: [], searches: [] },
        { label: 'D', categories: [], searches: [] },
      ],
    })

    expect(plan.needs).toHaveLength(MAX_NEEDS)
    expect(plan.needs[0]).toEqual({
      label: 'Shoes',
      queries: [{ kind: 'category', slug: 'mens-shoes' }, { kind: 'search', q: 'sneaker' }, { kind: 'search', q: 'trainer' }],
    })
    expect(plan.needs[0]!.queries).toHaveLength(MAX_QUERIES_PER_NEED)
    expect(plan.needs[1]).toEqual({ label: 'Results', queries: [] })
  })
})

describe('relevance prompt', () => {
  it('shows tags and shipping time for each candidate', () => {
    const tagged = product({ id: 9, title: 'Trail Runner', category: 'mens-shoes', brand: 'Acme', tags: ['footwear', 'athletic shoes'], shippingInformation: 'Ships overnight' })

    expect(buildRelevancePrompt('shoes', [{ label: 'Shoes', candidates: [tagged] }]))
      .toContain('- #9 Trail Runner · mens-shoes · Acme · tags: footwear, athletic shoes · Ships overnight · Trail Runner.')
  })

  it('lists each need with its candidates, which the fake model can read back', () => {
    const prompt = buildRelevancePrompt('gear', [
      { label: 'Shoes', candidates: [sneakers, trainers] },
      { label: 'Tops', candidates: [] },
      { label: 'Balls', candidates: [basketball] },
    ])

    expect(prompt).toContain('<request>gear</request>')
    expect(prompt).toContain('## Need 2: Tops\n(no candidates)')
    expect(offeredIdsByNeed(prompt)).toEqual([[3, 4], [], [1]])
  })
})
