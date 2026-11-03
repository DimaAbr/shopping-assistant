import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { StepResult, ToolSet } from 'ai'

/**
 * Per-step logging for the tool loop (02 §12).
 *
 * One record per model call ("step"), so that "why did the model do that?"
 * can be answered from a local file instead of a SaaS dashboard.
 */

export type StepLogRecord = {
  ts:              string
  chatId:          string
  turn:            number
  step:            number
  model:           string
  finishReason:    string
  usage: {
    input:         number | undefined
    output:        number | undefined
    total:         number | undefined
  }
  toolCalls:       Array<{ toolName: string, input: unknown }>
  toolResultBytes: number
  latencyMs:       number
}

export type StepLogSink = (record: StepLogRecord) => void

/** Appends one JSON object per line. Creates the directory on first use. */
export function jsonlFileSink(path: string): StepLogSink {
  let dirReady = false
  return record => {
    if (!dirReady) {
      mkdirSync(dirname(path), { recursive: true })
      dirReady = true
    }
    appendFileSync(path, JSON.stringify(record) + '\n')
  }
}

/** Collects records in memory — for tests. */
export function memorySink(): StepLogSink & { records: StepLogRecord[] } {
  const records: StepLogRecord[] = []
  return Object.assign((record: StepLogRecord) => { records.push(record) }, { records })
}

/**
 * Returns `onStepStart` / `onStepEnd` handlers for one turn.
 * Latency is measured per step, from the start of the model call to its end
 * (including tool execution, once there are tools).
 */
export function createStepLogger(context: { chatId: string, turn: number, sink: StepLogSink, now?: () => number }) {
  const now = context.now ?? performance.now.bind(performance)
  let stepStartedAt = now()

  return {
    onStepStart() {
      stepStartedAt = now()
    },

    onStepEnd<TOOLS extends ToolSet>(step: StepResult<TOOLS>) {
      context.sink({
        ts:           new Date().toISOString(),
        chatId:       context.chatId,
        turn:         context.turn,
        step:         step.stepNumber,
        model:        `${step.model.provider}:${step.model.modelId}`,
        finishReason: step.finishReason,
        usage: {
          input:  step.usage.inputTokens,
          output: step.usage.outputTokens,
          total:  step.usage.totalTokens,
        },
        toolCalls:       step.toolCalls.map(call => ({ toolName: call.toolName, input: call.input })),
        toolResultBytes: step.toolResults.reduce((sum, result) => sum + byteSize(result.output), 0),
        latencyMs:       Math.round(now() - stepStartedAt),
      })
    },
  }
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}
