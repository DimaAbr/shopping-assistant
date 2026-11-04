import { generateText, Output, type LanguageModel } from 'ai'
import { z } from 'zod'
import type { CatalogQuery } from '../../domain/product-search.ts'
import type { ModelCallLog } from './log.ts'

/**
 * Step 1 of `findProducts` (09): turn the shopper's request into needs, each
 * with a few catalog queries. One structured-output call, no tools.
 *
 * This is the only place that knows how dummyjson search behaves (02 §14.1 #1),
 * so neither the chat agent nor an MCP host has to.
 */

export const MAX_NEEDS = 3
export const MAX_QUERIES_PER_NEED = 3

export type Need = { label: string, queries: CatalogQuery[] }
export type SearchPlan = { needs: Need[] }

export function buildPlanInstructions(categories: readonly string[]): string {
  return `You plan product searches for an online store's catalog. You never talk to the shopper.

# Catalog categories (slugs)
${categories.map(slug => `- ${slug}`).join('\n')}

A category name is only a hint about what it holds. The results are checked against the request afterwards.

# Keyword search
A keyword search matches the whole keyword as ONE case-insensitive substring of a product title or description.
Use a short SINGULAR phrase in the word order it would appear in a title: "sneaker", "running shoe", "lipstick", "laptop".
Never a sentence, never plurals ("laptops" finds nothing), never a price, never an audience word on its own.

# Your task
Split the request into 1–${MAX_NEEDS} needs: the distinct kinds of product the shopper is asking for ("Shoes", "Sports accessories").
For each need:
- label: a short display heading in Title Case, 1–3 words, as it would appear above a group of products.
- categories: the category slugs that hold this kind of product AND fit the shopper (audience, age, purpose). Usually 1–2.
- searches: 0–2 keyword searches for specific items the categories might miss.
- At most ${MAX_QUERIES_PER_NEED} queries per need in total (categories + searches).
- If nothing in this catalog could match a need, still list it with no categories and no searches, so it is reported as not found.
Prices are filtered separately: ignore budgets when choosing queries.`
}

function planSchema(categories: readonly string[]) {
  return z.object({
    needs: z.array(z.object({
      label: z.string(),
      categories: z.array(z.enum(categories as [string, ...string[]])),
      searches: z.array(z.string()),
    })),
  })
}

export async function planSearch(options: {
  model: LanguageModel
  request: string
  categories: readonly string[]
  log?: ModelCallLog
}): Promise<SearchPlan> {
  const { output } = await generateText({
    model: options.model,
    instructions: buildPlanInstructions(options.categories),
    prompt: `<request>${options.request}</request>`,
    output: Output.object({ schema: planSchema(options.categories), name: 'search_plan' }),
    ...options.log?.('plan'),
  })
  return normalizePlan(output)
}

/** Applies the caps in code (the schema doesn't), trims queries and drops duplicates. */
export function normalizePlan(raw: { needs: Array<{ label: string, categories: string[], searches: string[] }> }): SearchPlan {
  return {
    needs: raw.needs.slice(0, MAX_NEEDS).map(need => {
      const queries: CatalogQuery[] = [
        ...unique(need.categories).map(slug => ({ kind: 'category' as const, slug })),
        ...unique(need.searches.map(q => q.trim().toLowerCase()).filter(q => q !== '')).map(q => ({ kind: 'search' as const, q })),
      ]
      return { label: need.label.trim() || 'Results', queries: queries.slice(0, MAX_QUERIES_PER_NEED) }
    }),
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
