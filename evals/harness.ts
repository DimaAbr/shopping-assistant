import { appendFileSync, mkdirSync } from 'node:fs'

import { createChatSession, type ChatSession } from '../src/agent/chat.ts'
import { createChatService } from '../src/agent/chat-service.ts'
import { createModelRegistry } from '../src/agent/models.ts'
import { buildInstructions } from '../src/agent/prompt.ts'
import { createShoppingTools, type ShoppingToolResult, type ShoppingTools } from '../src/agent/tools.ts'
import { loadConfig } from '../src/config/env.ts'
import { createDummyJsonRepository } from '../src/domain/product-repository.ts'
import { jsonlFileSink } from '../src/observability/step-log.ts'
import { createChatStore, DEFAULT_USER_ID } from '../src/store/chat-store.ts'
import { openDatabase } from '../src/store/db.ts'
import type { Memory } from '../src/store/types.ts'

/**
 * A tiny eval harness: run a conversation against the real model + catalog,
 * score it with code-based checks, repeat N times, require a pass rate.
 * (evalite would do this, but doesn't support our vitest / AI SDK versions — see 05.)
 */

export const TRIALS = Number(process.env.EVAL_TRIALS ?? 5)
export const REQUIRED = Math.ceil(TRIALS * 0.8) // 4/5
const RESULTS_PATH = 'logs/evals/results.jsonl'

export type ToolCall = { toolName: string, input: Record<string, unknown> }
export type TurnRecord = {
  user: string
  reply: string
  toolCalls: ToolCall[]
  results: ShoppingToolResult[]
  /** With `Conversation`: the memories stored after this turn (the chat's and lasting ones). */
  memories?: Memory[]
}

/**
 * Several chats of one user, in order, through the chat service with memory
 * (10): an in-memory DB, the `memory` model and a recent window. Each turn waits
 * for memory extraction, so the next turn sees its result.
 */
export type Conversation = { chats: string[][], historyWindow?: number }

/** A check returns `undefined` on success, or a short reason on failure. */
export type Check = (turns: TurnRecord[]) => string | undefined

const config = loadConfig()
const models = createModelRegistry(config)
const repo = createDummyJsonRepository({ baseUrl: config.catalogBaseUrl })
export const categories = await repo.listCategories()

export type CatalogEntry = { id: number, title: string, price: number, availabilityStatus: string }

/** The whole catalog (title, price, availability), for the grounding checks only. */
export const catalog: CatalogEntry[] = await (async () => {
  const response = await fetch(new URL('/products?limit=0&select=title,price,availabilityStatus', config.catalogBaseUrl))
  const body = await response.json() as { products: CatalogEntry[] }
  return body.products
})()

export async function converse(userTurns: string[]): Promise<TurnRecord[]> {
  const logSink = jsonlFileSink('logs/eval-steps.jsonl')

  const session = createChatSession({
    model: models.getModel('chat'),
    chatId: `eval-${crypto.randomUUID()}`,
    instructions: buildInstructions(categories),
    tools: createShoppingTools(repo, categories, { searchModel: models.getModel('searcher'), logSink }),
    maxSteps: config.maxSteps,
    stepTimeoutMs: config.stepTimeoutMs,
    logSink,
  })

  const turns: TurnRecord[] = []
  for (const user of userTurns)
    turns.push(await runTurn(session, user))
  return turns
}

export async function converseWithMemory(conversation: Conversation): Promise<TurnRecord[]> {
  const logSink = jsonlFileSink('logs/eval-steps.jsonl')
  const db = await openDatabase(':memory:')
  const store = createChatStore(db)

  const service = createChatService({
    store,
    model: models.getModel('chat'),
    summarizer: models.getModel('summarizer'),
    memoryModel: models.getModel('memory'),
    instructions: memories => buildInstructions(categories, memories),
    tools: createShoppingTools(repo, categories, { searchModel: models.getModel('searcher'), logSink }),
    historyWindow: conversation.historyWindow ?? config.historyWindow,
    maxSteps: config.maxSteps,
    stepTimeoutMs: config.stepTimeoutMs,
    logSink,
    onBackgroundError: (error, { task }) => console.log(`[memory eval] ${task} failed: ${error instanceof Error ? error.message : error}`),
  })
  const chats = service.forUser(DEFAULT_USER_ID)

  try {
    const turns: TurnRecord[] = []
    for (const userTurns of conversation.chats) {
      const session = chats.newChat()
      for (const user of userTurns) {
        const record = await runTurn(session, user)
        await service.settled()
        record.memories = await store.loadMemories(DEFAULT_USER_ID, session.chatId)
        turns.push(record)
      }
    }
    return turns
  } finally {
    db.close()
  }
}

async function runTurn(session: ChatSession<ShoppingTools>, user: string): Promise<TurnRecord> {
  const record: TurnRecord = { user, reply: '', toolCalls: [], results: [] }

  const turn = await session.send(user)
  for await (const part of turn.fullStream) {
    if (part.type === 'text-delta') record.reply += part.text
    if (part.type === 'tool-call') record.toolCalls.push({ toolName: part.toolName, input: part.input as Record<string, unknown> })
    if (part.type === 'tool-result') record.results.push(part.output as ShoppingToolResult)
  }
  await turn.done

  return record
}

export type TrialOutcome = { passed: boolean, failures: string[], turns: TurnRecord[] }

/** Runs the case TRIALS times in parallel, logs the outcome, returns the pass count. */
export async function runCase(name: string, userTurns: string[] | Conversation, checks: Check[]) {
  const outcomes = await Promise.all(Array.from({ length: TRIALS }, async (): Promise<TrialOutcome> => {
    try {
      const turns = Array.isArray(userTurns)
        ? await converse(userTurns)
        : await converseWithMemory(userTurns)

      const failures = checks
        .map(check => check(turns))
        .filter((reason): reason is string => reason !== undefined)

      return { passed: failures.length === 0, failures, turns }
    } catch (error) {
      return { passed: false, failures: [`error: ${error instanceof Error ? error.message : error}`], turns: [] }
    }
  }))

  const passes = outcomes.filter(outcome => outcome.passed).length

  mkdirSync('logs/evals', { recursive: true })
  appendFileSync(RESULTS_PATH, JSON.stringify({
    ts: new Date().toISOString(),
    model: config.models.chat,
    case: name,
    passes,
    trials: TRIALS,
    failures: outcomes
      .filter(o => !o.passed)
      .map(o => ({ failures: o.failures, turns: o.turns })),
  }) + '\n')

  for (const outcome of outcomes.filter(o => !o.passed)) {
    const failures = outcome.failures.join('; ')
    const lastReply = outcome.turns.at(-1)?.reply.replaceAll('\n', ' ') ?? '-'
    console.log(`[${name}] FAILED: ${failures}\n  last reply: ${lastReply}`)
  }
  
  return passes
}
