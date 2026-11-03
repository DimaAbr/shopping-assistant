import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { loadConfig } from '../../config/env.ts'
import { createModelRegistry } from '../../agent/models.ts'
import { createChatSession } from '../../agent/chat.ts'
import { jsonlFileSink } from '../../observability/step-log.ts'

/**
 * Console REPL — a thin adapter over the core (02 §4).
 * `/exit`, Ctrl+C or Ctrl+D to quit.
 */

const config  = loadConfigOrExit()
const models  = createModelRegistry(config)
const session = createChatSession({
  model:        models.getModel('chat'),
  chatId:       randomUUID(),
  instructions: 'You are a friendly, concise personal shopping assistant.',
  maxSteps:     config.maxSteps,
  logSink:      jsonlFileSink(config.stepLogPath),
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

stdout.write(`chat ${session.chatId} — model: ${config.models.chat} — /exit to quit\n`)
rl.prompt()

// Iterating the interface buffers lines typed during a reply and ends cleanly
// on EOF (Ctrl+D / piped input) — after the current turn has finished.
for await (const raw of rl) {
  const line = raw.trim()
  if (line === '/exit') break

  if (line !== '') {
    stdout.write('assistant> ')
    const turn = session.send(line)
    for await (const chunk of turn.textStream) stdout.write(chunk)

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


function loadConfigOrExit() {
  try {
    return loadConfig()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
