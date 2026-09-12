import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  clearProviderConfigCacheForTest,
  modelCapabilitiesSchema,
  providerConfigFileSchema,
} from '../provider-config'
import {
  clampReasoningEffortToLadder,
  getVerifiedReasoningLadderRows,
  isKnownReasoningSpelling,
} from '../impl/reasoning-effort'
import { getModelForRequest } from '../impl/model-provider'

/**
 * ADR-27 P0 guards (MC-0.2/0.3/0.7a + §8 wire-literal guard):
 * - the effort value domain is OPEN: any non-empty string that is not the
 *   'default' sentinel loads and reaches the wire verbatim;
 * - a single malformed value degrades its own slot instead of failing the
 *   whole config file (§2.4 — one typo used to 400 every request);
 * - seed provenance (verifiedAt/source) leaves the SDK (MC-0.3);
 * - `xhigh` and `extra-high` are DIFFERENT wire literals — no layer may
 *   "helpfully" normalize one into the other;
 * - an opt-in adaptive pick logs [anybuff-compat] (MC-0.7a) — a silent
 *   behavior change is suppression's cousin (ADR-10).
 */

async function withConfig(
  config: Record<string, unknown>,
  scenario: () => void | Promise<void>,
): Promise<void> {
  const priorConfigEnv = process.env.ANYBUFF_PROVIDER_CONFIG
  const dataDir = mkdtempSync(join(tmpdir(), 'sdk-mcaps-'))
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

describe('modelCapabilitiesSchema (MC-0.2: open effort domain)', () => {
  it('custom rungs load verbatim — xhigh/ultra/vendor spellings', () => {
    const caps = modelCapabilitiesSchema.parse({
      reasoning: {
        supported: true,
        efforts: ['low', 'xhigh', 'ultra', 'turbo-boost'],
        defaultEffort: 'xhigh',
      },
    })
    expect(caps.reasoning?.efforts).toEqual(['low', 'xhigh', 'ultra', 'turbo-boost'])
    expect(caps.reasoning?.defaultEffort).toBe('xhigh')
  })

  it('a malformed entry degrades without failing the rest (§2.4)', () => {
    const caps = modelCapabilitiesSchema.parse({
      reasoning: {
        supported: true,
        efforts: ['low', '', 'high', 42, 'default'],
        defaultEffort: 'default',
      },
      context: { windowTokens: 128000, outputTokens: 8192 },
    })
    // empty/non-string/sentinel entries are dropped from the ladder;
    // the sentinel defaultEffort degrades to "unset" — never a hard failure
    expect(caps.reasoning?.efforts).toEqual(['low', 'high'])
    expect(caps.reasoning?.defaultEffort).toBeUndefined()
    expect(caps.reasoning?.supported).toBe(true)
    expect(caps.context?.windowTokens).toBe(128000)
  })

  it('a garbage reasoning block is dropped, not fatal', () => {
    const caps = modelCapabilitiesSchema.parse({
      reasoning: 'high',
      context: { windowTokens: 1000 },
    })
    expect(caps.reasoning).toBeUndefined()
    expect(caps.context?.windowTokens).toBe(1000)
  })

  it('reasoning.params accepts scalar vendor params (§3.2)', () => {
    const caps = modelCapabilitiesSchema.parse({
      reasoning: {
        efforts: ['low'],
        params: { thinking_budget: 32000, enable: true, label: 'x' },
      },
    })
    expect(caps.reasoning?.params).toEqual({ thinking_budget: 32000, enable: true, label: 'x' })
  })

  it('garbage params entries are dropped per-key', () => {
    const caps = modelCapabilitiesSchema.parse({
      reasoning: { params: { ok: 1, '': 2, bad: { nested: true } } },
    })
    expect(caps.reasoning?.params).toEqual({ ok: 1 })
  })
})

describe('providerConfigFileSchema (MC-0.2: whole-file resilience)', () => {
  const provider = {
    type: 'openai-compatible',
    baseURL: 'http://localhost:9/v1',
    models: ['m'],
  }

  it('xhigh/ultra efforts load at file level', () => {
    const result = providerConfigFileSchema.safeParse({
      defaultModel: 'gw/m',
      defaultReasoningEffort: 'xhigh',
      providers: {
        gw: {
          ...provider,
          modelCapabilities: { m: { reasoning: { efforts: ['low', 'xhigh', 'ultra'] } } },
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('a malformed effort slot never fails the file', () => {
    const result = providerConfigFileSchema.safeParse({
      defaultModel: 'gw/m',
      defaultReasoningEffort: 42,
      modeReasoningEfforts: { default: '', plan: 'xhigh' },
      agentReasoningEfforts: { base2: 'xhigh', thinker: 42, editor: 'default' },
      providers: {
        gw: {
          ...provider,
          modelCapabilities: { m: { reasoning: { efforts: 'oops' } } },
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('a garbage modelCapabilities row is dropped, not fatal', () => {
    const result = providerConfigFileSchema.safeParse({
      defaultModel: 'gw/m',
      providers: {
        gw: {
          ...provider,
          modelCapabilities: { '': {}, m: 'high', ok: { context: { windowTokens: 1 } } },
        },
      },
    })
    expect(result.success).toBe(true)
  })
})

describe('wire-literal guard (§8): xhigh ≠ extra-high', () => {
  it('clamp never rewrites a declared literal into its alias', () => {
    expect(clampReasoningEffortToLadder('xhigh', ['low', 'high', 'xhigh'])).toBe('xhigh')
    expect(clampReasoningEffortToLadder('extra-high', ['low', 'high', 'extra-high'])).toBe(
      'extra-high',
    )
  })

  it('both spellings survive the schema as distinct literals', () => {
    const caps = modelCapabilitiesSchema.parse({
      reasoning: { efforts: ['xhigh', 'extra-high'] },
    })
    expect(caps.reasoning?.efforts).toEqual(['xhigh', 'extra-high'])
  })
})

describe('getVerifiedReasoningLadderRows (MC-0.3: provenance export)', () => {
  it('every seed row carries a machine-checkable verifiedAt + source', () => {
    const rows = getVerifiedReasoningLadderRows()
    expect(Object.keys(rows).length).toBeGreaterThan(40)
    for (const row of Object.values(rows)) {
      expect(typeof row.verifiedAt).toBe('string')
      expect(row.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(typeof row.source).toBe('string')
      expect(row.source.length).toBeGreaterThan(0)
      expect(row.efforts.length).toBeGreaterThan(0)
    }
  })

  it('DeepSeek rows carry the documented requestMap (parity with ADR-25)', () => {
    const rows = getVerifiedReasoningLadderRows()
    expect(rows['deepseek-v4-flash']?.requestMap?.medium).toBe('high')
    expect(rows['deepseek-v4-pro']?.requestMap?.max).toBe('max')
  })

  it('isKnownReasoningSpelling badges shared vocabulary, not legality', () => {
    expect(isKnownReasoningSpelling('high')).toBe(true)
    expect(isKnownReasoningSpelling('xhigh')).toBe(true)
    expect(isKnownReasoningSpelling('extra-high')).toBe(true)
    expect(isKnownReasoningSpelling('turbo-boost')).toBe(false) // legal, just unrecognized
  })
})

describe('adaptiveReasoning opt-in pick visibility (MC-0.7a)', () => {
  function optInConfig(adaptiveReasoning: boolean): Record<string, unknown> {
    return {
      adaptiveReasoning,
      defaultModel: 'test-gw/deepseek-v4-flash',
      providers: {
        'test-gw': {
          type: 'openai-compatible',
          baseURL: 'http://localhost:9/v1',
          models: ['deepseek-v4-flash'],
          modelCapabilities: {
            'deepseek-v4-flash': {
              reasoning: { supported: true, efforts: ['low', 'high', 'max'] },
            },
          },
        },
      },
    }
  }

  it('an opt-in pick logs [anybuff-compat]; Default never logs the pick', async () => {
    const logs: string[] = []
    const original = console.info
    console.info = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      await withConfig(optInConfig(true), async () => {
        logs.length = 0
        const result = await getModelForRequest({
          agentId: 'base2',
          model: 'test-gw/deepseek-v4-flash',
          tools: [],
          inputSchema: { type: 'object', properties: {} },
        } as never)
        expect(result.reasoningEffort).toBe('high')
        expect(logs.some((line) => line.includes('adaptive-reasoning-pick'))).toBe(true)
        expect(logs.some((line) => line.includes('[anybuff-compat]'))).toBe(true)
      })
      await withConfig(optInConfig(false), async () => {
        logs.length = 0
        const result = await getModelForRequest({
          agentId: 'base2',
          model: 'test-gw/deepseek-v4-flash',
          tools: [],
          inputSchema: { type: 'object', properties: {} },
        } as never)
        expect(result.reasoningEffort).toBeUndefined()
        expect(logs.some((line) => line.includes('adaptive-reasoning-pick'))).toBe(false)
      })
    } finally {
      console.info = original
    }
  })
})
