import { defineConfig } from 'vitest/config'

/**
 * Behaviour evals (02 §11) — real model, real catalog, on demand only: `pnpm eval`.
 * Kept apart from the unit tests: no network guard, long timeouts.
 */

export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    testTimeout: 10 * 60_000,
    hookTimeout: 60_000,
  },
})
