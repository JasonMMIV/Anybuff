/**
 * Built-in preset capability metadata (AnyBuff P1 B1a/B1c/B4).
 *
 * The preset tables are a safety boundary: every windowTokens value feeds
 * the §3.3 compaction trigger, so a typo (or a new list member added without
 * capabilities — B1c's ordering rule) silently degrades into the 1M
 * unknown-window fallback. These tests pin the values and the wiring.
 */

import { describe, expect, test } from 'bun:test'

import {
  ANYBUFF_PROVIDER_PRESETS,
  createProviderPresetConfig,
  resolveModelCapabilities,
} from '../provider-config'

/** Resolve capabilities for a preset member through the full config pipeline. */
function resolvePresetCapabilities(providerId: string, model: string) {
  const config = createProviderPresetConfig(providerId)
  return resolveModelCapabilities({
    providerId,
    model,
    loadedConfig: { config, sourceFilePaths: [] },
  })
}

describe('provider presets (B1a capability metadata)', () => {
  test('opencode-go: every preset member declares a window and output cap', () => {
    const preset = ANYBUFF_PROVIDER_PRESETS['opencode-go']
    const provider = (preset.config.providers as Record<string, any>)[
      'opencode-go'
    ] as { models: readonly string[]; modelCapabilities: Record<string, { context: { windowTokens: number; outputTokens: number } }> }

    for (const model of provider.models) {
      const capability = provider.modelCapabilities[model]
      expect([model, capability]).toBeDefined()
      expect(capability.context.windowTokens).toBeGreaterThan(0)
      expect(capability.context.outputTokens).toBeGreaterThan(0)
    }
  })

  test('opencode-go: kimi-k2.6 keeps its 262,144-window regression pin (plan B1a table)', () => {
    const capabilities = resolvePresetCapabilities('opencode-go', 'kimi-k2.6')
    expect(capabilities.context?.windowTokens).toBe(262_144)
    expect(capabilities.context?.outputTokens).toBe(262_144)
  })

  test('opencode-go: new-gen members from the B1c refresh resolve (kimi-k3, glm-5.3, minimax-m3)', () => {
    expect(resolvePresetCapabilities('opencode-go', 'kimi-k3').context).toEqual({
      windowTokens: 1_048_576,
      outputTokens: 131_072,
    })
    expect(resolvePresetCapabilities('opencode-go', 'glm-5.3').context).toEqual({
      windowTokens: 1_000_000,
      outputTokens: 131_072,
    })
    expect(resolvePresetCapabilities('opencode-go', 'minimax-m3').context).toEqual({
      windowTokens: 1_048_576,
      outputTokens: 512_000,
    })
  })

  test('opencode-go: glm-5.3-flash confirmed at 1M/131k (§11 #3 close-out, plan-mode model)', () => {
    // Three independent sources agree: z.ai docs (1M ctx / 128k max output),
    // models.dev TOML (1,000,000/131,072), upstream base-chat table (1M).
    expect(resolvePresetCapabilities('opencode-go', 'glm-5.3-flash').context).toEqual({
      windowTokens: 1_000_000,
      outputTokens: 131_072,
    })
  })

  test('openai: gpt-5.2-chat-latest is the 128k floor and gpt-5.5 uses limit.input (922k)', () => {
    expect(resolvePresetCapabilities('openai', 'gpt-5.2-chat-latest').context).toEqual({
      windowTokens: 128_000,
      outputTokens: 16_384,
    })
    expect(resolvePresetCapabilities('openai', 'gpt-5.5').context).toEqual({
      windowTokens: 922_000,
      outputTokens: 128_000,
    })
  })

  test('openrouter: values come from models.dev lab files, not OpenRouter aggregates', () => {
    expect(
      resolvePresetCapabilities('openrouter', 'anthropic/claude-sonnet-4.5').context,
    ).toEqual({ windowTokens: 200_000, outputTokens: 64_000 })
  })

  test('glm: glm-4.5-air is a 131k window — symptom-② trap covered', () => {
    expect(resolvePresetCapabilities('glm', 'glm-4.5-air').context).toEqual({
      windowTokens: 131_072,
      outputTokens: 98_304,
    })
  })

  test('anthropic: every member is a 200k prompt window', () => {
    for (const model of [
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-0',
    ]) {
      expect(
        resolvePresetCapabilities('anthropic', model).context?.windowTokens,
      ).toBe(200_000)
    }
  })

  test('bedrock: claude family covered; nova/llama members removed (§11 #2 close-out)', () => {
    expect(
      resolvePresetCapabilities('bedrock', 'apac.anthropic.claude-opus-4-8').context,
    ).toEqual({ windowTokens: 1_000_000, outputTokens: 128_000 })
    const preset = ANYBUFF_PROVIDER_PRESETS['bedrock']
    const models = (
      (preset.config.providers as Record<string, any>)['bedrock'] as {
        models: readonly string[]
      }
    ).models
    for (const removed of [
      'us.amazon.nova-premier-v1:0',
      'us.amazon.nova-pro-v1:0',
      'us.meta.llama3-3-70b-instruct-v1:0',
    ]) {
      expect(models).not.toContain(removed)
    }
  })

  test('opencode-go: Hunyuan / LongCat B1c additions resolve (hy3 input-window rule)', () => {
    // hy3 has both limit.input (192k) and limit.context (256k) in models.dev;
    // fill rule takes limit.input ?? limit.context → 192k (§3.3 v2).
    expect(resolvePresetCapabilities('opencode-go', 'hy3').context).toEqual({
      windowTokens: 192_000,
      outputTokens: 128_000,
    })
    expect(resolvePresetCapabilities('opencode-go', 'hy4-preview').context).toEqual({
      windowTokens: 1_024_000,
      outputTokens: 64_000,
    })
    expect(resolvePresetCapabilities('opencode-go', 'longcat-2.0').context).toEqual({
      windowTokens: 1_000_000,
      outputTokens: 131_072,
    })
  })

  test('opencode-go: deepseek-v4-flash pinned at the models.dev value (§11 #2 定案)', () => {
    expect(resolvePresetCapabilities('opencode-go', 'deepseek-v4-flash').context).toEqual({
      windowTokens: 1_000_000,
      outputTokens: 384_000,
    })
  })

  test('ollama: deliberately unfilled — local num_ctx varies, A2 learning is the source', () => {
    expect(
      resolvePresetCapabilities('ollama', 'qwen2.5-coder:32b').context?.windowTokens,
    ).toBeUndefined()
  })

  test('deprecated models are gone from the opencode-go list (B1c)', () => {
    const preset = ANYBUFF_PROVIDER_PRESETS['opencode-go']
    const models = (
      (preset.config.providers as Record<string, any>)['opencode-go'] as {
        models: readonly string[]
      }
    ).models
    for (const deprecated of ['glm-5', 'minimax-m2.5', 'kimi-k2.5']) {
      expect(models).not.toContain(deprecated)
    }
  })
})

describe('preset defaults (B1c decision, 2026-09-05)', () => {
  test('opencode-go defaults to kimi-k3 (1M) in default and plan modes', () => {
    const config = createProviderPresetConfig('opencode-go')
    expect(config.defaultModel).toBe('opencode-go/kimi-k3')
    expect(config.modes?.default).toBe('opencode-go/kimi-k3')
    expect(config.modes?.plan).toBe('opencode-go/glm-5.3')
  })

  test('seeded agents inherit the kimi-k3 default', () => {
    const config = createProviderPresetConfig('opencode-go')
    expect(config.agents?.['evaluator']).toBe('opencode-go/kimi-k3')
  })
})

describe('preset error branding (B4)', () => {
  test('unknown preset errors say AnyBuff, not Openbuff', () => {
    expect(() => createProviderPresetConfig('nonexistent')).toThrow(
      /Unknown AnyBuff provider preset/,
    )
  })
})
