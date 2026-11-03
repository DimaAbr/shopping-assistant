import { describe, expect, it } from 'vitest'

import { createShoppingTools, DEFAULT_LIMIT, toModelOutput, type ShoppingToolResult } from '../../src/agent/tools.ts'
import { categories, createFakeRepository, lipstick, unavailable } from '../helpers/fake-repository.ts'

const options = { toolCallId: 'call-1', messages: [], context: {} } as never

function tools(overrides?: Parameters<typeof createFakeRepository>[0]) {
  const repo = createFakeRepository(overrides)
  return { repo, tools: createShoppingTools(repo, categories) }
}

describe('shopping tools', () => {
  it('searchProducts returns ok with products and total', async () => {
    const { repo, tools: t } = tools()

    const result = await t.searchProducts.execute!({ query: 'lipstick' }, options) as ShoppingToolResult

    expect(result).toEqual({ status: 'ok', total: 1, products: lipstick.products })
    expect(repo.calls).toEqual([{ method: 'search', args: ['lipstick', DEFAULT_LIMIT] }])
  })

  it('browseCategory passes the slug and limit through', async () => {
    const { repo, tools: t } = tools()

    const result = await t.browseCategory.execute!({ category: 'smartphones', limit: 2 }, options) as ShoppingToolResult

    expect(result).toMatchObject({ status: 'ok', total: 16 })
    expect(result.status === 'ok' && result.products).toHaveLength(2)
    expect(repo.calls).toEqual([{ method: 'listByCategory', args: ['smartphones', 2] }])
  })

  it('reports empty results as status "empty"', async () => {
    const { tools: t } = tools()
    expect(await t.searchProducts.execute!({ query: 'surfboard' }, options)).toEqual({ status: 'empty' })
    expect(await t.browseCategory.execute!({ category: 'vehicle' }, options)).toEqual({ status: 'empty' })
  })

  it('reports catalog failures as status "catalog_unavailable" instead of throwing', async () => {
    const { tools: t } = tools({ search: unavailable, listByCategory: unavailable })
    expect(await t.searchProducts.execute!({ query: 'lipstick' }, options)).toEqual({ status: 'catalog_unavailable' })
    expect(await t.browseCategory.execute!({ category: 'beauty' }, options)).toEqual({ status: 'catalog_unavailable' })
  })

  it('still throws unexpected errors (bugs are not "catalog unavailable")', async () => {
    const { tools: t } = tools({ search: async () => { throw new RangeError('bug') } })
    await expect(t.searchProducts.execute!({ query: 'lipstick' }, options)).rejects.toThrow('bug')
  })

  it('only accepts real category slugs', () => {
    const { tools: t } = tools()
    const schema = t.browseCategory.inputSchema as unknown as { safeParse(value: unknown): { success: boolean } }

    expect(schema.safeParse({ category: 'smartphones' }).success).toBe(true)
    expect(schema.safeParse({ category: 'books' }).success).toBe(false)
  })

  it('rejects limits above the maximum and empty queries', () => {
    const { tools: t } = tools()
    const schema = t.searchProducts.inputSchema as unknown as { safeParse(value: unknown): { success: boolean } }

    expect(schema.safeParse({ query: 'lipstick', limit: 50 }).success).toBe(false)
    expect(schema.safeParse({ query: '   ' }).success).toBe(false)
  })

  it('needs at least one category', () => {
    expect(() => createShoppingTools(createFakeRepository(), [])).toThrow()
  })
})

describe('model output', () => {
  it('sends exactly the modelled fields, without the thumbnail', () => {
    const output = toModelOutput({ status: 'ok', total: 1, products: lipstick.products })

    expect(output).toMatchObject({ status: 'ok', total: 1, shown: 1 })
    const product = output.status === 'ok' ? output.products[0]! : undefined
    expect(Object.keys(product!).sort()).toEqual(['brand', 'category', 'description', 'id', 'price', 'rating', 'title'])
    expect(JSON.stringify(output)).not.toContain('cdn.dummyjson.com')
  })

  it('passes non-ok statuses through unchanged', () => {
    expect(toModelOutput({ status: 'empty' })).toEqual({ status: 'empty' })
    expect(toModelOutput({ status: 'catalog_unavailable' })).toEqual({ status: 'catalog_unavailable' })
  })
})
