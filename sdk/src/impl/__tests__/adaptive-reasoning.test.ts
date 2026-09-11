import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { clearProviderConfigCacheForTest } from '../../provider-config'
import {
  getModelForRequest,
  selectAdaptiveReasoningEffort,
} from '../model-provider'

/**
 * ADR-26: `adaptiveReasoning` is a strict opt-in. Declaring
 * `modelCapabilities.reasoning` (efforts / supported markers) routes and
 * clamps explicit picks but must NOT flip Default from "send nothing" to
 * "send a value" — that flip pushed every programmatic-subagent request on
 * DeepSeek into thinking mode and then into the reasoning_content 400.
 *
 * Same hermetic pattern as context-overflow-trim.test.ts: a throwaway
 * anybuff.json via ANYBUFF_PROVIDER_CONFIG, restored synchronously in
 * `finally`. Bun may interleave other test files' work between tests but
 * never inside one, so the env var never leaks into their model resolution.
 */
async function withConfig(
  config: Record<string, unknown>,
  scenario: () => void | Promise<void>,
): Promise<void> {
  const priorConfigEnv = process.env.ANYBUFF_PROVIDER_CONFIG
  const dataDir = mkdtempSync(join(tmpdir(), 'sdk-adaptive-'))
  const configPath = join(dataDir, 'anybuff.json')
  process.env.ANYBUFF_PROVIDER_CONFIG = configPath
  try {
    writeFileSync(configPath, JSON.stringify(config))
    clearProviderConfigCacheForTest()
    await scenario()
  } finally {
    clearProviderConfigCacheForTest()
    if (priorConfigEnv === undefined) {
      delete process.env.ANYBUFF_PROVIDER_CONFIG
    } else {
      process.env.ANYBUFF_PROVIDER_CONFIG = priorConfigEnv
    }
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      // best-effort — a locked temp dir must never fail the run
    }
  }
}

/** A keyless openai-compatible gateway — resolvable without any env key. */
function gatewayConfig(opts: {
  adaptiveReasoning?: boolean
  declareReasoning?: boolean
  /** Defaults to the seeded 'deepseek-v4-flash'; 'gateway-model' is unseeded. */
  model?: string
}): Record<string, unknown> {
  const model = opts.model ?? 'deepseek-v4-flash'
  return {
    ...(opts.adaptiveReasoning !== undefined
      ? { adaptiveReasoning: opts.adaptiveReasoning }
      : {}),
    defaultModel: `test-gw/${model}`,
    providers: {
      'test-gw': {
        type: 'openai-compatible',
        baseURL: 'http://localhost:9/v1',
        models: [model],
        ...(opts.declareReasoning
          ? {
              modelCapabilities: {
                [model]: {
                  reasoning: {
                    supported: true,
                    efforts: ['low', 'high', 'max'],
                  },
                },
              },
            }
          : {}),
      },
    },
  }
}

const effortOf = (agentId: string) =>
  getModelForRequest({
    model: 'test-gw/deepseek-v4-flash',
    agentId,
    preferModelParam: true,
  } as never).then((result) => result.reasoningEffort)

describe('adaptiveReasoning is a strict opt-in (ADR-26)', () => {
  it('Default never sends, even with reasoning capabilities declared', async () => {
    // The regression: merely declaring modelCapabilities.reasoning made the
    // SDK pick an effort for Default (base2/thinker → high, file-picker →
    // low), pushing every request into thinking mode.
    await withConfig(gatewayConfig({ declareReasoning: true }), async () => {
      for (const agentId of ['base2', 'base-chat', 'thinker', 'file-picker']) {
        expect(await effortOf(agentId)).toBeUndefined()
      }
    })
  })

  it('explicit false behaves exactly like unset', async () => {
    await withConfig(
      gatewayConfig({ declareReasoning: true, adaptiveReasoning: false }),
      async () => {
        expect(await effortOf('base2')).toBeUndefined()
      },
    )
  })

  it('opting in picks phase-appropriate rungs from the declared ladder', async () => {
    await withConfig(
      gatewayConfig({ declareReasoning: true, adaptiveReasoning: true }),
      async () => {
        // Declared ladder [low, high, max]: base2's preferred medium snaps
        // to high, thinker's high passes through, file-picker's low passes.
        expect(await effortOf('base2')).toBe('high')
        expect(await effortOf('thinker')).toBe('high')
        expect(await effortOf('file-picker')).toBe('low')
      },
    )
  })

  it('opting in falls back to the ADR-25 seed ladder when nothing is declared', async () => {
    await withConfig(gatewayConfig({ adaptiveReasoning: true }), async () => {
      // deepseek-v4-flash is seeded with [low, high, max] (requestMap
      // medium→high), so the pick lands the same as with a declaration.
      expect(await effortOf('base2')).toBe('high')
      expect(await effortOf('file-picker')).toBe('low')
    })
  })

  it('opting in never guesses for an unseeded, undeclared model', async () => {
    await withConfig(
      gatewayConfig({ adaptiveReasoning: true, model: 'gateway-model' }),
      async () => {
        const result = await getModelForRequest({
          model: 'test-gw/gateway-model',
          agentId: 'base2',
          preferModelParam: true,
        } as never)
        expect(result.reasoningEffort).toBeUndefined()
      },
    )
  })

  it('opting in never overrides an explicit supported: false declaration', async () => {
    // The priority guard: "cannot reason" always wins, even opted in.
    await withConfig(
      {
        adaptiveReasoning: true,
        defaultModel: 'test-gw/deepseek-v4-flash',
        providers: {
          'test-gw': {
            type: 'openai-compatible',
            baseURL: 'http://localhost:9/v1',
            models: ['deepseek-v4-flash'],
            modelCapabilities: {
              'deepseek-v4-flash': {
                reasoning: {
                  supported: false,
                  efforts: ['low', 'high', 'max'],
                },
              },
            },
          },
        },
      },
      async () => {
        expect(await effortOf('base2')).toBeUndefined()
        expect(await effortOf('thinker')).toBeUndefined()
      },
    )
  })

  it('a flag-less config merged over a flagged one keeps the flag', async () => {
    // loadProviderConfigSync folds each parsed file over the running
    // config; a later file that omits `adaptiveReasoning` must not clear an
    // earlier file's `true` (the pre-existing merge drop made the flag
    // unreachable on every path — this locks the fixed direction).
    await withConfig(gatewayConfig({ adaptiveReasoning: true }), async () => {
      expect(await effortOf('base2')).toBe('high')
    })
  })

  it('explicit agent efforts still resolve and clamp (unchanged by the opt-in)', async () => {
    await withConfig(
      {
        ...gatewayConfig({ declareReasoning: true }),
        agentReasoningEfforts: { base2: 'medium' },
      },
      async () => {
        // DeepSeek's documented requestMap sends medium→high (ADR-25).
        expect(await effortOf('base2')).toBe('high')
      },
    )
  })
})

describe('selectAdaptiveReasoningEffort', () => {
  it('returns nothing when the model is declared unable to reason', () => {
    expect(
      selectAdaptiveReasoningEffort({
        agentId: 'base2',
        supported: false,
        efforts: ['low', 'high'],
      }),
    ).toBeUndefined()
  })

  it('picks the preferred rung when the ladder allows it', () => {
    expect(
      selectAdaptiveReasoningEffort({
        agentId: 'thinker',
        supported: true,
        efforts: ['low', 'high', 'max'],
      }),
    ).toBe('high')
    expect(
      selectAdaptiveReasoningEffort({
        agentId: 'file-picker',
        supported: true,
        efforts: ['low', 'high', 'max'],
      }),
    ).toBe('low')
  })

  it('snaps a preferred rung the ladder lacks onto the highest rung it has', () => {
    // base2 prefers medium; the ladder offers [low, high, max].
    expect(
      selectAdaptiveReasoningEffort({
        agentId: 'base2',
        supported: true,
        efforts: ['low', 'high', 'max'],
      }),
    ).toBe('high')
  })

  it('without any ladder, picks only on an explicit supported declaration', () => {
    expect(
      selectAdaptiveReasoningEffort({ agentId: 'base2', supported: true }),
    ).toBe('medium')
    expect(selectAdaptiveReasoningEffort({ agentId: 'base2' })).toBeUndefined()
  })
})
