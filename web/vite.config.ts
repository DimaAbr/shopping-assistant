import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Dev: `/api/*` is proxied to the Hono API (`pnpm api`, default port 3000),
 * so the page and the API share an origin and need no CORS (08).
 */
const apiTarget = process.env.API_URL ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: apiTarget, rewrite: path => path.replace(/^\/api/, '') },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
