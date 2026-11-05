import type { ProductListing } from '../../domain/product-card.ts'
import type { ShoppingToolResult } from '../../agent/tools.ts'

/**
 * The markdown fallback for MCP hosts (11): what a host without MCP Apps
 * shows, and what every host's model reads. One section per group, one
 * heading per product. Every line is its own block: a single newline is a
 * soft break in CommonMark, so the lines would run together, and hard breaks
 * (trailing spaces, `\`) aren't supported by every renderer. The full result
 * also goes out as `structuredContent`.
 */

export function renderMarkdown(result: ShoppingToolResult): string {
  switch (result.status) {
    case 'catalog_unavailable':
      return "The store's catalog can't be reached right now. Try again shortly."
    case 'no_match':
      return ['No products matched.', ...unmetLine(result.unmet)].join('\n\n')
    case 'ok':
      return [
        ...result.groups.map(group => [`## ${group.label}`, ...group.products.map(renderProduct)].join('\n\n')),
        ...unmetLine(result.unmet),
      ].join('\n\n')
  }
}

function renderProduct(product: ProductListing): string {
  const facts = [
    `$${product.price.toFixed(2)}`,
    `★${product.rating.toFixed(1)}`,
    ...(product.brand === undefined ? [] : [product.brand]),
    ...(product.shippingInformation === undefined ? [] : [product.shippingInformation]),
    `#${product.id}`,
  ]
  return [
    `### ${product.title}`,
    `![${product.title}](${product.imageUrl})`,
    facts.join(' · '),
    product.description,
  ].join('\n\n')
}

function unmetLine(unmet: readonly string[]): string[] {
  return unmet.length === 0 ? [] : [`Nothing found for: ${unmet.join(', ')}.`]
}
