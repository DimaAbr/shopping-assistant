import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { ProductListing, ShoppingToolResult } from 'shopping-assistant/contract'

import { ProductTiles } from '../src/ui/ProductTiles.tsx'

afterEach(cleanup)

const lipstick: ProductListing = {
  id: 1,
  title: 'Red Lipstick',
  description: 'The Red Lipstick is a classic and bold choice for adding a pop of color to your lips.',
  price: 12.99,
  currency: 'USD',
  imageUrl: 'https://cdn.dummyjson.com/products/images/beauty/Red%20Lipstick/thumbnail.png',
  category: 'beauty',
  rating: 4.5,
  brand: 'Chic Cosmetics',
  shippingInformation: 'Ships in 1 week',
}

const ball: ProductListing = { ...lipstick, id: 2, title: 'Basketball', price: 14.99, category: 'sports-accessories' }
const sneakers: ProductListing = { ...lipstick, id: 3, title: 'Sports Sneakers', price: 119.99, category: 'mens-shoes' }

/** The `output` of a stored `tool-findProducts` part, as the history endpoint returns it (07, 09). */
const single: ShoppingToolResult = { status: 'ok', groups: [{ label: 'Lipstick', products: [lipstick] }], unmet: [] }

const grouped: ShoppingToolResult = {
  status: 'ok',
  groups: [{ label: 'Shoes', products: [sneakers] }, { label: 'Sports Accessories', products: [ball] }],
  unmet: ['Workout Tops'],
}

type Props = ComponentProps<typeof ProductTiles>

/** Only the fields the tiles read; the runtime's tool methods aren't used. */
const renderTiles = (result?: ShoppingToolResult) =>
  render(<ProductTiles {...({ toolName: 'findProducts', args: { request: 'stuff' }, result } as unknown as Props)} />)

describe('ProductTiles', () => {
  it('renders a card per product: image, title, price, description', () => {
    renderTiles(single)

    const list = screen.getByRole('list')
    expect(list.querySelectorAll('li')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Red Lipstick' })).toBeTruthy()
    expect(screen.getByText(/12\.99/)).toBeTruthy()
    expect(screen.getByText(/classic and bold choice/)).toBeTruthy()
    expect(list.querySelector('img')?.getAttribute('src')).toBe(lipstick.imageUrl)
  })

  it('shows the shipping time when there is one', () => {
    renderTiles(single)
    expect(screen.getByText('Ships in 1 week')).toBeTruthy()

    cleanup()
    const { shippingInformation: _shipping, ...noShipping } = lipstick
    renderTiles({ status: 'ok', groups: [{ label: 'Lipstick', products: [noShipping] }], unmet: [] })
    expect(screen.queryByText(/Ships/)).toBeNull()
  })

  it('shows one labelled section per group, and no heading for a single group', () => {
    renderTiles(grouped)

    const shoes = screen.getByRole('region', { name: 'Shoes' })
    expect(within(shoes).getByRole('heading', { name: 'Shoes' })).toBeTruthy()
    expect(within(shoes).getByText('Sports Sneakers')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Sports Accessories' })).getByText('Basketball')).toBeTruthy()

    cleanup()
    renderTiles(single)
    expect(screen.queryByRole('heading', { name: 'Lipstick' })).toBeNull()
  })

  it('shows a placeholder while the tool is running', () => {
    renderTiles()
    expect(screen.getByLabelText('Searching').getAttribute('aria-busy')).toBe('true')
  })

  it('says so when nothing matched', () => {
    renderTiles({ status: 'no_match', unmet: ['Unicorns'] })
    expect(screen.getByText('No matching products found.')).toBeTruthy()
  })

  it('reports an unavailable catalog as an alert', () => {
    renderTiles({ status: 'catalog_unavailable' })
    expect(screen.getByRole('alert').textContent).toContain('unavailable')
  })
})
