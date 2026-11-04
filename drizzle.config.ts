import { defineConfig } from 'drizzle-kit'

/** `pnpm db:generate` writes a migration to `drizzle/` after a schema change. Migrations run at startup (src/store/db.ts). */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/store/schema.ts',
  out: './drizzle',
})
