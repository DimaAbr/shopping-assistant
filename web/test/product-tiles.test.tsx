import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { ShoppingToolResult } from 'shopping-assistant/contract'

import { ProductTiles } from '../src/ui/ProductTiles.tsx'

afterEach(cleanup)

/** The `output` of a stored `tool-searchProducts` part, as the history endpoint returns it (07). */
const stored: ShoppingToolResult = {
  status: 'ok',
  total: 1,
  products: [{
    id: 1,
    title: 'Red Lipstick',
    description: 'The Red Lipstick is a classic and bold choice for adding a pop of color to your lips.',
    price: 12.99,
    currency: 'USD',
    imageUrl: 'https://cdn.dummyjson.com/products/images/beauty/Red%20Lipstick/thumbnail.png',
    category: 'beauty',
    rating: 4.5,
    brand: 'Chic Cosmetics',
  }],
}

type Props = ComponentProps<typeof ProductTiles>

/** Only the fields the tiles read; the runtime's tool methods aren't used. */
const renderTiles = (props: { args: Props['args'], result?: ShoppingToolResult }) =>
  render(<ProductTiles {...({ toolName: 'searchProducts', ...props } as unknown as Props)} />)

describe('ProductTiles', () => {
  it('renders a card per product: image, title, price, description', () => {
    renderTiles({ args: { query: 'lipstick' }, result: stored })

    const list = screen.getByRole('list', { name: 'Results for lipstick' })
    expect(list.querySelectorAll('li')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Red Lipstick' })).toBeTruthy()
    expect(screen.getByText(/12\.99/)).toBeTruthy()
    expect(screen.getByText(/classic and bold choice/)).toBeTruthy()
    expect(list.querySelector('img')?.getAttribute('src')).toBe(stored.status === 'ok' ? stored.products[0]!.imageUrl : '')
  })

  it('shows a placeholder while the tool is running', () => {
    renderTiles({ args: { category: 'beauty' } })
    expect(screen.getByLabelText('Searching for beauty').getAttribute('aria-busy')).toBe('true')
  })

  it('says so when nothing was found', () => {
    renderTiles({ args: { query: 'unicorn' }, result: { status: 'empty' } })
    expect(screen.getByText('No products found for “unicorn”.')).toBeTruthy()
  })

  it('reports an unavailable catalog as an alert', () => {
    renderTiles({ args: { query: 'lipstick' }, result: { status: 'catalog_unavailable' } })
    expect(screen.getByRole('alert').textContent).toContain('unavailable')
  })
})
