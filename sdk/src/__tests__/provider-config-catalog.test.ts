/**
 * ADR-31: the catalog as the layer UNDER an explicit declaration.
 *
 * Pins plan §5.2 precedence (explicit → preset/A2 → catalog → fallback) and
 * the P0 safety rule: catalog `false` never removes a capability (a wrong
 * `tool_call: false` would silently stall the agent loop), while `true` may
 * upgrade an unknown.
 */

import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_PROVIDER_COMPATIBILITY,
  modelCapabilitiesSchema,
  providerConfigFileSchema,
  resolveModelCapabilities,
  resolveModelCapabilitiesWithSource,
  type LoadedProviderConfig,
} from '../provider-config'
import {
  buildModelCatalogIndex,
  projectModelsDevCatalog,
} from '../impl/model-catalog'

const CATALOG = buildModelCatalogIndex(
  projectModelsDevCatalog(
    {
      deepseek: {
        api: 'https://api.deepseek.com',
        models: {
          'deepseek-v4-flash': {
            limit: { context: 1_048_576, input: 1_000_000, output: 393_216 },
            modalities: { input: ['text', 'image'], output: ['text'] },
            tool_call: true,
            structured_output: true,
            attachment: true,
            reasoning: true,
            reasoning_options: [
              { type: 'toggle' },
              { type: 'effort', values: ['low', 'high', 'max'] },
              { type: 'budget_tokens', min: 1024, max: 64000 },
            ],
            interleaved: { field: 'reasoning_content' },
            temperature: true,
            status: 'beta',
            cost: {
              input: 0.15,
              output: 0.6,
              reasoning: 0.9,
              cache_read: 0.003,
              cache_write: 0.02,
              tiers: [
                {
                  tier: { type: 'context', size: 200000 },
                  input: 0.3,
                  output: 1.2,
                },
              ],
            },
          },
          'no-tools-model': {
            limit: { context: 32_000, output: 4_000 },
            modalities: { input: ['text'], output: ['text'] },
            tool_call: false,
            structured_output: false,
            attachment: false,
            reasoning: false,
          },
        },
      },
    },
    { snapshotAt: '2026-10-22T00:00:00.000Z' },
  ),
  { snapshotAt: '2026-10-22T00:00:00.000Z', fetchedAt: '2026-10-23T00:00:00.000Z' },
)

function loadedConfig(
  caps?: LoadedProviderConfig['config']['providers'][string]['modelCapabilities'],
): LoadedProviderConfig {
  return {
    config: {
      providers: {
        'my-deepseek': {
          type: 'openai-compatible',
          baseURL: 'https://api.deepseek.com/v1',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          models: ['deepseek-v4-flash', 'no-tools-model'],
          supportsStructuredOutputs: false,
          compatibility: DEFAULT_PROVIDER_COMPATIBILITY,
          ...(caps ? { modelCapabilities: caps } : {}),
        },
      },
      defaultModel: 'my-deepseek/deepseek-v4-flash',
      defaultReasoningEffort: undefined,
      visionModel: undefined,
      visionReasoningEffort: undefined,
      modes: {},
      modeReasoningEfforts: {},
      agents: {},
      agentReasoningEfforts: {},
      indexing: {
        enabled: true,
        cacheDir: '.codebuff-index',
        exclude: [],
        semantic: { enabled: false, model: undefined },
      },
      fileChangeHooks: [],
      autoFileChangeHooks: undefined,
      approvalMode: 'balanced',
      failoverModels: undefined,
      maxAgentSteps: undefined,
    },
    sourceFilePaths: [],
  }
}

describe('catalog schema slots (plan §17.1)', () => {
  it('parses catalogProvider / catalogKeys and drops bad keys individually', () => {
    const parsed = providerConfigFileSchema.parse({
      providers: {
        p: {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          models: ['m'],
          catalogProvider: 'deepseek',
          catalogKeys: { m: 'deepseek/deepseek-v4-flash', '': 'x', bad: 3 },
        },
      },
    })
    const provider = parsed.providers.p!
    expect(provider.catalogProvider).toBe('deepseek')
    expect(provider.catalogKeys).toEqual({ m: 'deepseek/deepseek-v4-flash' })
  })

  it('an invalid catalogProvider degrades to undefined, never the whole file', () => {
    const parsed = providerConfigFileSchema.parse({
      providers: {
        p: {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          models: ['m'],
          catalogProvider: '',
        },
      },
    })
    expect(parsed.providers.p!.catalogProvider).toBeUndefined()
  })

  it('parses modelCatalog.online', () => {
    expect(providerConfigFileSchema.parse({ modelCatalog: { online: false } }).modelCatalog).toEqual({
      online: false,
    })
    expect(providerConfigFileSchema.parse({ modelCatalog: { online: 'nope' } }).modelCatalog).toEqual({})
  })

  it('accepts every named reasoning dialect and drops unknown ones to auto', () => {
    for (const wire of [
      'auto',
      'chat.effort',
      'chat.thinking_budget',
      'chat.enable_thinking',
      'chat.reasoning_obj',
      'chat.none',
      'claude.effort',
      'claude.budget',
      'claude.none',
    ]) {
      const caps = modelCapabilitiesSchema.parse({ reasoning: { wire } })
      expect(caps.reasoning?.wire).toBe(wire as never)
    }
    const unknown = modelCapabilitiesSchema.parse({
      reasoning: { wire: 'chat.not-a-thing' },
    })
    expect(unknown.reasoning?.wire).toBeUndefined()
  })

  it('budgetTokens is a positive integer or undefined', () => {
    expect(
      modelCapabilitiesSchema.parse({ reasoning: { budgetTokens: 32000 } })
        .reasoning?.budgetTokens,
    ).toBe(32000)
    expect(
      modelCapabilitiesSchema.parse({ reasoning: { budgetTokens: 0 } }).reasoning
        ?.budgetTokens,
    ).toBeUndefined()
    expect(
      modelCapabilitiesSchema.parse({ reasoning: { budgetTokens: -5 } }).reasoning
        ?.budgetTokens,
    ).toBeUndefined()
    expect(
      modelCapabilitiesSchema.parse({ reasoning: { budgetTokens: 1.5 } }).reasoning
        ?.budgetTokens,
    ).toBeUndefined()
  })

  it('pricing accepts the new slots and drops malformed tiers', () => {
    const caps = modelCapabilitiesSchema.parse({
      pricing: {
        inputPerMillionTokens: 1,
        cacheWritePerMillionTokens: 2,
        reasoningPerMillionTokens: 3,
        contextOver200k: { input: 4 },
        tiers: [
          { minContextTokens: 200000, input: 5 },
          { input: 6 },
          'garbage',
        ],
      },
    })
    expect(caps.pricing?.cacheWritePerMillionTokens).toBe(2)
    expect(caps.pricing?.reasoningPerMillionTokens).toBe(3)
    expect(caps.pricing?.contextOver200k).toEqual({ input: 4 })
    expect(caps.pricing?.tiers).toHaveLength(1)
    expect(caps.pricing?.tiers?.[0]?.minContextTokens).toBe(200000)
  })
})

describe('resolveModelCapabilitiesWithSource precedence', () => {
  it('fills context from the catalog using limit.input ?? limit.context', () => {
    const resolved = resolveModelCapabilitiesWithSource({
      providerId: 'my-deepseek',
      model: 'deepseek-v4-flash',
      loadedConfig: loadedConfig(),
      catalog: CATALOG,
    })
    expect(resolved.capabilities.context).toEqual({
      windowTokens: 1_000_000,
      outputTokens: 393_216,
    })
    expect(resolved.sources.context).toBe('catalog')
    expect(resolved.catalog?.matchedBy).toBe('host')
    expect(resolved.catalog?.providerId).toBe('deepseek')
    expect(resolved.catalog?.snapshotAt).toBe('2026-10-22T00:00:00.000Z')
    expect(resolved.catalog?.fetchedAt).toBe('2026-10-23T00:00:00.000Z')
    expect(resolved.catalog?.status).toBe('beta')
  })

  it('an explicit declaration always wins', () => {
    const resolved = resolveModelCapabilitiesWithSource({
      providerId: 'my-deepseek',
      model: 'deepseek-v4-flash',
      loadedConfig: loadedConfig({
        'deepseek-v4-flash': {
          context: { windowTokens: 128_000, outputTokens: 8_192 },
          reasoning: { supported: false, efforts: ['low', 'high'] },
          tools: { supported: false },
          input: { image: false },
          pricing: { inputPerMillionTokens: 99, currency: 'USD' },
        },
      }),
      catalog: CATALOG,
    })
    expect(resolved.capabilities.context?.windowTokens).toBe(128_000)
    expect(resolved.capabilities.context?.outputTokens).toBe(8_192)
    expect(resolved.capabilities.reasoning?.supported).toBe(false)
    expect(resolved.capabilities.reasoning?.efforts).toEqual(['low', 'high'])
    expect(resolved.capabilities.tools?.supported).toBe(false)
    expect(resolved.capabilities.input?.image).toBe(false)
    expect(resolved.capabilities.pricing?.inputPerMillionTokens).toBe(99)
    // Partial pricing: the catalog still fills the output rate.
    expect(resolved.capabilities.pricing?.outputPerMillionTokens).toBe(0.6)
    expect(resolved.sources.context).toBe('declared')
    expect(resolved.sources.reasoning).toBe('declared')
  })

  it('takes reasoning support/efforts from the catalog but never defaultEffort', () => {
    const resolved = resolveModelCapabilitiesWithSource({
      providerId: 'my-deepseek',
      model: 'deepseek-v4-flash',
      loadedConfig: loadedConfig(),
      catalog: CATALOG,
    })
    expect(resolved.capabilities.reasoning?.supported).toBe(true)
    expect(resolved.capabilities.reasoning?.efforts).toEqual(['low', 'high', 'max'])
    expect(resolved.capabilities.reasoning?.defaultEffort).toBeUndefined()
    expect(resolved.catalog?.reasoning?.toggle).toBe(true)
    expect(resolved.catalog?.reasoning?.budgetTokens).toEqual({
      min: 1024,
      max: 64000,
    })
    expect(resolved.catalog?.reasoning?.replayField).toBe('reasoning_content')
  })

  it('upgrades unknown capabilities with catalog true', () => {
    const resolved = resolveModelCapabilitiesWithSource({
      providerId: 'my-deepseek',
      model: 'deepseek-v4-flash',
      loadedConfig: loadedConfig(),
      catalog: CATALOG,
    })
    expect(resolved.capabilities.input?.image).toBe(true)
    expect(resolved.capabilities.input?.file).toBe(true)
    expect(resolved.capabilities.tools?.supported).toBe(true)
    expect(resolved.capabilities.tools?.structuredOutputs).toBe(true)
    expect(resolved.catalog?.sampling?.temperatureSupported).toBe(true)
  })

  it('P0: catalog false is advisory, not authoritative', () => {
    const resolved = resolveModelCapabilitiesWithSource({
      providerId: 'my-deepseek',
      model: 'no-tools-model',
      loadedConfig: loadedConfig(),
      catalog: CATALOG,
    })
    expect(resolved.capabilities.tools?.supported).toBeUndefined()
    expect(resolved.capabilities.tools?.structuredOutputs).toBeUndefined()
    expect(resolved.capabilities.input?.file).toBeUndefined()
    expect(resolved.capabilities.reasoning?.supported).toBe(false)
  })

  it('maps pricing including cache/reasoning/tier slots', () => {
    const resolved = resolveModelCapabilitiesWithSource({
      providerId: 'my-deepseek',
      model: 'deepseek-v4-flash',
      loadedConfig: loadedConfig(),
      catalog: CATALOG,
    })
    const pricing = resolved.capabilities.pricing
    expect(pricing?.inputPerMillionTokens).toBe(0.15)
    expect(pricing?.outputPerMillionTokens).toBe(0.6)
    expect(pricing?.cachedInputPerMillionTokens).toBe(0.003)
    expect(pricing?.cacheWritePerMillionTokens).toBe(0.02)
    expect(pricing?.reasoningPerMillionTokens).toBe(0.9)
    expect(pricing?.tiers?.[0]).toEqual({
      minContextTokens: 200_000,
      input: 0.3,
      output: 1.2,
    })
  })

  it('without a catalog index it behaves exactly like the declared-only resolver', () => {
    const config = loadedConfig({
      'deepseek-v4-flash': { context: { windowTokens: 123_000 } },
    })
    const declared = resolveModelCapabilities({
      providerId: 'my-deepseek',
      model: 'deepseek-v4-flash',
      loadedConfig: config,
    })
    const resolved = resolveModelCapabilitiesWithSource({
      providerId: 'my-deepseek',
      model: 'deepseek-v4-flash',
      loadedConfig: config,
    })
    expect(resolved.capabilities).toEqual(declared)
    expect(resolved.catalog).toBeUndefined()
  })

  it('an unknown model leaves the resolved view untouched', () => {
    const resolved = resolveModelCapabilitiesWithSource({
      providerId: 'my-deepseek',
      model: 'deepseek-v4-flash',
      loadedConfig: loadedConfig({ 'deepseek-v4-flash': { context: { windowTokens: 1 } } }),
      catalog: buildModelCatalogIndex(
        projectModelsDevCatalog({}, { snapshotAt: '2026-10-22T00:00:00.000Z' }),
      ),
    })
    expect(resolved.capabilities.context?.windowTokens).toBe(1)
    expect(resolved.catalog).toBeUndefined()
  })

  it('does not mutate the declared capability objects', () => {
    const caps = { 'deepseek-v4-flash': { context: { windowTokens: 5 } } }
    const config = loadedConfig(caps)
    resolveModelCapabilitiesWithSource({
      providerId: 'my-deepseek',
      model: 'deepseek-v4-flash',
      loadedConfig: config,
      catalog: CATALOG,
    })
    expect(config.config.providers['my-deepseek']!.modelCapabilities).toEqual(caps)
  })
})
