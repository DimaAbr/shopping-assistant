import { generateText, Output, type LanguageModel } from 'ai'
import { z } from 'zod'
import type { Product } from '../../domain/products.ts'
import type { ModelCallLog } from './log.ts'

/**
 * Step 3 of `findProducts` (09): keep only the candidates the shopper would
 * plausibly want, per need, best first. One structured-output call.
 *
 * The model only picks ids. Anything it returns that wasn't offered for that
 * need is dropped, so it can't add products.
 */

const DESCRIPTION_LENGTH = 160

export const RELEVANCE_INSTRUCTIONS = `You filter product search results for an online store. You never talk to the shopper.

You get the shopper's request and, for each need, a list of candidate products from the catalog.
For each need, return the ids of the candidates the shopper would plausibly want to see for that need, best match first.

- Judge each product against the need and the whole request: audience (men, women, kids, a boy or a girl), purpose, activity and style.
- Drop clear misfits: products that only share a word with the request, or are made for a different audience or purpose (high heels are not sports shoes).
- Keep products that reasonably fit, even loosely. When the shopper names a kind of product, products of that kind fit unless the request rules them out. When unsure, keep: the shopper can narrow down later.
- Judge by title, tags and description, not by the category name alone.
- If the request says when the shopper needs it, drop products whose shipping time can't meet that. Otherwise ignore shipping.
- It's fine to keep none when nothing fits. Never invent ids, and only use ids listed under that need.
- Prices were already filtered: don't drop a product for its price.`

const relevanceSchema = z.object({
  needs: z.array(z.object({
    need: z.number().int().describe('The need number, as given.'),
    keep: z.array(z.number().int()).describe('Ids of the candidates to keep, best first.'),
  })),
})

export type NeedCandidates = { label: string, candidates: Product[] }

/** Kept ids per need, in the order of `needs`. */
export async function filterRelevant(options: {
  model: LanguageModel
  request: string
  needs: NeedCandidates[]
  log?: ModelCallLog
}): Promise<number[][]> {
  if (options.needs.every(need => need.candidates.length === 0)) return options.needs.map(() => [])

  const { output } = await generateText({
    model: options.model,
    instructions: RELEVANCE_INSTRUCTIONS,
    prompt: buildRelevancePrompt(options.request, options.needs),
    output: Output.object({ schema: relevanceSchema, name: 'relevant_products' }),
    ...options.log?.('relevance'),
  })

  return options.needs.map((need, index) => {
    const offered = new Set(need.candidates.map(product => product.id))
    const answer = output.needs.find(entry => entry.need === index + 1)
    return [...new Set(answer?.keep ?? [])].filter(id => offered.has(id))
  })
}

export function buildRelevancePrompt(request: string, needs: NeedCandidates[]): string {
  const sections = needs.map((need, index) => {
    const lines = need.candidates.length === 0
      ? ['(no candidates)']
      : need.candidates.map(describeCandidate)
    return `## Need ${index + 1}: ${need.label}\n${lines.join('\n')}`
  })
  return `<request>${request}</request>\n\n${sections.join('\n\n')}`
}

function describeCandidate(product: Product): string {
  const details = [
    product.category,
    product.brand,
    product.tags.length > 0 ? `tags: ${product.tags.join(', ')}` : undefined,
    product.shippingInformation,
    trim(product.description),
  ]
  return `- #${product.id} ${product.title} · ${details.filter(detail => detail !== undefined).join(' · ')}`
}

function trim(text: string): string {
  return text.length > DESCRIPTION_LENGTH
    ? text.slice(0, DESCRIPTION_LENGTH - 1).trimEnd() + '…'
    : text
}
