import { createOpenAI } from '@ai-sdk/openai'
import { customProvider, type LanguageModel } from 'ai'
import type { Config } from '../config/env.ts'

/**
 * Role-based model registry (02 §2).
 *
 * This is the ONLY module that knows which provider is in use — the
 * architecture test enforces that nothing else imports `@ai-sdk/*`.
 * Everything else asks for a role and gets a provider-agnostic `LanguageModel`.
 */

export type ModelRole = 'chat' | 'summarizer' | 'judge'

export type ModelRegistry = {
  getModel(role: ModelRole): LanguageModel
}

export function createModelRegistry(config: Pick<Config, 'openaiApiKey' | 'models'>): ModelRegistry {
  const openai = createOpenAI({ apiKey: config.openaiApiKey })

  const provider = customProvider({
    languageModels: {
      chat:       openai(config.models.chat),
      summarizer: openai(config.models.summarizer),
      judge:      openai(config.models.judge),
    },
  })

  return {
    getModel: role => provider.languageModel(role),
  }
}
