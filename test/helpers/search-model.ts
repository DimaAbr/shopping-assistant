import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'

import { generatedText } from './mock-model.ts'

/**
 * A scripted `searcher` model for the `findProducts` workflow (09).
 *
 * - The planning call answers with `plan`, or `plan(request)`.
 * - The relevance call answers with `keep(need, offeredIds)` for each need.
 *   The default keeps every candidate, in the order offered.
 *
 * The two calls are told apart by their instructions, so the order of calls
 * doesn't matter.
 */

export type RawPlan = { needs: Array<{ label: string, categories?: string[], searches?: string[] }> }

export function searchModel(options: { plan: RawPlan | ((request: string) => RawPlan), keep?: (need: number, offered: number[]) => number[] }) {
  const keep = options.keep ?? ((_need, offered) => offered)
  const calls: Array<'plan' | 'relevance'> = []

  const model = new MockLanguageModelV4({
    doGenerate: async (call: LanguageModelV4CallOptions) => {
      const system = call.prompt.find(message => message.role === 'system')?.content ?? ''
      if (system.includes('You plan product searches')) {

        calls.push('plan')
        const plan = typeof options.plan === 'function'
          ? options.plan(userText(call).replace(/^<request>|<\/request>$/g, ''))
          : options.plan

        return generatedText(JSON.stringify({
          needs: plan.needs.map(need => ({ label: need.label, categories: need.categories ?? [], searches: need.searches ?? [] })),
        }))
      }

      calls.push('relevance')
      const needs = offeredIdsByNeed(userText(call)).map((offered, index) => ({ need: index + 1, keep: keep(index + 1, offered) }))
      return generatedText(JSON.stringify({ needs }))
    },
  })
  return Object.assign(model, { calls })
}

function userText(call: LanguageModelV4CallOptions): string {
  return call.prompt
    .filter(message => message.role === 'user')
    .flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []))
    .join('\n')
}

/** The candidate ids under each `## Need n:` heading of the relevance prompt. */
export function offeredIdsByNeed(prompt: string): number[][] {
  return prompt
    .split(/^## Need \d+:.*$/m)
    .slice(1)
    .map(section => [...section.matchAll(/^- #(\d+) /gm)].map(match => Number(match[1])))
}

/**
 * A plan for the recorded fixtures (see `createFakeRepository`): "lipstick"
 * searches for lipstick, "phone" lists smartphones, anything else plans nothing.
 */
export function fixturePlan(request: string): RawPlan {
  const needs: RawPlan['needs'] = []
  if (/lipstick/i.test(request)) needs.push({ label: 'Lipstick', searches: ['lipstick'] })
  if (/phone/i.test(request)) needs.push({ label: 'Smartphones', categories: ['smartphones'] })
  return { needs }
}
