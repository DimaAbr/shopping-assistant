import type { ToolCallMessagePartComponent } from '@assistant-ui/react'
import type { ProductListing, ShoppingToolResult } from 'shopping-assistant/contract'

import styles from './ProductTiles.module.css'

/**
 * The product widget: renders a `findProducts` tool part, live while streaming
 * and from stored history (07 "Product card contract", 09). One section per
 * group, under the group's label.
 */

type ToolArgs = { request?: string, minPrice?: number, maxPrice?: number }

export const ProductTiles: ToolCallMessagePartComponent<ToolArgs, ShoppingToolResult> = ({ result }) => {
  if (result === undefined) {
    return (
      <div className={styles.results} aria-busy="true" aria-label="Searching">
        <div className={styles.tiles}>
          {[0, 1, 2].map(i => <div key={i} className={`${styles.tile} ${styles.skeleton}`} />)}
        </div>
      </div>
    )
  }

  switch (result.status) {
    case 'ok':
      return (
        <div className={styles.results}>
          {result.groups.map(group => (
            <section key={group.label} className={styles.group} aria-label={group.label}>
              {result.groups.length > 1 && <h3 className={styles.groupLabel}>{group.label}</h3>}
              <ul className={styles.tiles}>
                {group.products.map(product => <ProductTile key={product.id} product={product} />)}
              </ul>
            </section>
          ))}
        </div>
      )
    case 'no_match':
      return <p className={styles.note}>No matching products found.</p>
    case 'catalog_unavailable':
      return <p className={`${styles.note} ${styles.error}`} role="alert">The catalog is unavailable right now.</p>
  }
}

function ProductTile({ product }: { product: ProductListing }) {
  return (
    <li className={styles.tile}>
      <img className={styles.image} src={product.imageUrl} alt="" loading="lazy" />
      <div className={styles.body}>
        <h4 className={styles.title}>{product.title}</h4>
        <p className={styles.price}>{formatPrice(product.price, product.currency)}</p>
        {product.shippingInformation && <p className={styles.shipping}>{product.shippingInformation}</p>}
        <p className={styles.description}>{product.description}</p>
      </div>
    </li>
  )
}

function formatPrice(price: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(price)
}
