import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModel } from 'ai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { createMcpApp, FAILURE_TEXT, mcpToolDescription, PRODUCT_TILES_URI, TIMEOUT_TEXT, type McpOptions } from '../../src/adapters/mcp/server.ts'
import { memorySink } from '../../src/observability/step-log.ts'
import { categories, createFakeRepository, lipstickListings, unavailable } from '../helpers/fake-repository.ts'
import { searchModel } from '../helpers/search-model.ts'

const URL_BASE = 'http://localhost/mcp'
const lipstickPlan = { needs: [{ label: 'Lipstick', searches: ['lipstick'] }] }

function setup(overrides: Partial<McpOptions> = {}) {
  const sink = memorySink()
  const errors: unknown[] = []
  const app = createMcpApp({
    repo: createFakeRepository(),
    searchModel: searchModel({ plan: lipstickPlan }),
    categories,
    logSink: sink,
    timeoutMs: 5_000,
    onToolError: error => errors.push(error),
    imageOrigins: ['https://cdn.example.com'],
    ...overrides,
  })
  return { app, sink, errors }
}

/** An MCP client whose HTTP requests go straight to the Hono app: no network. */
async function connect(app: ReturnType<typeof createMcpApp>) {
  const client = new Client({ name: 'test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(URL_BASE), {
    fetch: async (input, init) => await app.fetch(new Request(input, init)),
  })
  await client.connect(transport)
  return client
}

async function call(client: Client, args: Record<string, unknown>) {
  return await client.callTool({ name: 'findProducts', arguments: args }) as CallToolResult
}

const text = (result: CallToolResult) => result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')

describe('MCP endpoint', () => {
  it('lists exactly findProducts, with its input schema and calling guidance', async () => {
    const client = await connect(setup().app)
    const { tools } = await client.listTools()

    expect(tools.map(tool => tool.name)).toEqual(['findProducts'])
    const [tool] = tools
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(['request', 'minPrice', 'maxPrice'])
    expect(tool!.inputSchema.required).toEqual(['request'])
    expect(tool!.description).toBe(mcpToolDescription(categories))
    expect(tool!.annotations?.readOnlyHint).toBe(true)
  })

  it('without the widget, has no MCP App: no UI link and no resources', async () => {
    const client = await connect(setup().app)
    const { tools } = await client.listTools()

    expect(tools[0]!._meta?.ui).toBeUndefined()
    expect(client.getServerCapabilities()?.resources).toBeUndefined()
  })

  it('with the widget, links the tool to it and serves it with the image CSP', async () => {
    const client = await connect(setup({ appHtml: '<!doctype html><p>tiles</p>' }).app)
    const { tools } = await client.listTools()
    expect(tools[0]!._meta?.ui).toEqual({ resourceUri: PRODUCT_TILES_URI })

    const { contents } = await client.readResource({ uri: PRODUCT_TILES_URI })
    expect(contents).toEqual([{
      uri: PRODUCT_TILES_URI,
      mimeType: 'text/html;profile=mcp-app',
      text: '<!doctype html><p>tiles</p>',
      _meta: { ui: { csp: { resourceDomains: ['https://cdn.example.com'] }, prefersBorder: false } },
    }])

    const result = await call(client, { request: 'red lipstick' })
    expect(result.structuredContent).toEqual({ status: 'ok', groups: [{ label: 'Lipstick', products: lipstickListings }], unmet: [] })
  })

  it('returns the products as markdown and the whole result as structured content', async () => {
    const client = await connect(setup().app)
    const result = await call(client, { request: 'red lipstick' })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ status: 'ok', groups: [{ label: 'Lipstick', products: lipstickListings }], unmet: [] })
    for (const product of lipstickListings) {
      expect(text(result)).toContain(`### ${product.title}`)
      expect(text(result)).toContain(`$${product.price.toFixed(2)}`)
      expect(text(result)).toContain(`](${product.imageUrl})`)
    }
  })

  it('reports catalog failures as a normal result, not a tool error', async () => {
    const client = await connect(setup({ repo: createFakeRepository({ search: unavailable }) }).app)
    const result = await call(client, { request: 'lipstick' })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ status: 'catalog_unavailable' })
    expect(text(result)).toMatch(/can't be reached/)
  })

  it('rejects a blank request and negative prices', async () => {
    const client = await connect(setup().app)

    for (const args of [{ request: '   ' }, { request: 'shoes', maxPrice: -1 }]) {
      const result = await call(client, args).catch(error => ({ isError: true, content: [{ type: 'text', text: String(error) }] }) as CallToolResult)
      expect(result.isError).toBe(true)
    }
  })

  it('logs the workflow model calls under a per-call mcp id', async () => {
    const { app, sink } = setup()
    const client = await connect(app)
    await call(client, { request: 'red lipstick' })
    await call(client, { request: 'red lipstick' })

    expect(sink.records.map(record => record.scope)).toEqual(['findProducts:plan', 'findProducts:relevance', 'findProducts:plan', 'findProducts:relevance'])
    const ids = sink.records.map(record => record.chatId)
    expect(ids.every(id => id.startsWith('tool:mcp-'))).toBe(true)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('cuts off a search that runs past the timeout', async () => {
    const hanging = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) => new Promise((_resolve, reject) => {
        abortSignal?.addEventListener('abort', () => reject(abortSignal.reason))
      }),
    }) as unknown as LanguageModel
    const { app, errors } = setup({ searchModel: hanging, timeoutMs: 50 })
    const client = await connect(app)
    const result = await call(client, { request: 'red lipstick' })

    expect(result.isError).toBe(true)
    expect(text(result)).toBe(TIMEOUT_TEXT)
    expect(errors).toEqual([])
  })

  it('reports other failures as a tool error, and passes them to onToolError', async () => {
    const broken = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('model down') } }) as unknown as LanguageModel
    const { app, errors } = setup({ searchModel: broken })
    const client = await connect(app)
    const result = await call(client, { request: 'red lipstick' })

    expect(result.isError).toBe(true)
    expect(text(result)).toBe(FAILURE_TEXT)
    expect(errors).toHaveLength(1)
  })

  it('is stateless: GET and DELETE are 405', async () => {
    const { app } = setup()
    expect((await app.request(URL_BASE)).status).toBe(405)
    expect((await app.request(URL_BASE, { method: 'DELETE' })).status).toBe(405)
  })

  it('only accepts local requests', async () => {
    const { app } = setup()
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }

    expect((await app.request('http://shop.example/mcp', init)).status).toBe(403)
    expect((await app.request(URL_BASE, { ...init, headers: { ...init.headers, origin: 'https://evil.example' } })).status).toBe(403)
  })
})
