import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Layering rules from 02 §4 / 03 "Cross-cutting rules", checked by scanning imports.
 * (Stands in for an ESLint import-boundary rule — no lint toolchain needed.)
 */

const SRC = resolve(import.meta.dirname, '../src')

/** Which top-level `src/` folders each layer may import from. */
const ALLOWED_LAYER_DEPS: Record<string, string[]> = {
  config:        [],
  domain:        [],
  store:         ['domain'],
  observability: [],
  agent:         ['domain', 'store', 'config', 'observability'],
  adapters:      ['agent', 'domain', 'store', 'config', 'observability'],
}

/** Only these files may import a provider package. */
const PROVIDER_PACKAGES = /^@ai-sdk\//
const PROVIDER_ALLOWED  = ['agent/models.ts']

/** The domain layer must not depend on the AI SDK at all. */
const AI_SDK = /^(ai(\/.*)?|@ai-sdk\/.*)$/

type Import = { file: string, layer: string, specifier: string }

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(path => /\.tsx?$/.test(path))
    .map(path => path.split(sep).join('/'))
}

function importsOf(file: string): Import[] {
  const code = readFileSync(join(SRC, file), 'utf8')
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm
  return [...code.matchAll(pattern)].map(match => ({
    file,
    layer:     file.split('/')[0]!,
    specifier: match[1]!,
  }))
}

function targetLayer(imp: Import): string | undefined {
  if (!imp.specifier.startsWith('.')) return undefined
  const target = relative(SRC, resolve(SRC, dirname(imp.file), imp.specifier)).split(sep).join('/')
  return target.split('/')[0]
}

const allImports = sourceFiles().flatMap(importsOf)
const describeImport = (imp: Import) => `${imp.file} -> ${imp.specifier}`

describe('architecture', () => {
  it('every src/ folder is a known layer', () => {
    const layers = new Set(sourceFiles().map(file => file.split('/')[0]))
    for (const layer of layers) expect(Object.keys(ALLOWED_LAYER_DEPS)).toContain(layer)
  })

  it('layers only import from allowed layers', () => {
    const violations = allImports.filter(imp => {
      const target = targetLayer(imp)
      return target !== undefined
          && target !== imp.layer
          && !ALLOWED_LAYER_DEPS[imp.layer]?.includes(target)
    })
    expect(violations.map(describeImport)).toEqual([])
  })

  it('only the model registry imports provider packages', () => {
    const violations = allImports.filter(imp =>
      PROVIDER_PACKAGES.test(imp.specifier) && !PROVIDER_ALLOWED.includes(imp.file))
    expect(violations.map(describeImport)).toEqual([])
  })

  it('domain does not import the AI SDK', () => {
    const violations = allImports.filter(imp => imp.layer === 'domain' && AI_SDK.test(imp.specifier))
    expect(violations.map(describeImport)).toEqual([])
  })
})
