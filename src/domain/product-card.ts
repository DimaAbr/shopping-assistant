import { z } from 'zod'
import type { Product } from './products.ts'

/**
 * What the tools return per product: the wire contract for in-chat product
 * widgets (07, "Product card contract").
 *
 * - `ProductCard` is what a widget renders: title, description, price, image.
 *   The description is sent whole; trimming it is the widget's job.
 * - `ProductListing` adds the fields the model uses. The model never sees
 *   `imageUrl` (see `toModelOutput` in agent/tools.ts).
 *
 * Images are CDN URLs, never base64 (02 §9).
 */

export const ProductCardSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(),
  price: z.number(),
  /** dummyjson prices carry no currency; they are USD. */
  currency: z.literal('USD'),
  imageUrl: z.string(),
})

export type ProductCard = z.infer<typeof ProductCardSchema>

export const ProductListingSchema = ProductCardSchema.extend({
  category: z.string(),
  rating: z.number(),
  brand: z.string().optional(),
})

export type ProductListing = z.infer<typeof ProductListingSchema>

export function toProductListing(product: Product): ProductListing {
  return {
    id: product.id,
    title: product.title,
    description: product.description,
    price: product.price,
    currency: 'USD',
    imageUrl: product.thumbnail,
    category: product.category,
    rating: product.rating,
    ...(product.brand === undefined ? {} : { brand: product.brand }),
  }
}
