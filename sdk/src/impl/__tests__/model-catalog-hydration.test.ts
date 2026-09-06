/**
 * B1d (AnyBuff P1): lazy catalog hydration for unknown models.
 *
 * The network path is thin (fetch + timeout); the substance is the pure
 * projection from the two catalog shapes onto our capability fields, plus
 * the provider alias table. Both are tested here without any network.
 */

import { describe, expect, test } from 'bun:test'

import {
  capsFromGatewayModelsResponse,
  capsFromModelsDevCatalog,
  modelsDevProviderIdsFor,
} from '../model-catalog-hydration'

describe('models.dev catalog projection', () => {
  const catalog = {
    zhipuai: {
      models: {
        'glm-5.3-flash': { limit: { context: 1_000_000, output: 131_072 } },
        'glm-legacy': { limit: { context: 100 } },
      },
    },
    deepseek: {
      models: {
        'deepseek-v5': { limit: { context: 1_048_576, output: 65_536 } },
      },
    },
  }

  test('matches a gateway provider id through the alias table (z-ai → zhipuai)', () => {
    const caps = capsFromModelsDevCatalog(
      catalog,
      'z-ai',
      'z-ai/glm-5.3-flash',
    )
    expect(caps).toEqual({ windowTokens: 1_000_000, outputTokens: 131_072 })
  })

  test('matches a bare model id for a direct lab provider', () => {
    expect(capsFromModelsDevCatalog(catalog, 'deepseek', 'deepseek-v5')).toEqual({
      windowTokens: 1_048_576,
      outputTokens: 65_536,
    })
  })

  test('ignores implausibly small windows rather than trusting them', () => {
    expect(capsFromModelsDevCatalog(catalog, 'glm', 'glm-legacy')).toBeUndefined()
  })

  test('returns undefined for unknown providers/models without throwing', () => {
    expect(capsFromModelsDevCatalog(catalog, 'unknown-lab', 'nope')).toBeUndefined()
    expect(capsFromModelsDevCatalog(null, 'deepseek', 'deepseek-v5')).toBeUndefined()
  })
})

describe('gateway /models projection', () => {
  test('reads window fields when the gateway exposes them', () => {
    const payload = {
      data: [
        { id: 'mystery-model', context_length: 262_144, max_output_tokens: 32_768 },
        { id: 'other' },
      ],
    }
    expect(capsFromGatewayModelsResponse(payload, 'mystery-model')).toEqual({
      windowTokens: 262_144,
      outputTokens: 32_768,
    })
  })

  test('returns undefined when the gateway only lists ids (the common case)', () => {
    const payload = { data: [{ id: 'mystery-model' }, { id: 'other' }] }
    expect(capsFromGatewayModelsResponse(payload, 'mystery-model')).toBeUndefined()
  })

  test('ignores implausibly large values (the 32M sanity ceiling)', () => {
    const payload = { data: [{ id: 'x', context_length: 99_000_000 }] }
    expect(capsFromGatewayModelsResponse(payload, 'x')).toBeUndefined()
  })

  test('tolerates malformed payloads', () => {
    expect(capsFromGatewayModelsResponse(null, 'x')).toBeUndefined()
    expect(capsFromGatewayModelsResponse({ data: 'nope' }, 'x')).toBeUndefined()
    expect(capsFromGatewayModelsResponse({}, 'x')).toBeUndefined()
  })
})

describe('provider alias table', () => {
  test('maps brand aliases onto models.dev ids', () => {
    expect(modelsDevProviderIdsFor('z-ai')).toEqual(['zhipuai'])
    expect(modelsDevProviderIdsFor('glm')).toEqual(['zhipuai'])
    expect(modelsDevProviderIdsFor('grok')).toEqual(['xai'])
    expect(modelsDevProviderIdsFor('bedrock')).toEqual(['amazon-bedrock', 'bedrock'])
  })

  test('falls back to the lowercased id itself for direct lab providers', () => {
    expect(modelsDevProviderIdsFor('DeepSeek')).toEqual(['deepseek'])
  })
})
