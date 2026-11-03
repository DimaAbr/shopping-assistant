import { existsSync } from 'node:fs'
import { z } from 'zod'

/**
 * Process configuration, validated once at startup.
 *
 * `.env` is loaded with Node's built-in `process.loadEnvFile()` — no dotenv,
 * and it behaves the same on Windows. Variables already set in the real
 * environment win over the file.
 */

const DEFAULT_MODEL = 'gpt-6-luna'

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string({ error: 'is required (see .env.example)' }).min(1, 'is required (see .env.example)'),

  MODEL_CHAT: z.string().min(1).default(DEFAULT_MODEL),
  MODEL_SUMMARIZER: z.string().min(1).default(DEFAULT_MODEL),
  MODEL_JUDGE: z.string().min(1).default(DEFAULT_MODEL),

  MAX_STEPS: z.coerce.number().int().positive().default(5),
  STEP_LOG_PATH: z.string().min(1).default('logs/steps.jsonl'),

  DUMMYJSON_BASE_URL: z.url().default('https://dummyjson.com'),
})

export type Config = {
  openaiApiKey: string
  models: { chat: string, summarizer: string, judge: string }
  maxSteps: number
  stepLogPath: string
  catalogBaseUrl: string
}

export function loadConfig(envFile = '.env'): Config {
  if (existsSync(envFile)) process.loadEnvFile(envFile)

  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success)
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`)

  const env = parsed.data

  return {
    openaiApiKey: env.OPENAI_API_KEY,
    models: {
      chat: env.MODEL_CHAT,
      summarizer: env.MODEL_SUMMARIZER,
      judge: env.MODEL_JUDGE,
    },
    maxSteps: env.MAX_STEPS,
    stepLogPath: env.STEP_LOG_PATH,
    catalogBaseUrl: env.DUMMYJSON_BASE_URL,
  }
}
