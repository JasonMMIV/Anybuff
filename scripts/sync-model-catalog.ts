#!/usr/bin/env bun
/**
 * Regenerate the built-in models.dev catalog snapshot (plan §3.4, ADR-31).
 *
 *   bun scripts/sync-model-catalog.ts            # fetch → project → write
 *   bun scripts/sync-model-catalog.ts --check    # drift report (no write)
 *   bun scripts/sync-model-catalog.ts --stats    # coverage + size report
 *
 * Source: https://models.dev/api.json (MIT, Copyright (c) 2025 models.dev)
 *
 * The snapshot is a BUILD ARTEFACT — never hand-edit
 * `sdk/src/impl/model-catalog-snapshot.ts`. Re-run this script after the
 * quarterly verification (non-negotiable #5) or when a user reports a model
 * that models.dev knows but the app does not.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  MODEL_CATALOG_SCHEMA_VERSION,
  buildModelCatalogIndex,
  catalogContextWindow,
  catalogEfforts,
  catalogOutputTokens,
  lookupCatalogModel,
  projectModelsDevCatalog,
  type ProjectedCatalog,
} from '../sdk/src/impl/model-catalog'
import { ANYBUFF_PROVIDER_PRESETS } from '../sdk/src/provider-config'
import { VERIFIED_REASONING_EFFORTS } from '../sdk/src/impl/reasoning-effort'

const SOURCE_URL = 'https://models.dev/api.json'
const ROOT = path.resolve(import.meta.dir, '..')
const SNAPSHOT_PATH = path.join(
  ROOT,
  'sdk',
  'src',
  'impl',
  'model-catalog-snapshot.ts',
)
const FETCH_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024
const SIZE_TARGET_BYTES = 2 * 1024 * 1024
const SIZE_HARD_CAP_BYTES = 3 * 1024 * 1024

type Args = {
  check: boolean
  stats: boolean
  offline: boolean
}

function parseArgs(argv: string[]): Args {
  return {
    check: argv.includes('--check'),
    stats: argv.includes('--stats'),
    offline: argv.includes('--offline'),
  }
}

async function fetchCatalog(): Promise<unknown> {
  const response = await globalThis.fetch(SOURCE_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`models.dev responded ${response.status}`)
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `models.dev payload is ${text.length} bytes — over the ${MAX_RESPONSE_BYTES} byte cap`,
    )
  }
  return JSON.parse(text)
}

async function loadSnapshotPayload(): Promise<ProjectedCatalog> {
  // The generated file is a TS module; importing it keeps a single parser
  // (bun can import TS directly) and catches a corrupt artifact immediately.
  const mod = (await import(
    path.join(ROOT, 'sdk', 'src', 'impl', 'model-catalog-snapshot.ts')
  )) as {
    MODEL_CATALOG_PROVIDERS: ProjectedCatalog['providers']
    MODEL_CATALOG_MODELS: ProjectedCatalog['models']
    MODEL_CATALOG_SNAPSHOT_AT: string
    MODEL_CATALOG_SCHEMA_VERSION: number
  }
  return {
    schemaVersion:
      mod.MODEL_CATALOG_SCHEMA_VERSION ?? MODEL_CATALOG_SCHEMA_VERSION,
    snapshotAt: mod.MODEL_CATALOG_SNAPSHOT_AT,
    models: [...mod.MODEL_CATALOG_MODELS],
    providers: [...mod.MODEL_CATALOG_PROVIDERS],
  }
}

function renderSnapshotModule(payload: ProjectedCatalog): string {
  // One row per line: the file is a reviewable artefact, and a single 1 MB
  // JSON blob makes every quarterly sync diff unreadable. The extra newlines
  // cost ~30 KB, not the ~1.5 MB pretty-printing would.
  const modelsJson = payload.models
    .map((row) => `  ${JSON.stringify(row)}`)
    .join(',\n')
  const providersJson = payload.providers
    .map((row) => `  ${JSON.stringify(row)}`)
    .join(',\n')
  return `/**
 * AUTO-GENERATED — do not edit by hand.
 *
 * Regenerate with: bun scripts/sync-model-catalog.ts
 *
 * Source: ${SOURCE_URL}
 * Retrieved: ${payload.snapshotAt}
 * License: MIT — Copyright (c) 2025 models.dev
 * Attribution: docs/model-catalog-attribution.md
 *
 * Format: compact positional tuples (see sdk/src/impl/model-catalog.ts
 * CATALOG_MODEL_TUPLE) with a deduplicated model-row table. This keeps the
 * committed artefact around 1 MB while preserving every field AnyBuff reads
 * (limits, modalities, tool/structured-output/attachment flags, reasoning
 * options, interleaving, lifecycle status and full pricing).
 */

import type { CompactCatalogModelTuple, CompactCatalogProvider } from './model-catalog'

export const MODEL_CATALOG_SCHEMA_VERSION = ${payload.schemaVersion}
export const MODEL_CATALOG_SNAPSHOT_AT = ${JSON.stringify(payload.snapshotAt)}
export const MODEL_CATALOG_SOURCE_URL = ${JSON.stringify(SOURCE_URL)}

/** Deduplicated model rows referenced by MODEL_CATALOG_PROVIDERS. */
export const MODEL_CATALOG_MODELS: ReadonlyArray<CompactCatalogModelTuple> = [
${modelsJson}
]

/** [providerId, apiUrl | null, [[modelId, rowIndex], …]] sorted for stable diffs. */
export const MODEL_CATALOG_PROVIDERS: ReadonlyArray<CompactCatalogProvider> = [
${providersJson}
]
`
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function describeCatalog(payload: ProjectedCatalog) {
  const index = buildModelCatalogIndex(payload, {
    snapshotAt: payload.snapshotAt,
    source: 'snapshot',
  })
  let withInput = 0
  let withContext = 0
  let withReasoning = 0
  let withEffort = 0
  let withToggle = 0
  let withBudget = 0
  let withInterleaved = 0
  let withStatus = 0
  let withCost = 0
  let withImage = 0
  let withTool = 0
  for (const provider of index.providers.values()) {
    for (const model of provider.models.values()) {
      if (model.inputTokens !== undefined) withInput++
      if (model.contextWindow !== undefined) withContext++
      if (model.reasoning) withReasoning++
      if (model.reasoningOptions.some((option) => option.type === 'effort')) {
        withEffort++
      }
      if (model.reasoningOptions.some((option) => option.type === 'toggle')) {
        withToggle++
      }
      if (
        model.reasoningOptions.some((option) => option.type === 'budget_tokens')
      ) {
        withBudget++
      }
      if (model.interleaved) withInterleaved++
      if (model.status) withStatus++
      if (model.cost) withCost++
      if (model.modalitiesInput.includes('image')) withImage++
      if (model.toolCall) withTool++
    }
  }
  return {
    index,
    providers: index.providers.size,
    entries: index.size,
    withContext,
    withInput,
    withReasoning,
    withEffort,
    withToggle,
    withBudget,
    withInterleaved,
    withStatus,
    withCost,
    withImage,
    withTool,
  }
}

function reportStats(payload: ProjectedCatalog): void {
  const stats = describeCatalog(payload)
  const bytes = byteLength(JSON.stringify(payload))
  console.log('models.dev catalog projection')
  console.log(`  snapshotAt       ${payload.snapshotAt}`)
  console.log(`  providers        ${stats.providers}`)
  console.log(`  provider-models  ${stats.entries}`)
  console.log(`  unique rows      ${payload.models.length}`)
  console.log(`  projected bytes  ${bytes} (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
  console.log(`  target           <= ${SIZE_TARGET_BYTES} bytes; hard cap ${SIZE_HARD_CAP_BYTES}`)
  console.log('coverage')
  console.log(`  limit.context    ${stats.withContext}`)
  console.log(`  limit.input      ${stats.withInput}`)
  console.log(`  reasoning        ${stats.withReasoning}`)
  console.log(`  ... effort       ${stats.withEffort}`)
  console.log(`  ... toggle       ${stats.withToggle}`)
  console.log(`  ... budget       ${stats.withBudget}`)
  console.log(`  interleaved      ${stats.withInterleaved}`)
  console.log(`  status           ${stats.withStatus}`)
  console.log(`  cost             ${stats.withCost}`)
  console.log(`  image input      ${stats.withImage}`)
  console.log(`  tool_call        ${stats.withTool}`)
}

/**
 * Drift report between the catalog and the two hand-maintained layers:
 * presets (gateway/curated limits) and the reasoning seed table (verified
 * ladders with requestMap). Non-blocking by design — preset values may be
 * deliberately narrower than the lab native ones (plan §5.1/§9).
 */
function reportDrift(payload: ProjectedCatalog): number {
  const index = buildModelCatalogIndex(payload, {
    snapshotAt: payload.snapshotAt,
    source: 'snapshot',
  })
  const lines: string[] = []
  let problems = 0

  for (const [presetId, preset] of Object.entries(ANYBUFF_PROVIDER_PRESETS)) {
    const providers = preset.config.providers as
      | Record<
          string,
          {
            baseURL?: string
            models?: string[]
            modelCapabilities?: Record<
              string,
              { context?: { windowTokens?: number; outputTokens?: number } }
            >
          }
        >
      | undefined
    for (const [providerId, provider] of Object.entries(providers ?? {})) {
      const capabilities = provider.modelCapabilities ?? {}
      for (const model of provider.models ?? []) {
        const declared = capabilities[model]
        if (!declared?.context) continue
        const hit = lookupCatalogModel(index, {
          providerId,
          providerName: presetId,
          baseURL: provider.baseURL,
          model,
        })
        if (!hit) {
          lines.push(
            `missing  ${presetId}/${model} — not in models.dev (preset declares ${declared.context.windowTokens}/${declared.context.outputTokens})`,
          )
          problems++
          continue
        }
        const ctx = catalogContextWindow(hit.model)
        const out = catalogOutputTokens(hit.model)
        if (
          ctx !== undefined &&
          declared.context.windowTokens !== undefined &&
          ctx !== declared.context.windowTokens
        ) {
          lines.push(
            `window   ${presetId}/${model} preset=${declared.context.windowTokens} catalog=${ctx}`,
          )
          problems++
        }
        if (
          out !== undefined &&
          declared.context.outputTokens !== undefined &&
          out !== declared.context.outputTokens
        ) {
          lines.push(
            `output   ${presetId}/${model} preset=${declared.context.outputTokens} catalog=${out}`,
          )
          problems++
        }
      }
    }
  }

  for (const [model, row] of Object.entries(VERIFIED_REASONING_EFFORTS)) {
    const hit = lookupCatalogModel(index, {
      providerId: '',
      model,
    })
    if (!hit) continue
    const efforts = catalogEfforts(hit.model)
    if (efforts.length === 0) continue
    const declared = [...row.efforts].sort().join(',')
    const catalog = [...efforts].sort().join(',')
    if (declared !== catalog) {
      lines.push(
        `efforts  ${model} seed=[${declared}] catalog=[${catalog}] (seed ${row.verifiedAt}, ${row.source})`,
      )
    }
  }

  console.log(`drift report (snapshot ${payload.snapshotAt})`)
  if (lines.length === 0) {
    console.log('  no drift')
  } else {
    for (const line of lines) console.log(`  ${line}`)
  }
  return problems
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let payload: ProjectedCatalog

  if (args.check || args.offline) {
    payload = await loadSnapshotPayload()
  } else {
    const raw = await fetchCatalog()
    const snapshotAt = new Date().toISOString()
    payload = projectModelsDevCatalog(raw, { snapshotAt })
    if (payload.providers.length === 0) {
      throw new Error('models.dev payload projected to zero providers — refusing to write')
    }

    const rendered = renderSnapshotModule(payload)
    const size = byteLength(rendered)
    if (size > SIZE_HARD_CAP_BYTES) {
      throw new Error(
        `snapshot would be ${size} bytes — over the ${SIZE_HARD_CAP_BYTES} byte hard cap`,
      )
    }
    if (size > SIZE_TARGET_BYTES) {
      console.warn(
        `[sync-model-catalog] snapshot is ${size} bytes — over the ${SIZE_TARGET_BYTES} byte target (hard cap ${SIZE_HARD_CAP_BYTES})`,
      )
    }
    // Atomic-ish write: temp in the same directory, then rename (ADR-13).
    const tmp = `${SNAPSHOT_PATH}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, rendered, 'utf8')
    fs.renameSync(tmp, SNAPSHOT_PATH)
    console.log(
      `wrote ${path.relative(ROOT, SNAPSHOT_PATH)} (${size} bytes, ${payload.models.length} rows, ${payload.providers.length} providers)`,
    )
  }

  if (args.stats || args.check || args.offline) reportStats(payload)
  if (args.check) {
    const problems = reportDrift(payload)
    console.log(
      problems === 0
        ? 'drift: none'
        : `drift: ${problems} difference(s) — review before editing presets/seed (catalog may be intentionally narrower)`,
    )
  }
}

main().catch((error) => {
  console.error(
    `[sync-model-catalog] ${error instanceof Error ? error.message : String(error)}`,
  )
  console.error('Kept the previous snapshot.')
  process.exitCode = 1
})
