import { z } from 'zod'

/**
 * The product fields we work with (05 "Product model", 09 "Product fields").
 *
 * dummyjson returns much more (stock counts, warranty, reviews, images, …).
 * Those keys are stripped on parse — the agent can't mention what we don't
 * model, which is the point. Weight and dimensions are left out on purpose:
 * their values are unitless and carry no meaning (09).
 *
 * - `tags`: only the search's relevance step sees them.
 * - `availabilityStatus`: only code uses it ("Out of Stock" is filtered out).
 * - `shippingInformation`: relevance, the chat model and the tiles all see it.
 */

export const ProductSchema = z.object({
  id:          z.number().int(),
  title:       z.string(),
  description: z.string(),
  category:    z.string(),
  price:       z.number(),
  rating:      z.number(),
  brand:       z.string().optional(),
  thumbnail:   z.string(),
  tags:        z.array(z.string()).default([]),
  /** "In Stock" / "Low Stock" / "Out of Stock". Missing means unknown, treated as available. */
  availabilityStatus:  z.string().optional(),
  /** Free text from the API, e.g. "Ships in 1 week". */
  shippingInformation: z.string().optional(),
})

export type Product = z.infer<typeof ProductSchema>

export const ProductPageSchema = z.object({
  products: z.array(ProductSchema),
  total:    z.number().int(),
})

/** A page of results: `products` may be shorter than `total`. */
export type ProductPage = z.infer<typeof ProductPageSchema>

export const CategoryListSchema = z.array(z.string().min(1))
