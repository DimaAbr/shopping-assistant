import type { ToolCallMessagePartComponent } from '@assistant-ui/react'
import type { ProductListing, ShoppingToolResult } from 'shopping-assistant/contract'

import styles from './ProductTiles.module.css'

/**
 * The product widget: renders a `searchProducts` / `browseCategory` tool part,
 * live while streaming and from stored history (07, "Product card contract").
 */

type ToolArgs = { query?: string, category?: string }

export const ProductTiles: ToolCallMessagePartComponent<ToolArgs, ShoppingToolResult> = ({ args, result }) => {
  const target = args.query ?? args.category
  const labelSuffix = target ? ` for “${target}”` : '';

  if (result === undefined) {
    return (
      <div className={styles.tiles} aria-busy="true" aria-label={`Searching${labelSuffix}`}>
        {[0, 1, 2].map(i => <div key={i} className={`${styles.tile} ${styles.skeleton}`} />)}
      </div>
    )
  }

  switch (result.status) {
    case 'ok':
      return (
        <ul className={styles.tiles} aria-label={`Results${labelSuffix}`}>
          {result.products.map(product => <ProductTile key={product.id} product={product} />)}
        </ul>
      )
    case 'empty':
      return <p className={styles.note}>No products found{labelSuffix}.</p>
    case 'catalog_unavailable':
      return <p className={`${styles.note} ${styles.error}`} role="alert">The catalog is unavailable right now.</p>
  }
}

function ProductTile({ product }: { product: ProductListing }) {
  return (
    <li className={styles.tile}>
      <img className={styles.image} src={product.imageUrl} alt="" loading="lazy" />
      <div className={styles.body}>
        <h3 className={styles.title}>{product.title}</h3>
        <p className={styles.price}>{formatPrice(product.price, product.currency)}</p>
        <p className={styles.description}>{product.description}</p>
      </div>
    </li>
  )
}

function formatPrice(price: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(price)
}
