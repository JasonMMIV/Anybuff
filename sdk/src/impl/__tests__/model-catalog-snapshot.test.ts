/**
 * ADR-31: integrity of the build-time models.dev snapshot.
 *
 * The snapshot is a committed build artefact (`bun scripts/sync-model-catalog.ts`)
 * that ships inside the app. If its shape drifts or its size blows past the
 * budget, every startup pays the cost — so the budget and the encoding
 * contract are pinned here.
 */

import { describe, expect, test } from 'bun:test'

import {
  MODEL_CATALOG_SCHEMA_VERSION,
  buildModelCatalogIndex,
  decodeCatalogModelTuple,
  lookupCatalogModel,
  projectModelsDevCatalog,
} from '../model-catalog'
import * as snapshot from '../model-catalog-snapshot'

const SIZE_TARGET_BYTES = 2 * 1024 * 1024
const SIZE_HARD_CAP_BYTES = 3 * 1024 * 1024

function payloadJson(): string {
  return JSON.stringify({
    schemaVersion: snapshot.MODEL_CATALOG_SCHEMA_VERSION,
    snapshotAt: snapshot.MODEL_CATALOG_SNAPSHOT_AT,
    models: snapshot.MODEL_CATALOG_MODELS,
    providers: snapshot.MODEL_CATALOG_PROVIDERS,
  })
}

describe('model-catalog-snapshot (committed artefact)', () => {
  test('declares a schema version and a real retrieval date', () => {
    expect(snapshot.MODEL_CATALOG_SCHEMA_VERSION).toBe(
      MODEL_CATALOG_SCHEMA_VERSION,
    )
    expect(snapshot.MODEL_CATALOG_SOURCE_URL).toBe(
      'https://models.dev/api.json',
    )
    const at = Date.parse(snapshot.MODEL_CATALOG_SNAPSHOT_AT)
    expect(Number.isFinite(at)).toBe(true)
    // A placeholder epoch means the sync script was never run.
    expect(at).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'))
  })

  test('stays inside the size budget (target 2 MB, hard cap 3 MB)', () => {
    const bytes = Buffer.byteLength(payloadJson(), 'utf8')
    expect(bytes).toBeLessThan(SIZE_HARD_CAP_BYTES)
    if (bytes > SIZE_TARGET_BYTES) {
      // Over target is a warning in the sync script, not a failure here —
      // but the hard cap above is non-negotiable.
      console.warn(
        `[model-catalog] snapshot is ${bytes} bytes — over the ${SIZE_TARGET_BYTES} byte target`,
      )
    }
  })

  test('provider rows are sorted, unique and reference valid rows', () => {
    // Collect problems and assert once — ~8.4k entries must not create one
    // expect() per entry (that is what made this suite slow).
    const problems: string[] = []
    const ids: string[] = []
    let previous: string | undefined
    let entries = 0
    for (const row of snapshot.MODEL_CATALOG_PROVIDERS) {
      if (!Array.isArray(row)) {
        problems.push('provider row is not an array')
        continue
      }
      const [providerId, apiUrl, models] = row
      if (typeof providerId !== 'string') problems.push('bad provider id')
      if (apiUrl !== null && typeof apiUrl !== 'string') {
        problems.push(`${providerId}: bad apiUrl`)
      }
      if (!Array.isArray(models)) {
        problems.push(`${providerId}: models is not an array`)
        continue
      }
      if (previous !== undefined && !(providerId > previous)) {
        problems.push(`${providerId}: providers not sorted`)
      }
      previous = providerId
      ids.push(providerId)
      let previousModel: string | undefined
      for (const entry of models) {
        const [modelId, rowIndex] = entry
        if (typeof modelId !== 'string') problems.push(`${providerId}: bad model id`)
        if (typeof rowIndex !== 'number') {
          problems.push(`${providerId}/${modelId}: bad row index`)
        } else if (rowIndex < 0 || rowIndex >= snapshot.MODEL_CATALOG_MODELS.length) {
          problems.push(`${providerId}/${modelId}: row index out of range`)
        }
        if (previousModel !== undefined && !(modelId > previousModel)) {
          problems.push(`${providerId}/${modelId}: models not sorted`)
        }
        previousModel = modelId
        entries++
      }
    }
    if (ids.length !== new Set(ids).size) problems.push('duplicate provider ids')
    expect(problems).toEqual([])
    expect(ids.length).toBeGreaterThan(100)
    expect(entries).toBeGreaterThan(5_000)
  })

  test('every row decodes without throwing', () => {
    const problems: string[] = []
    snapshot.MODEL_CATALOG_MODELS.forEach((tuple, index) => {
      if (!Array.isArray(tuple)) {
        problems.push(`row ${index}: not an array`)
        return
      }
      try {
        const decoded = decodeCatalogModelTuple(tuple)
        if (!Array.isArray(decoded.modalitiesInput)) {
          problems.push(`row ${index}: modalities not decoded`)
        }
        if (!Array.isArray(decoded.reasoningOptions)) {
          problems.push(`row ${index}: reasoning options not decoded`)
        }
      } catch (error) {
        problems.push(
          `row ${index}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
    expect(problems).toEqual([])
  })

  test('known models resolve with limits and capabilities', () => {
    const index = buildModelCatalogIndex(
      {
        schemaVersion: snapshot.MODEL_CATALOG_SCHEMA_VERSION,
        snapshotAt: snapshot.MODEL_CATALOG_SNAPSHOT_AT,
        models: [...snapshot.MODEL_CATALOG_MODELS],
        providers: [...snapshot.MODEL_CATALOG_PROVIDERS],
      },
      { snapshotAt: snapshot.MODEL_CATALOG_SNAPSHOT_AT, source: 'snapshot' },
    )
    expect(index.providers.size).toBeGreaterThan(100)
    expect(index.size).toBeGreaterThan(5_000)

    const deepseek = lookupCatalogModel(index, {
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    expect(deepseek?.matchedBy).toBe('provider-id')
    expect(deepseek?.model.contextWindow).toBeGreaterThan(0)
    expect(deepseek?.model.outputTokens).toBeGreaterThan(0)

    const claude = lookupCatalogModel(index, {
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5',
    })
    expect(claude?.model.contextWindow).toBeGreaterThanOrEqual(200_000)
  })

  test('projection output round-trips through the index builder', () => {
    const raw = {
      lab: {
        api: 'https://lab.example.com/v1',
        models: {
          m: {
            limit: { context: 128_000, output: 8_192 },
            modalities: { input: ['text', 'image'], output: ['text'] },
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            cost: { input: 1, output: 2 },
          },
        },
      },
    }
    const projected = projectModelsDevCatalog(raw, {
      snapshotAt: '2026-10-22T00:00:00.000Z',
    })
    const index = buildModelCatalogIndex(projected)
    const hit = lookupCatalogModel(index, {
      providerId: 'my-lab',
      baseURL: 'https://api.lab.example.com/v1',
      model: 'm',
    })
    expect(hit?.matchedBy).toBe('host')
    expect(hit?.model.contextWindow).toBe(128_000)
    expect(hit?.model.reasoningOptions).toEqual([
      { type: 'effort', values: ['low', 'high'] },
    ])
    expect(hit?.model.cost?.input).toBe(1)
  })
})
