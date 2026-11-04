import { describe, expect, it } from 'vitest'

import { createShoppingTools, SHOPPING_TOOL_NAMES, ShoppingToolResultSchema, toModelOutput, type ShoppingToolResult } from '../../src/agent/tools.ts'
import type { ShoppingToolName } from '../../src/adapters/http/contract.ts'
import { ProductCardSchema } from '../../src/domain/product-card.ts'
import { memorySink } from '../../src/observability/step-log.ts'
import { categories, createFakeRepository, lipstickListings, unavailable } from '../helpers/fake-repository.ts'
import { searchModel } from '../helpers/search-model.ts'

const options = { toolCallId: 'call-1', messages: [], context: {} } as never

const lipstickPlan = { needs: [{ label: 'Lipstick', searches: ['lipstick'] }] }

function tools(overrides?: Parameters<typeof createFakeRepository>[0]) {
  const repo = createFakeRepository(overrides)
  const sink = memorySink()
  return { repo, sink, tools: createShoppingTools(repo, categories, { searchModel: searchModel({ plan: lipstickPlan }), logSink: sink }) }
}

const inputSchema = (t: ReturnType<typeof tools>['tools']) =>
  t.findProducts.inputSchema as unknown as { safeParse(value: unknown): { success: boolean } }

describe('findProducts tool', () => {
  it('runs the search workflow and returns grouped products in the widget contract', async () => {
    const { tools: t } = tools()

    const result = await t.findProducts.execute!({ request: 'red lipstick' }, options) as ShoppingToolResult
    
    expect(result).toEqual({ status: 'ok', groups: [{ label: 'Lipstick', products: lipstickListings }], unmet: [] })
    const parsed = ShoppingToolResultSchema.parse(result)
    for (const product of parsed.status === 'ok' ? parsed.groups.flatMap(g => g.products) : []) {
      expect(ProductCardSchema.safeParse(product).success).toBe(true)
      expect(product.imageUrl).toMatch(/^https:\/\/cdn\.dummyjson\.com\//)
    }
  })

  it('logs the workflow model calls under the tool call id', async () => {
    const { tools: t, sink } = tools()
    await t.findProducts.execute!({ request: 'red lipstick' }, options)
    expect(sink.records.map(r => r.scope)).toEqual(['findProducts:plan', 'findProducts:relevance'])
    expect(sink.records.every(r => r.chatId === 'tool:call-1')).toBe(true)
  })

  it('reports catalog failures as status "catalog_unavailable" instead of throwing', async () => {
    const { tools: t } = tools({ search: unavailable })
    expect(await t.findProducts.execute!({ request: 'lipstick' }, options)).toEqual({ status: 'catalog_unavailable' })
  })

  it('accepts a request with optional non-negative price bounds', () => {
    const { tools: t } = tools()
    const schema = inputSchema(t)

    expect(schema.safeParse({ request: 'running shoes', maxPrice: 100 }).success).toBe(true)
    expect(schema.safeParse({ request: 'running shoes', minPrice: 20, maxPrice: 100 }).success).toBe(true)
    expect(schema.safeParse({ request: '   ' }).success).toBe(false)
    expect(schema.safeParse({ request: 'shoes', maxPrice: -1 }).success).toBe(false)
  })

  it('exposes exactly the tool names in the client contract', () => {
    const { tools: t } = tools()
    const names: readonly ShoppingToolName[] = SHOPPING_TOOL_NAMES
    expect(Object.keys(t)).toEqual([...names])
  })

  it('needs at least one category', () => {
    expect(() => createShoppingTools(createFakeRepository(), [], { searchModel: searchModel({ plan: lipstickPlan }) })).toThrow()
  })
})

describe('model output', () => {
  it('sends the groups with exactly the modelled fields, without the image URL or currency', () => {
    const output = toModelOutput({ status: 'ok', groups: [{ label: 'Lipstick', products: lipstickListings }], unmet: ['Lip Liner'] })

    expect(output).toMatchObject({ status: 'ok', unmet: ['Lip Liner'] })
    const product = output.status === 'ok' ? output.groups[0]!.products[0]! : undefined
    expect(Object.keys(product!).sort()).toEqual(['brand', 'category', 'description', 'id', 'price', 'rating', 'shippingInformation', 'title'])
    expect(JSON.stringify(output)).not.toContain('cdn.dummyjson.com')
  })

  it('passes non-ok statuses through unchanged', () => {
    expect(toModelOutput({ status: 'no_match', unmet: ['Books'] })).toEqual({ status: 'no_match', unmet: ['Books'] })
    expect(toModelOutput({ status: 'catalog_unavailable' })).toEqual({ status: 'catalog_unavailable' })
  })
})
