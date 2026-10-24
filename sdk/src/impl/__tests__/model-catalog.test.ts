/**
 * ADR-31 (batch 1): the pure models.dev catalog layer.
 *
 * These tests pin the LOOKUP LADDER and its ambiguity rules — the catalog
 * feeds compression budgets, vision routing and pricing, so a wrong guess is
 * worse than no value (plan D6: exact matching only, fail loud on conflicts).
 */

import { describe, expect, test } from 'bun:test'

import {
  buildModelCatalogIndex,
  catalogContextWindow,
  catalogEfforts,
  catalogHasToggle,
  catalogOutputTokens,
  catalogReplayField,
  catalogSupportsFileInput,
  catalogSupportsImageInput,
  decodeCatalogModelTuple,
  encodeCatalogModel,
  lookupCatalogModel,
  normalizeApiHost,
  normalizeModelIdKey,
  projectModelsDevCatalog,
  resolveCatalogProviderId,
  type ModelCatalogIndex,
} from '../model-catalog'

function rawCatalog(providers: Record<string, unknown>): unknown {
  return providers
}

const CATALOG = rawCatalog({
  deepseek: {
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-v4-flash': {
        limit: { context: 1_048_576, output: 393_216 },
        modalities: { input: ['text', 'image'], output: ['text'] },
        tool_call: true,
        structured_output: true,
        attachment: true,
        reasoning: true,
        reasoning_options: [
          { type: 'toggle' },
          { type: 'effort', values: ['low', 'high', 'max'] },
          { type: 'budget_tokens', min: 1024, max: 32000 },
        ],
        interleaved: { field: 'reasoning_content' },
        temperature: true,
        status: 'deprecated',
        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
        cost: {
          input: 0.15,
          output: 0.6,
          reasoning: 0.6,
          cache_read: 0.003,
          cache_write: 0.02,
          tiers: [
            {
              tier: { type: 'context', size: 200000 },
              input: 0.3,
              output: 1.2,
              cache_read: 0.006,
            },
          ],
          context_over_200k: { input: 0.3, output: 1.2 },
        },
      },
      'deepseek-v5': {
        limit: { context: 200_000, input: 128_000, output: 64_000 },
        modalities: { input: ['text'], output: ['text'] },
        tool_call: false,
        reasoning: false,
        temperature: false,
      },
    },
  },
  openrouter: {
    api: 'https://openrouter.ai/api/v1',
    models: {
      'deepseek/deepseek-v4.1-flash': {
        limit: { context: 1_048_576, output: 393_216 },
        modalities: { input: ['text', 'image'], output: ['text'] },
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        cost: { input: 0.2, output: 0.8 },
      },
    },
  },
  'my-lab': {
    models: {
      'shared-model': {
        limit: { context: 100_000, output: 8_000 },
        modalities: { input: ['text'], output: ['text'] },
      },
      'alias-target': {
        limit: { context: 64_000, output: 8_000 },
        modalities: { input: ['text'], output: ['text'] },
        canonical_model_id: 'lab/alias-target',
      },
    },
  },
  'other-lab': {
    models: {
      'shared-model': {
        limit: { context: 200_000, output: 16_000 },
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  'GPT-Lib': {
    models: {
      'gpt-5': {
        limit: { context: 400_000, output: 100_000 },
        modalities: { input: ['text'], output: ['text'] },
      },
      'gpt-5.6': {
        limit: { context: 1_000_000, output: 200_000 },
        modalities: { input: ['text'], output: ['text'] },
      },
      'gpt-5-2025-08-07': {
        limit: { context: 400_000, output: 100_000 },
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  empty: { api: 'https://empty.test' },
})

function buildIndex(raw: unknown = CATALOG): ModelCatalogIndex {
  return buildModelCatalogIndex(
    projectModelsDevCatalog(raw, {
      snapshotAt: '2026-10-22T00:00:00.000Z',
    }),
    {
    snapshotAt: '2026-10-22T00:00:00.000Z',
  })
}

describe('compact tuple encoding (plan §3.3)', () => {
  test('round-trips every behavioural field', () => {
    const raw = (CATALOG as Record<string, any>).deepseek.models[
      'deepseek-v4-flash'
    ]
    const decoded = decodeCatalogModelTuple(encodeCatalogModel(raw))
    expect(decoded.contextWindow).toBe(1_048_576)
    expect(decoded.outputTokens).toBe(393_216)
    expect(decoded.modalitiesInput).toEqual(['image', 'text'])
    expect(decoded.toolCall).toBe(true)
    expect(decoded.structuredOutput).toBe(true)
    expect(decoded.attachment).toBe(true)
    expect(decoded.reasoning).toBe(true)
    expect(decoded.temperature).toBe(true)
    expect(decoded.interleaved).toEqual({ field: 'reasoning_content' })
    expect(decoded.status).toBe('deprecated')
    expect(decoded.canonicalModelId).toBe('deepseek/deepseek-v4.1-flash')
    expect(decoded.cost?.input).toBe(0.15)
    expect(decoded.cost?.reasoning).toBe(0.6)
    expect(decoded.cost?.cacheRead).toBe(0.003)
    expect(decoded.cost?.cacheWrite).toBe(0.02)
    expect(decoded.cost?.contextOver200k).toEqual({ input: 0.3, output: 1.2 })
    expect(decoded.cost?.tiers?.[0]?.minContextTokens).toBe(200_000)
    expect(decoded.reasoningOptions).toEqual([
      { type: 'toggle' },
      { type: 'effort', values: ['low', 'high', 'max'] },
      { type: 'budget_tokens', min: 1024, max: 32000 },
    ])
  })

  test('projection drops non-chat rows and unknown/display fields', () => {
    const projected = projectModelsDevCatalog(
      rawCatalog({
        lab: {
          models: {
            chatty: { limit: { context: 10_000 }, name: 'Chatty', description: 'x' },
            decision: { type: 'decision', limit: { context: 10_000 } },
            embed: { type: 'embedding' },
          },
        },
      }),
      { snapshotAt: '2026-10-22T00:00:00.000Z' },
    )
    expect(projected.providers).toHaveLength(1)
    expect(projected.providers[0]![2].map(([id]) => id)).toEqual(['chatty'])
    const decoded = decodeCatalogModelTuple(projected.models[0]!)
    expect('name' in decoded).toBe(false)
    expect('description' in decoded).toBe(false)
  })

  test('identical rows are deduplicated across providers', () => {
    const projected = projectModelsDevCatalog(
      rawCatalog({
        a: { models: { m: { limit: { context: 10_000 } } } },
        b: { models: { m: { limit: { context: 10_000 } } } },
      }),
      { snapshotAt: '2026-10-22T00:00:00.000Z' },
    )
    expect(projected.models).toHaveLength(1)
    expect(projected.providers).toHaveLength(2)
  })
})

describe('provider identification (plan §4.4)', () => {
  const index = buildIndex()

  test('matches the config provider id exactly', () => {
    expect(
      resolveCatalogProviderId(index, { providerId: 'deepseek' }),
    ).toEqual({ providerId: 'deepseek', matchedBy: 'provider-id' })
  })

  test('matches an explicit catalogProvider override first', () => {
    expect(
      resolveCatalogProviderId(index, {
        providerId: 'my-deepseek',
        catalogProvider: 'deepseek',
      }),
    ).toEqual({ providerId: 'deepseek', matchedBy: 'provider-id' })
  })

  test('matches by baseURL host, ignoring api./www., port and path', () => {
    for (const baseURL of [
      'https://api.deepseek.com/v1',
      'https://deepseek.com',
      'https://api.deepseek.com:443/anything',
    ]) {
      expect(
        resolveCatalogProviderId(index, {
          providerId: 'my-deepseek',
          baseURL,
        }),
      ).toEqual({ providerId: 'deepseek', matchedBy: 'host' })
    }
  })

  test('does NOT map the protocol type onto a lab', () => {
    // A custom gateway with an unrelated host must not silently become
    // `openai` just because its type is openai-compatible (plan §4.4 #5).
    expect(
      resolveCatalogProviderId(index, {
        providerId: 'goat',
        baseURL: 'https://goat.example.com/v1',
      }),
    ).toBeUndefined()
  })

  test('normalizes hosts the same way for every caller', () => {
    expect(normalizeApiHost('https://api.openai.com/v1')).toBe('openai.com')
    expect(normalizeApiHost('https://www.example.com:8443/x')).toBe(
      'example.com',
    )
    expect(normalizeApiHost('not a url')).toBeUndefined()
  })
})

describe('lookup ladder (plan §4.3)', () => {
  const index = buildIndex()

  test('provider-exact wins with confidence 1.0', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    expect(hit?.matchedBy).toBe('provider-id')
    expect(hit?.confidence).toBe(1)
    expect(hit?.model.providerId).toBe('deepseek')
  })

  test('host match works for a user-named provider', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'my-deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
    })
    expect(hit?.matchedBy).toBe('host')
    expect(hit?.confidence).toBe(0.9)
    expect(hit?.model.providerId).toBe('deepseek')
  })

  test('a provider-qualified routable id resolves through the prefix', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'deepseek',
      model: 'deepseek/deepseek-v4-flash',
    })
    expect(hit?.model.modelId).toBe('deepseek-v4-flash')
  })

  test('catalogKeys overrides an otherwise unmatchable model id', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'deepseek',
      model: 'vendor-alias',
      catalogKeys: { 'vendor-alias': 'deepseek/deepseek-v4-flash' },
    })
    expect(hit?.model.modelId).toBe('deepseek-v4-flash')
  })

  test('global model id is a lower-confidence fallback', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'unknown-provider',
      model: 'deepseek-v4-flash',
    })
    expect(hit?.matchedBy).toBe('global-id')
    expect(hit?.confidence).toBe(0.6)
  })

  test('canonical_model_id is honoured', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'unknown-provider',
      model: 'lab/alias-target',
    })
    expect(hit?.matchedBy).toBe('canonical')
    expect(hit?.confidence).toBe(0.8)
    expect(hit?.model.modelId).toBe('alias-target')
  })

  test('a real lab-qualified model id wins over its canonical alias', () => {
    // `deepseek/deepseek-v4.1-flash` IS a model id on openrouter, so the
    // verbatim global rung (0.6) is correct — canonical is the next rung.
    const hit = lookupCatalogModel(index, {
      providerId: 'unknown-provider',
      model: 'deepseek/deepseek-v4.1-flash',
    })
    expect(hit?.matchedBy).toBe('global-id')
    expect(hit?.model.providerId).toBe('openrouter')
  })

  test('gpt-5 never matches gpt-5.6 (no fuzzy prefix matching)', () => {
    const exact = lookupCatalogModel(index, {
      providerId: 'gpt-lib',
      model: 'gpt-5',
    })
    expect(exact?.model.modelId).toBe('gpt-5')
    expect(exact?.model.contextWindow).toBe(400_000)

    const dotted = lookupCatalogModel(index, {
      providerId: 'gpt-lib',
      model: 'gpt-5.6',
    })
    expect(dotted?.model.modelId).toBe('gpt-5.6')
  })

  test('a dated build resolves through its own catalog id when present', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'unknown-provider',
      model: 'gpt-5-2025-08-07',
    })
    expect(hit?.matchedBy).toBe('global-id')
    expect(hit?.model.modelId).toBe('gpt-5-2025-08-07')

    const stripped = lookupCatalogModel(index, {
      providerId: 'unknown-provider',
      model: 'gpt-5-2099-01-01',
    })
    expect(stripped?.matchedBy).toBe('normalized')
    expect(stripped?.confidence).toBe(0.5)
    expect(stripped?.model.modelId).toBe('gpt-5')
  })

  test('normalization never strips a version number', () => {
    expect(normalizeModelIdKey('gpt-5.6')).toBe('gpt-5.6')
    expect(normalizeModelIdKey('deepseek/deepseek-v4-flash:free')).toBe(
      'deepseek-v4-flash',
    )
  })

  test('ambiguous global matches with differing facts return null', () => {
    // `shared-model` exists under two providers with different windows and no
    // provider signal to disambiguate — fail loud, do not guess.
    expect(
      lookupCatalogModel(index, {
        providerId: 'unknown',
        model: 'shared-model',
      }),
    ).toBeNull()
  })

  test('provider-exact beats ambiguity elsewhere', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'my-lab',
      model: 'shared-model',
    })
    expect(hit?.matchedBy).toBe('provider-id')
    expect(hit?.model.contextWindow).toBe(100_000)
  })

  test('ambiguous global matches with identical facts resolve', () => {
    const consistent = buildIndex(
      rawCatalog({
        a: {
          models: {
            same: {
              limit: { context: 50_000, output: 4_000 },
              modalities: { input: ['text'] },
            },
          },
        },
        b: {
          models: {
            same: {
              limit: { context: 50_000, output: 4_000 },
              modalities: { input: ['text'] },
            },
          },
        },
      }),
    )
    const hit = lookupCatalogModel(consistent, {
      providerId: 'unknown',
      model: 'same',
    })
    expect(hit?.matchedBy).toBe('global-id')
    expect(hit?.model.contextWindow).toBe(50_000)
  })

  test('unknown models return null (never a fabricated entry)', () => {
    expect(
      lookupCatalogModel(index, { providerId: 'deepseek', model: 'nope' }),
    ).toBeNull()
  })
})

describe('empty / missing field semantics (plan §4.5)', () => {
  const index = buildIndex()

  test('missing limit / modalities / flags stay undefined', () => {
    const empty = buildIndex(
      rawCatalog({ lab: { models: { bare: { tool_call: true } } } }),
    )
    const hit = lookupCatalogModel(empty, {
      providerId: 'lab',
      model: 'bare',
    })
    expect(hit?.model.contextWindow).toBeUndefined()
    expect(hit?.model.outputTokens).toBeUndefined()
    expect(hit?.model.structuredOutput).toBeUndefined()
    expect(hit?.model.reasoning).toBeUndefined()
    expect(hit?.model.temperature).toBeUndefined()
    expect(hit?.model.modalitiesInput).toEqual([])
    expect(catalogContextWindow(hit?.model)).toBeUndefined()
    expect(catalogSupportsImageInput(hit?.model)).toBeUndefined()
  })

  test('reasoning_options: [] means UNKNOWN, not unsupported', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'deepseek',
      model: 'deepseek-v5',
    })
    expect(hit?.model.reasoning).toBe(false)
    expect(hit?.model.reasoningOptions).toEqual([])
    expect(catalogEfforts(hit?.model)).toEqual([])
  })

  test('interleaved: true keeps the field unknown', () => {
    const unknownField = buildIndex(
      rawCatalog({
        lab: {
          models: {
            m: { interleaved: true, modalities: { input: ['text'] } },
          },
        },
      }),
    )
    const hit = lookupCatalogModel(unknownField, {
      providerId: 'lab',
      model: 'm',
    })
    expect(hit?.model.interleaved).toBe(true)
    expect(catalogReplayField(hit?.model)).toBeUndefined()
  })
})

describe('convenience accessors', () => {
  const index = buildIndex()

  test('window uses limit.input before limit.context', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'deepseek',
      model: 'deepseek-v5',
    })
    expect(hit?.model.contextWindow).toBe(200_000)
    expect(hit?.model.inputTokens).toBe(128_000)
    expect(catalogContextWindow(hit?.model)).toBe(128_000)
    expect(catalogOutputTokens(hit?.model)).toBe(64_000)
  })

  test('image/file support and replay field are projected', () => {
    const hit = lookupCatalogModel(index, {
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    expect(catalogSupportsImageInput(hit?.model)).toBe(true)
    expect(catalogSupportsFileInput(hit?.model)).toBe(true)
    expect(catalogReplayField(hit?.model)).toBe('reasoning_content')
    expect(catalogHasToggle(hit?.model)).toBe(true)
  })
})
