import { createStepLogger, type StepLogSink } from '../../observability/step-log.ts'

/**
 * Step logging for the model calls inside `findProducts` (09, "Persistence").
 * They go to the step log only, never into chat history. Each record is tagged
 * with `scope: findProducts:<stage>` and keyed by the tool call that ran them.
 */

/** Returns the `onStepStart` / `onStepEnd` options for one stage's `generateText` call. */
export type ModelCallLog = (stage: string) => ReturnType<typeof createStepLogger>

export function modelCallLog(sink: StepLogSink, toolCallId: string): ModelCallLog {
  return stage => createStepLogger({ chatId: `tool:${toolCallId}`, turn: 0, scope: `findProducts:${stage}`, sink })
}
