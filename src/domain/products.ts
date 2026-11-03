import { z } from 'zod'

/**
 * The product fields this phase works with (05, "Product model").
 *
 * dummyjson returns much more (stock, warranty, shipping, reviews, images, …).
 * Those keys are stripped on parse — the agent can't mention what we don't
 * model, which is the point. They come back with phase 2b features.
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
})

export type Product = z.infer<typeof ProductSchema>

export const ProductPageSchema = z.object({
  products: z.array(ProductSchema),
  total:    z.number().int(),
})

/** A page of results: `products` may be shorter than `total`. */
export type ProductPage = z.infer<typeof ProductPageSchema>

export const CategoryListSchema = z.array(z.string().min(1))
