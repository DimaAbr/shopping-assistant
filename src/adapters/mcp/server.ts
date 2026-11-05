import { randomUUID } from 'node:crypto'
import { Hono, type MiddlewareHandler } from 'hono'
import type { LanguageModel } from 'ai'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { FindProductsInputSchema } from '../../agent/tools.ts'
import { findProducts } from '../../agent/search/find-products.ts'
import { modelCallLog } from '../../agent/search/log.ts'
import type { ProductRepository } from '../../domain/product-repository.ts'
import type { StepLogSink } from '../../observability/step-log.ts'
import { renderMarkdown } from './render.ts'

/**
 * The MCP endpoint (11): `findProducts`, the search workflow, as the one tool.
 *
 * - **Stateless.** The tool needs no user or chat, so there are no MCP sessions:
 *   every POST gets a fresh server and transport, and GET / DELETE are 405.
 * - **The calling guidance is in the description.** Our chat agent learns how
 *   to call `findProducts` from its system prompt; a host's model only sees the
 *   tool description, so the host-relevant rules are repeated there.
 * - **Results:** markdown with image links for the host and its model, and the
 *   whole `ShoppingToolResult` as `structuredContent`. There's no `outputSchema`:
 *   MCP needs an object schema and the result is a union.
 * - **Bounded:** each call is cut off after `timeoutMs`, like a chat step.
 * - **Local only:** requests must come to a localhost host, and from a localhost
 *   origin when they carry one (the spec's DNS-rebinding rule for local servers).
 */

export const MCP_PATH = '/mcp'

export const TIMEOUT_TEXT = 'The search took too long. Try again.'
export const FAILURE_TEXT = 'The search failed. Try again.'

export type McpOptions = {
  repo: ProductRepository
  /** The model for the workflow's own calls (the `searcher` role). */
  searchModel: LanguageModel
  categories: readonly string[]
  logSink?: StepLogSink
  timeoutMs: number
  /** A call that failed with something other than a timeout. */
  onToolError?: (error: unknown) => void
}

export function createMcpApp(options: McpOptions) {
  const app = new Hono()

  app.use(MCP_PATH, localhostOnly)

  app.post(MCP_PATH, async c => {
    const server = createMcpServer(options)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(c.req.raw)
    } finally {
      void server.close()
    }
  })

  app.on(['GET', 'DELETE'], MCP_PATH, c => c.json({ error: 'method not allowed: this MCP server is stateless' }, 405, { Allow: 'POST' }))

  return app
}

export function createMcpServer(options: McpOptions) {
  const server = new McpServer({ name: 'shopping-assistant', version: '0.0.0' })

  server.registerTool('findProducts', {
    title: 'Find products',
    description: mcpToolDescription(options.categories),
    inputSchema: FindProductsInputSchema,
    annotations: { readOnlyHint: true },
  }, async (input, extra): Promise<CallToolResult> => {
    const timeout = AbortSignal.timeout(options.timeoutMs)
    try {
      const result = await findProducts(input, {
        repo: options.repo,
        model: options.searchModel,
        categories: options.categories,
        log: options.logSink === undefined ? undefined : modelCallLog(options.logSink, `mcp-${randomUUID()}`),
        abortSignal: AbortSignal.any([extra.signal, timeout]),
      })
      return { content: [{ type: 'text', text: renderMarkdown(result) }], structuredContent: result }
    } catch (error) {
      if (timeout.aborted) return { content: [{ type: 'text', text: TIMEOUT_TEXT }], isError: true }
      options.onToolError?.(error)
      return { content: [{ type: 'text', text: FAILURE_TEXT }], isError: true }
    }
  })

  return server
}

/**
 * The host-relevant rules from the chat prompt (`buildInstructions`, "Using
 * findProducts" and "Grounding"). Pure, so it's testable. The categories are
 * the store's own list, fetched at startup, as in the chat prompt.
 */
export function mcpToolDescription(categories: readonly string[]): string {
  return [
    "Find products in an online store's catalog. Describe everything the shopper wants in ONE call, in plain words. " +
    'The search plans the catalog queries, filters out what doesn\'t fit, and returns the matches grouped by kind of product.',
    '',
    'How to call it:',
    '- One call per request, covering everything asked for ("accessories and shoes" is one call, not two).',
    '- Make the request self-contained: who the products are for, what for, when they are needed, and any preferences from the conversation.',
    "- Use only what you know about the person the products are for. For a gift, that person's details, not the shopper's own.",
    '- Put budgets in minPrice / maxPrice (USD), not in the request.',
    '- For a refinement ("something cheaper", "more for running"), call again with the updated request and prices.',
    '',
    'Reading the result:',
    '- Only the products returned exist for this store. Quote titles and prices exactly; never add products, specs, colours, sizes or stock details.',
    '- Every returned product is in stock. Prices are in USD.',
    '- "unmet" (or "Nothing found for") lists what had no match. Say so; don\'t fill the gap with other products.',
    "- status \"no_match\": nothing fit. status \"catalog_unavailable\": the catalog can't be reached; try again later.",
    '',
    `Category names are only hints of what the store holds: ${categories.join(', ')}. ` +
    'If a category could plausibly hold what the shopper wants, search before saying the store doesn\'t have it.',
  ].join('\n')
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Rejects requests to a non-localhost host, or from a non-localhost origin. */
const localhostOnly: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')
  const local = (url: string) => URL.canParse(url) && LOCAL_HOSTNAMES.has(new URL(url).hostname)
  if (!local(c.req.url) || (origin !== undefined && !local(origin)))
    return c.json({ error: 'forbidden: this MCP server only accepts local requests' }, 403)
  await next()
}
