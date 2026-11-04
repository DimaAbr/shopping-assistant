import { serve } from '@hono/node-server'

import { bootstrap } from '../bootstrap.ts'
import { createApi } from './app.ts'

/**
 * HTTP API server — `pnpm api` (07). Ctrl+C / SIGTERM stops accepting requests,
 * then waits briefly for running turns and pending chat titles before closing the DB.
 */

/** How long shutdown waits for running turns and titles. */
const SHUTDOWN_GRACE_MS = 10_000

const { config, db, categories, service } = await bootstrap({
  onBackgroundError: (error, { chatId, task }) => console.error(`[${task}] chat ${chatId}:`, error),
})

const api = createApi({
  service,
  onTurnError: (error, { chatId }) => console.error(`[turn] chat ${chatId} (not saved):`, error),
})

const server = serve({ fetch: api.app.fetch, port: config.port }, info => {
  console.log(`model: ${config.models.chat} — ${categories.length} categories`)
  console.log(`listening on http://localhost:${info.port}`)
})

let stopping = false

async function shutdown() {
  if (stopping) process.exit(1)   // a second Ctrl+C quits right away
  stopping = true
  console.log('shutting down…')

  server.close()
  await Promise.race([
    Promise.all([api.settled(), service.settled()]),
    new Promise(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()),
  ])
  db.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
