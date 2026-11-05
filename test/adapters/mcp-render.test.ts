import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '../../src/adapters/mcp/render.ts'
import type { ProductListing } from '../../src/domain/product-card.ts'

const listing: ProductListing = {
  id: 7,
  title: 'Red Lipstick',
  description: 'A bold red.',
  price: 12.5,
  currency: 'USD',
  imageUrl: 'https://cdn.dummyjson.com/red.webp',
  category: 'beauty',
  rating: 4.56,
}

describe('renderMarkdown', () => {
  it('renders one section per group, with image, facts and description', () => {
    const markdown = renderMarkdown({ status: 'ok', groups: [{ label: 'Lipstick', products: [listing] }], unmet: [] })
    expect(markdown).toBe([
      '## Lipstick',
      '',
      '![Red Lipstick](https://cdn.dummyjson.com/red.webp)',
      '**Red Lipstick** (#7) — $12.50 · ★4.6',
      'A bold red.',
    ].join('\n'))
  })

  it('adds brand and shipping when present', () => {
    const markdown = renderMarkdown({
      status: 'ok',
      groups: [{ label: 'Lipstick', products: [{ ...listing, brand: 'Glow', shippingInformation: 'Ships in 1 week' }] }],
      unmet: [],
    })
    expect(markdown).toContain('— $12.50 · ★4.6 · Glow · Ships in 1 week')
  })

  it('ends with the unmet needs', () => {
    const markdown = renderMarkdown({ status: 'ok', groups: [{ label: 'Lipstick', products: [listing] }], unmet: ['Mascara', 'Perfume'] })
    expect(markdown.endsWith('\n\nNothing found for: Mascara, Perfume.')).toBe(true)
  })

  it('says when nothing matched', () => {
    expect(renderMarkdown({ status: 'no_match', unmet: ['Books'] })).toBe('No products matched.\n\nNothing found for: Books.')
    expect(renderMarkdown({ status: 'no_match', unmet: [] })).toBe('No products matched.')
  })

  it('says when the catalog is down', () => {
    expect(renderMarkdown({ status: 'catalog_unavailable' })).toMatch(/can't be reached/)
  })
})
