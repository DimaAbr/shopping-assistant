import { describe, expect, it } from 'vitest'

import { ProductCardSchema, ProductListingSchema, toProductListing } from '../../src/domain/product-card.ts'
import { lipstick } from '../helpers/fake-repository.ts'

describe('product listing', () => {
  const product = lipstick.products[0]!

  it('maps a product to the card fields plus the model fields', () => {
    expect(toProductListing(product)).toEqual({
      id: 4,
      title: 'Red Lipstick',
      description: product.description,
      price: 12.99,
      currency: 'USD',
      imageUrl: product.thumbnail,
      category: 'beauty',
      rating: product.rating,
      brand: 'Chic Cosmetics',
      shippingInformation: 'Ships in 1 week',
    })
  })

  it('sends the full description (trimming is the widget\'s job)', () => {
    expect(toProductListing(product).description).toBe(product.description)
  })

  it('leaves out a missing brand or shipping time instead of sending undefined', () => {
    const { brand: _brand, shippingInformation: _shipping, ...bare } = product
    expect(Object.keys(toProductListing(bare))).not.toContain('brand')
    expect(Object.keys(toProductListing(bare))).not.toContain('shippingInformation')
  })

  it('never carries tags or the availability status to clients', () => {
    expect(Object.keys(toProductListing(product))).not.toContain('tags')
    expect(Object.keys(toProductListing(product))).not.toContain('availabilityStatus')
  })

  it('is a valid card and listing', () => {
    const listing = toProductListing(product)
    expect(ProductListingSchema.parse(listing)).toEqual(listing)
    expect(Object.keys(ProductCardSchema.parse(listing)).sort())
      .toEqual(['currency', 'description', 'id', 'imageUrl', 'price', 'title'])
  })
})
