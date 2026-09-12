import { describe, expect, test } from 'bun:test'

import { buildReasoningLadders, buildReasoningLadderInfos } from '../settings/settings'

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
