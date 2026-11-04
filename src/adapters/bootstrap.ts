import { loadConfig } from '../config/env.ts'
import { createModelRegistry } from '../agent/models.ts'
import { createChatService, type ChatServiceOptions } from '../agent/chat-service.ts'
import { buildInstructions } from '../agent/prompt.ts'
import { createShoppingTools, type ShoppingTools } from '../agent/tools.ts'
import { createDummyJsonRepository } from '../domain/product-repository.ts'
import { openDatabase } from '../store/db.ts'
import { createChatStore } from '../store/chat-store.ts'
import { jsonlFileSink } from '../observability/step-log.ts'

/**
 * The core, wired from config: what every adapter's `main.ts` starts with.
 * Startup failures (bad config, no DB, catalog down) print one line and exit.
 */

export async function bootstrap(options: Pick<ChatServiceOptions<ShoppingTools>, 'onBackgroundError'> = {}) {
  const config = await orExit(async () => loadConfig(), message)
  const models = createModelRegistry(config)
  const repo = createDummyJsonRepository({ baseUrl: config.catalogBaseUrl })

  const db = await orExit(
    () => openDatabase(config.databaseUrl),
    error => `Can't open the chat database at ${config.databaseUrl}: ${message(error)}`,
  )
  const store = createChatStore(db)

  const categories = await orExit(
    () => repo.listCategories(),
    error => `Can't load the product categories from ${config.catalogBaseUrl}: ${message(error)}`,
  )

  const service = createChatService({
    store,
    userId: await store.ensureDefaultUser(),
    model: models.getModel('chat'),
    summarizer: models.getModel('summarizer'),
    instructions: buildInstructions(categories),
    tools: createShoppingTools(repo, categories),
    maxSteps: config.maxSteps,
    logSink: jsonlFileSink(config.stepLogPath),
    onBackgroundError: options.onBackgroundError,
  })

  return { config, db, categories, service }
}

async function orExit<T>(run: () => Promise<T>, describe: (error: unknown) => string): Promise<T> {
  try {
    return await run()
  } catch (error) {
    console.error(describe(error))
    process.exit(1)
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
