import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { loadConfig } from '../../config/env.ts'
import { createModelRegistry } from '../../agent/models.ts'
import { createChatSession } from '../../agent/chat.ts'
import { buildInstructions } from '../../agent/prompt.ts'
import { createShoppingTools, type ShoppingToolResult } from '../../agent/tools.ts'
import { createDummyJsonRepository } from '../../domain/product-repository.ts'
import { jsonlFileSink } from '../../observability/step-log.ts'

/**
 * Console REPL — a thin adapter over the core (02 §4).
 * `/exit`, Ctrl+C or Ctrl+D to quit.
 */

const config = loadConfigOrExit()
const models = createModelRegistry(config)
const repo = createDummyJsonRepository({ baseUrl: config.catalogBaseUrl })
const categories = await loadCategoriesOrExit()
const session = createChatSession({
  model: models.getModel('chat'),
  chatId: randomUUID(),
  instructions: buildInstructions(categories),
  tools: createShoppingTools(repo, categories),
  maxSteps: config.maxSteps,
  logSink: jsonlFileSink(config.stepLogPath),
})

const rl = createInterface({ input: stdin, output: stdout, prompt: '\nyou> ' })

// Ctrl+C quits immediately, even mid-reply. (Nothing to lose yet — history is in memory.)
rl.on('SIGINT', () => {
  stdout.write('\nbye\n')
  process.exit(0)
})

// EOF can arrive while a reply is still streaming; don't prompt a closed interface.
let inputClosed = false
rl.on('close', () => { inputClosed = true })

stdout.write(`chat ${session.chatId} — model: ${config.models.chat} — ${categories.length} categories — /exit to quit\n`)
rl.prompt()

// Iterating the interface buffers lines typed during a reply and ends cleanly
// on EOF (Ctrl+D / piped input) — after the current turn has finished.
for await (const raw of rl) {
  const line = raw.trim()
  if (line === '/exit') break

  if (line !== '') {
    stdout.write('assistant> ')
    
    const turn = session.send(line)
    for await (const part of turn.fullStream) {
      if (part.type === 'text-delta') stdout.write(part.text)
      if (part.type === 'tool-result') stdout.write(traceLine(part.toolName, part.input, part.output))
      if (part.type === 'tool-error') stdout.write(traceLine(part.toolName, part.input, undefined))
    }

    try {
      await turn.done
    } catch (error) {
      stdout.write(`\n[error] ${error instanceof Error ? error.message : String(error)}`)
    }
    stdout.write('\n')
  }

  if (!inputClosed) rl.prompt()
}

rl.close()
stdout.write('bye\n')


/** A dim one-liner per tool call, so replies can be checked against what the tools returned. */
function traceLine(toolName: string, input: unknown, rawOutput: unknown) {
  // Both shopping tools return a ShoppingToolResult; `undefined` means the tool threw.
  const output = rawOutput as ShoppingToolResult | undefined

  const outcome = output === undefined
    ? 'error'
    : output.status !== 'ok'
      ? output.status
      : `${output.products.length} of ${output.total}: ${output.products.map(p => `#${p.id}`).join(' ')}`

  return `\x1b[2m\n· ${toolName} ${JSON.stringify(input)} → ${outcome}\x1b[0m\n`
}

async function loadCategoriesOrExit() {
  try {
    return await repo.listCategories()
  } catch (error) {
    console.error(`Can't load the product categories from ${config.catalogBaseUrl}: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

function loadConfigOrExit() {
  try {
    return loadConfig()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
