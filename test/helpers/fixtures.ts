import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Raw dummyjson responses recorded from the live API (2026-11-03). */

const DIR = resolve(import.meta.dirname, '../fixtures/dummyjson')

export function rawFixture(name: 'search-lipstick' | 'search-empty' | 'category-smartphones' | 'category-list'): unknown {
  return JSON.parse(readFileSync(resolve(DIR, `${name}.json`), 'utf8'))
}
