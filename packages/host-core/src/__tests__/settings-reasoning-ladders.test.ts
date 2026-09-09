import { describe, expect, test } from 'bun:test'

import { buildReasoningLadders } from '../settings/settings'

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
