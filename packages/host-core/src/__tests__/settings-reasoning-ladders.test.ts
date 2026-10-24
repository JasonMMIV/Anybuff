import { beforeEach, describe, expect, test } from 'bun:test'
import { clearModelCatalogCacheForTest } from '@codebuff/sdk'

import { buildReasoningLadders, buildReasoningLadderInfos } from '../settings/settings'

// These cases pin values from the BUILT-IN snapshot. Test files share the SDK
// runtime (and other suites install their own catalog/cache), so reset to the
// snapshot before each case instead of inheriting whatever ran before.
beforeEach(() => {
  clearModelCatalogCacheForTest()
})

/**
 * ADR-25: reasoning-ladder resolution feeding the Desktop menus. The merge is
 * pure (no host-env seams), so it is testable without installing a host —
 * getAppSettings simply calls it with the configured providers.
 */
describe('buildReasoningLadders', () => {
  test('seeds vendor-verified ladders under bare model ids', () => {
    const ladders = buildReasoningLadders([])
    expect(ladders['deepseek-v4-flash']).toEqual(['low', 'high', 'max'])
    expect(ladders['deepseek-v4-pro']).toEqual(['low', 'high', 'max'])
  })

  test('resolves every configured provider model to a qualified key — custom gateways included', () => {
    const ladders = buildReasoningLadders([
      {
        id: 'goat',
        label: 'Command Code Goat',
        type: 'openai-compatible',
        baseURL: 'https://goat.test/v1',
        apiKeyEnv: 'GOAT_API_KEY',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro:free'],
      },
    ])
    expect(ladders['goat/deepseek-v4-flash']).toEqual(['low', 'high', 'max'])
    expect(ladders['goat/deepseek-v4-pro:free']).toEqual(['low', 'high', 'max'])
  })

  test('provider-declared reasoning efforts win over the seed for that route', () => {
    const ladders = buildReasoningLadders([
      {
        id: 'p',
        label: 'P',
        type: 'openai-compatible',
        baseURL: 'https://p.test/v1',
        apiKeyEnv: 'P_API_KEY',
        models: ['m'],
        modelCapabilities: {
          m: { reasoning: { supported: true, efforts: ['low', 'medium', 'high'] } },
        },
      },
    ])
    expect(ladders['p/m']).toEqual(['low', 'medium', 'high'])
  })

  test('catalog efforts fill a model the seed table does not know (ADR-31)', () => {
    const ladders = buildReasoningLadders([
      {
        id: 'my-deepseek',
        label: 'My DeepSeek',
        type: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        models: ['deepseek-flash'],
      },
    ])
    expect(ladders['my-deepseek/deepseek-flash']).toEqual(['low', 'high', 'max'])
  })

  test('models with no ladder anywhere are simply absent', () => {
    const ladders = buildReasoningLadders([
      {
        id: 'p',
        label: 'P',
        type: 'openai-compatible',
        baseURL: 'https://p.test/v1',
        apiKeyEnv: 'P_API_KEY',
        models: ['mystery-model'],
      },
    ])
    expect(ladders['p/mystery-model']).toBeUndefined()
  })
})

describe('buildReasoningLadderInfos (ADR-27 MC-0.4: provenance badges)', () => {
  const provider = {
    id: 'p',
    label: 'P',
    type: 'openai-compatible' as const,
    baseURL: 'https://p.test/v1',
    apiKeyEnv: 'P_API_KEY',
    models: ['deepseek-v4-flash', 'mystery-model', 'declared-model', 'context-only'],
    modelCapabilities: {
      'declared-model': { reasoning: { supported: true, efforts: ['low', 'turbo'] } },
      'context-only': { context: { windowTokens: 128000 } },
    },
  }

  test('已查證 verified: a configured model without declarations carries its seed provenance', () => {
    const infos = buildReasoningLadderInfos([provider])
    const seed = infos['p/deepseek-v4-flash']
    expect(seed?.source).toBe('verified')
    expect(seed?.efforts).toEqual(['low', 'high', 'max'])
    expect(seed?.verifiedAt).toBe('2026-08-12')
    expect(seed?.verifiedBy).toBe('api-docs.deepseek.com/guides/thinking_mode')
  })

  test('自訂 declared: the user rungs win for that route, verbatim', () => {
    const infos = buildReasoningLadderInfos([provider])
    const declared = infos['p/declared-model']
    expect(declared?.source).toBe('declared')
    expect(declared?.efforts).toEqual(['low', 'turbo'])
    expect(declared?.declared?.supported).toBe(true)
  })

  test('未識別 unknown: no-ladder models are listed with an empty ladder', () => {
    const infos = buildReasoningLadderInfos([provider])
    const unknown = infos['p/mystery-model']
    expect(unknown?.source).toBe('unknown')
    expect(unknown?.efforts).toEqual([])
  })

  test('context-only rows ride along for the capabilities listing (§3.4)', () => {
    const infos = buildReasoningLadderInfos([provider])
    expect(infos['p/context-only']?.source).toBe('unknown')
    expect(infos['p/context-only']?.context?.windowTokens).toBe(128000)
  })

  test('catalog: no declaration/seed → models.dev rungs with provenance', () => {
    const infos = buildReasoningLadderInfos([
      {
        id: 'my-deepseek',
        label: 'My DeepSeek',
        type: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        models: ['deepseek-flash'],
      },
    ])
    const info = infos['my-deepseek/deepseek-flash']
    expect(info?.source).toBe('catalog')
    expect(info?.efforts).toEqual(['low', 'high', 'max'])
    expect(info?.catalog?.matchedBy).toBe('host')
    expect(info?.catalog?.snapshotAt.length).toBeGreaterThan(0)
  })

  test('catalog context fills effectiveContext when settings has no override', () => {
    const infos = buildReasoningLadderInfos([
      {
        id: 'my-deepseek',
        label: 'My DeepSeek',
        type: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        models: ['deepseek-flash'],
      },
    ])
    const info = infos['my-deepseek/deepseek-flash']
    expect(info?.context).toBeUndefined()
    expect(info?.contextSource).toBe('catalog')
    expect(info?.effectiveContext?.windowTokens).toBeGreaterThan(0)
    expect(info?.effectiveContext?.outputTokens).toBeGreaterThan(0)
  })

  test('effective context prefers a declared field and reports its source', () => {
    const infos = buildReasoningLadderInfos([
      {
        id: 'my-deepseek',
        label: 'My DeepSeek',
        type: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        models: ['deepseek-flash'],
        modelCapabilities: {
          'deepseek-flash': { context: { windowTokens: 64000 } },
        },
      },
    ])
    const info = infos['my-deepseek/deepseek-flash']
    expect(info?.context).toEqual({ windowTokens: 64000 })
    expect(info?.effectiveContext?.windowTokens).toBe(64000)
    // Field-level fallback: the undeclared sibling still comes from models.dev.
    expect(info?.effectiveContext?.outputTokens).toBeGreaterThan(0)
    expect(info?.contextSource).toBe('declared')
  })

  test('a declaration without efforts falls back to the seed for that route', () => {
    const infos = buildReasoningLadderInfos([
      {
        ...provider,
        models: ['deepseek-v4-flash'],
        modelCapabilities: {
          'deepseek-v4-flash': { reasoning: { supported: true, defaultEffort: 'max' } },
        },
      },
    ])
    const info = infos['p/deepseek-v4-flash']
    expect(info?.source).toBe('verified')
    expect(info?.efforts).toEqual(['low', 'high', 'max'])
    expect(info?.defaultEffort).toBe('max')
  })
})
