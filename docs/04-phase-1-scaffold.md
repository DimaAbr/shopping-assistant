# 04 — Phase 1: Scaffold & console chat

The phase plan and record for [03-roadmap.md](03-roadmap.md) phase 1. Decisions that change 02 are also noted there, with dates.

## Decisions (2026-11-03)

| Topic | Decision | Notes |
|---|---|---|
| Runtime | **Node 26** (current LTS). `engines >=26`, `.nvmrc` / `.node-version` | Node 22 is close to end of life |
| Package manager | **pnpm**, **single package** | Split into a workspace in phase 5, when the Vite client arrives. `pnpm-workspace.yaml` exists only for pnpm's `allowBuilds` (esbuild, which tsx needs) |
| Provider | **`@ai-sdk/openai`** (`OPENAI_API_KEY`) | `gpt-6-luna` through the Responses API (logged as `openai.responses`) |
| TypeScript | **TS 7**, `tsc --noEmit` for type checks, `tsx` to run | `.ts` import extensions (`allowImportingTsExtensions`) |
| Formatting | **No formatter** | Formatting is written by hand, on purpose |
| Lint | **No ESLint.** Layering rules are enforced by `test/architecture.test.ts` instead | typescript-eslint 8.x supports only `typescript <6.1`, so it doesn't work with TS 7. An import-scanning test covers what we wanted from lint, with no extra toolchain |
| Env loading | `process.loadEnvFile()` (built into Node), if `.env` exists | No dotenv. Real env vars override the file |

## Layout

```
src/
  config/env.ts            zod-validated config (API key, model per role, MAX_STEPS, STEP_LOG_PATH)
  agent/models.ts          role-based model registry: the only importer of @ai-sdk/*
  agent/chat.ts            chat session: in-memory ModelMessage[] history, streamText + step limit
  observability/step-log.ts  per-step records → JSONL (or in-memory sink for tests)
  adapters/cli/main.ts     readline REPL
test/
  agent/chat.test.ts       mock-model tests (ai/test MockLanguageModelV4)
  architecture.test.ts     layering rules (02 §4)
```

`domain/` and `store/` don't exist yet. They come in phases 2 and 3, and the architecture test already has rules for them.

## Behaviour worth knowing

- **Failed turns are rolled back.** If the model call errors, the user message is removed from history, so a retry doesn't send two user messages in a row.
- **Error surfacing:** on a stream error, AI SDK v7 rejects `responseMessages` with a generic `NoOutputGeneratedError`. The real cause only reaches `onError`. `chat.ts` captures it and rethrows the real cause.
- **`textStream` never throws.** Callers must `await turn.done` to see errors.
- **CLI exit:** Ctrl+C exits immediately. EOF (Ctrl+D or piped input) lets the current turn finish first.
- **Step log record:** `ts, chatId, turn, step, model, finishReason, usage{input,output,total}, toolCalls[{toolName,input}], toolResultBytes, latencyMs`. Latency is measured from `onStepStart` to `onStepEnd`.

## How to run

```sh
pnpm install
cp .env.example .env      # set OPENAI_API_KEY
pnpm chat                 # /exit, Ctrl+C or Ctrl+D to quit
pnpm test
pnpm typecheck
```

## Status — done (2026-11-03)

- [x] `pnpm chat`: a multi-turn streamed conversation on Linux (WSL), checked against the real model. Turn 2 remembered turn 1.
- [x] `pnpm chat` on **Windows**: checked by the user (2026-11-03)
- [x] `pnpm test` passes (mock-model chat tests + architecture tests)
- [x] The step log shows token usage and finish reason for every step
- [x] Checked on Node 26.13.0: install, typecheck, tests, CLI startup
