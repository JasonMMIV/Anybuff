/**
 * ADR-27 P0 persistence contracts (MC-0.1/0.5/0.6).
 *
 * MC-0.1: providers saved through updateProviders keep their
 *   modelCapabilities — the Settings draft→payload chain used to drop the
 *   field, so every save erased hand-written declarations (verified 2026-09).
 * MC-0.5: recordProviderModelCapability learns reasoning.efforts/params
 *   without ever overriding an explicit declaration; learned context and
 *   reasoning writes are guarded per field.
 * MC-0.6: writeProviderConfigFile validates the generated anybuff.json
 *   against the SDK schema BEFORE replacing the file — per-entry isolation
 *   (2026-09-15): an invalid PROVIDER entry is dropped (loudly, and surfaced
 *   via getProviderConfigHealth) while the rest still writes through; only a
 *   failure outside the providers record rejects the whole write and keeps
 *   the previous file (ADR-13: never pre-delete).
 *
 * NOTE: each test pins its own host env at the top of its body (same
 * discipline as settings-keys.test.ts — bun:test may interleave other
 * files' work between tests, never inside one).
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installHostEnv } from '../env'
import { createHost } from '../index'
import { noEncryptionSecrets } from './helpers'
import {
  getProviderConfigHealth,
  loadSettings,
  saveSettings,
  updateProviders,
  recordProviderModelCapability,
  writeProviderConfigFile,
  type ProviderConfig,
} from '../settings/settings'

function pinEnv(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'host-mcaps-'))
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
    keyOverrides: {},
  })
  return dataDir
}

function providerWith(caps?: ProviderConfig['modelCapabilities']): ProviderConfig {
  return {
    id: 'p',
    label: 'P',
    type: 'openai-compatible',
    baseURL: 'https://p.test/v1',
    apiKeyEnv: 'P_API_KEY',
    models: ['declared-model', 'fresh-model', 'deepseek-v4-flash'],
    ...(caps ? { modelCapabilities: caps } : {}),
  }
}

describe('updateProviders (MC-0.1: declarations survive the save round-trip)', () => {
  test('modelCapabilities persist through save + reload', () => {
    const dataDir = pinEnv()
    try {
      updateProviders(
        [
          providerWith({
            'deepseek-v4-flash': {
              reasoning: {
                supported: true,
                efforts: ['low', 'high', 'max'],
                defaultEffort: 'high',
              },
            },
          }),
        ],
        'p/deepseek-v4-flash',
        'default',
        'balanced'
      )
      const round = loadSettings().providers.find((p) => p.id === 'p')
      expect(round?.modelCapabilities?.['deepseek-v4-flash']?.reasoning?.efforts).toEqual([
        'low',
        'high',
        'max'
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('recordProviderModelCapability (MC-0.5: reasoning write-back)', () => {
  test('learns efforts + params for an undeclared model', () => {
    const dataDir = pinEnv()
    try {
      updateProviders([providerWith()], 'p/fresh-model', 'default', 'balanced')
      recordProviderModelCapability({
        providerId: 'p',
        model: 'fresh-model',
        reasoning: { efforts: ['low', 'high', 'max'], params: { thinking_budget: 32000 } },
      })
      const caps = loadSettings().providers.find((p) => p.id === 'p')?.modelCapabilities
      expect(caps?.['fresh-model']?.reasoning?.efforts).toEqual(['low', 'high', 'max'])
      expect(caps?.['fresh-model']?.reasoning?.params).toEqual({ thinking_budget: 32000 })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('never overrides an explicit declaration (efforts or params)', () => {
    const dataDir = pinEnv()
    try {
      updateProviders(
        [
          providerWith({
            'declared-model': {
              reasoning: { efforts: ['low'], params: { thinking_budget: 1000 } },
            },
          }),
        ],
        'p/declared-model',
        'default',
        'balanced'
      )
      recordProviderModelCapability({
        providerId: 'p',
        model: 'declared-model',
        reasoning: { efforts: ['minimal'], params: { thinking_budget: 999 } },
      })
      const caps = loadSettings().providers.find((p) => p.id === 'p')?.modelCapabilities
      expect(caps?.['declared-model']?.reasoning?.efforts).toEqual(['low'])
      expect(caps?.['declared-model']?.reasoning?.params).toEqual({ thinking_budget: 1000 })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a learned context write and a reasoning write are independent', () => {
    const dataDir = pinEnv()
    try {
      updateProviders(
        [providerWith({ 'declared-model': { context: { windowTokens: 64000 } } })],
        'p/declared-model',
        'default',
        'balanced'
      )
      // The declared windowTokens must not block the reasoning learn (the
      // old early-return did exactly that), and the window itself is kept.
      recordProviderModelCapability({
        providerId: 'p',
        model: 'declared-model',
        windowTokens: 999999,
        reasoning: { efforts: ['low', 'high'] },
      })
      const caps = loadSettings().providers.find((p) => p.id === 'p')?.modelCapabilities
      expect(caps?.['declared-model']?.context?.windowTokens).toBe(64000)
      expect(caps?.['declared-model']?.reasoning?.efforts).toEqual(['low', 'high'])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('writeProviderConfigFile (MC-0.6: validate before write)', () => {
  test('a valid config with open-domain efforts + params writes through', () => {
    const dataDir = pinEnv()
    try {
      updateProviders(
        [
          providerWith({
            'deepseek-v4-flash': {
              reasoning: {
                efforts: ['low', 'xhigh', 'extra-high'],
                params: { thinking_budget: 32000 },
              },
              context: { windowTokens: 128000 },
            },
          }),
        ],
        'p/deepseek-v4-flash',
        'xhigh',
        'balanced'
      )
      const file = writeProviderConfigFile()
      const cfg = JSON.parse(readFileSync(file, 'utf-8'))
      const caps = cfg.providers.p.modelCapabilities['deepseek-v4-flash']
      expect(caps.reasoning.efforts).toEqual(['low', 'xhigh', 'extra-high'])
      expect(caps.reasoning.params).toEqual({ thinking_budget: 32000 })
      expect(caps.context.windowTokens).toBe(128000)
      // MC-0.2b end-to-end: the open-domain selected effort reaches anybuff.json
      expect(cfg.defaultReasoningEffort).toBe('xhigh')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('an invalid provider entry is dropped while the rest writes through', () => {
    const dataDir = pinEnv()
    try {
      // Two providers: one healthy, one with a structurally broken baseURL
      // (the simplest field the host does not sanitize). Per-entry isolation
      // (2026-09-15): the broken entry is dropped, the healthy one — and the
      // routing it carries — still writes through.
      updateProviders(
        [
          providerWith(),
          { ...providerWith(), id: 'broken', label: 'Broken', baseURL: 'not-a-url' },
        ],
        'p/fresh-model',
        'default',
        'balanced'
      )
      const file = writeProviderConfigFile()
      const cfg = JSON.parse(readFileSync(file, 'utf-8'))
      expect(cfg.providers.p).toBeTruthy()
      expect(cfg.providers.broken).toBeUndefined()
      expect(cfg.defaultModel).toBe('p/fresh-model')
      // The drop is surfaced, never console-only (2026-09-15 incident).
      const health = getProviderConfigHealth()
      expect(health.rejection).toBeUndefined()
      expect(health.dropped.some((entry) => entry.startsWith('broken:'))).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a failure outside the providers record keeps the previous anybuff.json', () => {
    const dataDir = pinEnv()
    try {
      updateProviders([providerWith()], 'p/fresh-model', 'default', 'balanced')
      const first = writeProviderConfigFile()
      const firstBody = readFileSync(first, 'utf-8')
      expect(JSON.parse(firstBody).providers).toBeTruthy()
      // Corrupt a NON-provider field. activeModel is self-healed at load
      // (empty falls back to the previous value) and provider entries are
      // dropped per-entry, so use approvalMode: it rides through loadSettings
      // unvalidated but the SDK schema pins it to an enum — the writer must
      // fail loud on such a corrupted/hand-edited store (whole-file
      // rejection, ADR-27 MC-0.6).
      const corrupted = loadSettings()
      ;(corrupted as unknown as Record<string, unknown>).approvalMode = 'bogus'
      saveSettings(corrupted)
      const second = writeProviderConfigFile()
      expect(readFileSync(second, 'utf-8')).toBe(firstBody) // unchanged — rejected
      expect(getProviderConfigHealth().rejection).toBeTruthy()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('configHealth channel contract (MC-0.6 surface)', () => {
  test('a dropped provider entry rides the saveSettings envelope and getState', async () => {
    const dataDir = pinEnv()
    try {
      const host = createHost()
      const save = (await host.dispatch('saveSettings', [
        {
          providers: [
            providerWith(),
            { ...providerWith(), id: 'broken', label: 'Broken', baseURL: 'not-a-url' },
          ],
          activeModel: 'p/fresh-model',
          reasoningEffort: 'default',
          approvalMode: 'balanced',
        },
      ])) as {
        ok: boolean
        configHealth?: { dropped: string[]; rejection?: string }
      }
      // saveSettings is an envelope handler: its own `{ok, …}` object passes
      // through dispatch untouched (no `.result` nesting).
      expect(save.ok).toBe(true)
      expect(save.configHealth?.rejection).toBeUndefined()
      expect(
        save.configHealth?.dropped.some((entry) => entry.startsWith('broken:')),
      ).toBe(true)
      // getState surfaces the same health so the Model & Provider page banner
      // is populated on load, not only right after a save.
      const state = (await host.dispatch('getState', [])) as {
        ok: boolean
        result?: { configHealth?: { dropped: string[] } }
      }
      expect(state.ok).toBe(true)
      expect(
        state.result?.configHealth?.dropped.some((entry) => entry.startsWith('broken:')),
      ).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
