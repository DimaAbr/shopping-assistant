import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { loadConfig } from '../../config/env.ts'
import { createModelRegistry } from '../../agent/models.ts'
import { createChatService } from '../../agent/chat-service.ts'
import { buildInstructions } from '../../agent/prompt.ts'
import { createShoppingTools } from '../../agent/tools.ts'
import { createDummyJsonRepository } from '../../domain/product-repository.ts'
import { openDatabase } from '../../store/db.ts'
import { createChatStore } from '../../store/chat-store.ts'
import { jsonlFileSink } from '../../observability/step-log.ts'
import { HELP, parseCommand, resolveChatRef } from './commands.ts'
import { chatLabel, dim, formatChatList, formatReplay, traceLine } from './render.ts'

/**
 * Console REPL — a thin adapter over the core (02 §4).
 * Chats are saved after every reply. `/sessions` lists and switches chats,
 * `/new` starts one, `/exit` (or Ctrl+D) quits. Ctrl+C quits immediately.
 */

/** How long `/exit` waits for a pending chat title before giving up on it. */
const EXIT_GRACE_MS = 5000

const config = loadConfigOrExit()
const models = createModelRegistry(config)
const repo = createDummyJsonRepository({ baseUrl: config.catalogBaseUrl })
const db = await openDatabaseOrExit()
const store = createChatStore(db)
const categories = await loadCategoriesOrExit()

const service = createChatService({
  store,
  userId: await store.ensureDefaultUser(),
  model: models.getModel('chat'),
  summarizer: models.getModel('summarizer'),
  instructions: buildInstructions(categories),
  tools: createShoppingTools(repo, categories),
  maxSteps: config.maxSteps,
  logSink: jsonlFileSink(config.stepLogPath),
  // Title failures are harmless (the list falls back to the first message), and
  // printing mid-prompt would garble the input line — so they're dropped.
})

let chat = service.newChat()

const rl = createInterface({ input: stdin, output: stdout, prompt: '\nyou> ' })

// Ctrl+C quits immediately, even mid-reply. An unfinished turn isn't saved.
rl.on('SIGINT', () => {
  stdout.write('\nbye\n')
  process.exit(0)
})

// EOF can arrive while a reply is still streaming; don't prompt a closed interface.
let inputClosed = false
rl.on('close', () => { inputClosed = true })

const saved = (await service.listChats()).length
stdout.write(`model: ${config.models.chat} — ${categories.length} categories — ${saved} saved chat${saved === 1 ? '' : 's'}\n`)
stdout.write(dim(`new chat · ${HELP}`) + '\n')
rl.prompt()

// Iterating the interface buffers lines typed during a reply and ends cleanly
// on EOF (Ctrl+D / piped input) — after the current turn has finished.
for await (const raw of rl) {
  const command = parseCommand(raw)
  if (command.kind === 'exit') break

  switch (command.kind) {
    case 'empty': break
    
    case 'message':
      await reply(command.text);
      break

    case 'help':
      stdout.write(dim(HELP) + '\n');
      break

    case 'unknown':
      stdout.write(dim(`unknown command /${command.name} — ${HELP}`) + '\n');
      break

    case 'new':
      chat = service.newChat()
      stdout.write(dim('new chat') + '\n')
      break

    case 'sessions':
      stdout.write(formatChatList(await service.listChats(), chat.chatId) + '\n')
      break

    case 'switch': {
      const target = resolveChatRef(command.ref, await service.listChats())
      if ('error' in target) {
        stdout.write(dim(target.error) + '\n')
        break
      }
      chat = await service.openChat(target.id)
      stdout.write(dim(`── ${chatLabel(target)} ──`) + '\n' + formatReplay(chat.history) + '\n')
      break
    }
  }

  if (!inputClosed) rl.prompt()
}

rl.close()
await Promise.race([service.settled(), new Promise(resolve => setTimeout(resolve, EXIT_GRACE_MS).unref())])
db.close()
stdout.write('bye\n')


async function reply(text: string) {
  stdout.write('assistant> ')

  try {
    const turn = await chat.send(text)
    for await (const part of turn.fullStream) {
      if (part.type === 'text-delta') stdout.write(part.text)
      if (part.type === 'tool-result') stdout.write(`\n${traceLine(part.toolName, part.input, part.output)}\n`)
      if (part.type === 'tool-error') stdout.write(`\n${traceLine(part.toolName, part.input, undefined)}\n`)
    }
    await turn.done
  } catch (error) {
    stdout.write(`\n[error] ${error instanceof Error ? error.message : String(error)} (not saved)`)
  }
  stdout.write('\n')
}

async function openDatabaseOrExit() {
  try {
    return await openDatabase(config.databaseUrl)
  } catch (error) {
    console.error(`Can't open the chat database at ${config.databaseUrl}: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
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
