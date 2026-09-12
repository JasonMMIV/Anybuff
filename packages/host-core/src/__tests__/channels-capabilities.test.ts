/**
 * ADR-27 P1 channel contracts (MC-1.3/1.4): the capability-maintenance
 * write path.
 *
 * - saveModelCapability: single-entry field-merge upsert (never a wholesale
 *   provider overwrite); validation errors are reported, not thrown past
 *   the dispatcher envelope.
 * - importModelCapabilities: line-by-line independence — a bad line never
 *   blocks the good ones (§2.4); only the modelCapabilities subtree is
 *   writable (§2.2 — provider transport fields must never be importable).
 * - listModelCapabilities: provenance badges for every configured model.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installHostEnv } from '../env'
import { createHost } from '../channels'
import { noEncryptionSecrets } from './helpers'
import { loadSettings } from '../settings/settings'

function pinEnv(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'host-caps-chan-'))
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
    keyOverrides: {},
  })
  return dataDir
}

const PROVIDERS = [
  {
    id: 'goat',
    label: 'Goat',
    type: 'openai-compatible' as const,
    baseURL: 'https://goat.test/v1',
    apiKeyEnv: 'GOAT_API_KEY',
    models: ['deepseek/deepseek-v4.1-flash', 'deepseek-v4-flash', 'mystery'],
  },
]

async function seedSettings(): Promise<void> {
  const { updateProviders } = await import('../settings/settings')
  updateProviders([...PROVIDERS.map((p) => ({ ...p, models: [...p.models] }))], 'goat/mystery', 'default', 'balanced')
}

describe('model-capability channels (MC-1.3/1.4)', () => {
  const host = createHost()

  test('saveModelCapability merges one entry field-by-field', async () => {
    const dataDir = pinEnv()
    try {
      await seedSettings()
      const save = (await host.dispatch('saveModelCapability', [
        {
          providerId: 'goat',
          model: 'deepseek/deepseek-v4.1-flash',
          reasoning: { supported: true, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
        },
      ])) as { ok: boolean }
      expect(save.ok).toBe(true)
      const stored = loadSettings().providers.find((p) => p.id === 'goat')?.modelCapabilities
      expect(stored?.['deepseek/deepseek-v4.1-flash']?.reasoning?.efforts).toEqual(['low', 'high', 'max'])
      // A second save with a DIFFERENT field keeps the untouched field.
      const save2 = (await host.dispatch('saveModelCapability', [
        {
          providerId: 'goat',
          model: 'deepseek/deepseek-v4.1-flash',
          context: { windowTokens: 128000 },
        },
      ])) as { ok: boolean }
      expect(save2.ok).toBe(true)
      const stored2 = loadSettings().providers.find((p) => p.id === 'goat')?.modelCapabilities
      expect(stored2?.['deepseek/deepseek-v4.1-flash']?.reasoning?.efforts).toEqual(['low', 'high', 'max'])
      expect(stored2?.['deepseek/deepseek-v4.1-flash']?.context?.windowTokens).toBe(128000)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('saveModelCapability rejects invalid rungs with a reportable error', async () => {
    const dataDir = pinEnv()
    try {
      await seedSettings()
      const result = (await host.dispatch('saveModelCapability', [
        {
          providerId: 'goat',
          model: 'mystery',
          reasoning: { efforts: ['low', ''] },
        },
      ])) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('efforts')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('importModelCapabilities applies lines independently (bad line never blocks)', async () => {
    const dataDir = pinEnv()
    try {
      await seedSettings()
      const result = (await host.dispatch('importModelCapabilities', [
        {
          providerId: 'goat',
          models: {
            'deepseek/deepseek-v4.1-flash': {
              reasoning: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
              context: { windowTokens: 128000 },
            },
            'bad-model': { reasoning: { efforts: ['oops', 42] } },
            'mystery': { reasoning: { efforts: ['low', 'xhigh'] } },
          },
        },
      ])) as { ok: boolean; lines: Array<{ model: string; ok: boolean; error?: string }> }
      expect(result.ok).toBe(false)
      const byModel = Object.fromEntries(result.lines.map((l) => [l.model, l]))
      expect(byModel['deepseek/deepseek-v4.1-flash'].ok).toBe(true)
      expect(byModel['bad-model'].ok).toBe(false)
      expect(byModel['mystery'].ok).toBe(true)
      const stored = loadSettings().providers.find((p) => p.id === 'goat')?.modelCapabilities
      expect(stored?.['deepseek/deepseek-v4.1-flash']?.reasoning?.efforts).toEqual(['low', 'high', 'max'])
      expect(stored?.['mystery']?.reasoning?.efforts).toEqual(['low', 'xhigh'])
      expect(stored?.['bad-model']).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('importModelCapabilities accepts the bare reasoning shorthand (LLM prompt format)', async () => {
    const dataDir = pinEnv()
    try {
      await seedSettings()
      const result = (await host.dispatch('importModelCapabilities', [
        {
          providerId: 'goat',
          models: {
            mystery: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
          },
        },
      ])) as { ok: boolean; lines: Array<{ model: string; ok: boolean }> }
      expect(result.ok).toBe(true)
      expect(result.lines[0].ok).toBe(true)
      const stored = loadSettings().providers.find((p) => p.id === 'goat')?.modelCapabilities
      expect(stored?.['mystery']?.reasoning?.efforts).toEqual(['low', 'high', 'max'])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('clear: true removes the whole entry (explicit clear, never accidental)', async () => {
    const dataDir = pinEnv()
    try {
      await seedSettings()
      await host.dispatch('saveModelCapability', [
        {
          providerId: 'goat',
          model: 'mystery',
          reasoning: { efforts: ['low', 'high'] },
          context: { windowTokens: 64000 },
        },
      ])
      expect(
        loadSettings().providers.find((p) => p.id === 'goat')?.modelCapabilities?.['mystery']
      ).toBeTruthy()
      // An upsert WITHOUT fields keeps the entry (absent = keep, not remove).
      await host.dispatch('saveModelCapability', [
        { providerId: 'goat', model: 'mystery' },
      ])
      expect(
        loadSettings().providers.find((p) => p.id === 'goat')?.modelCapabilities?.['mystery']
      ).toBeTruthy()
      // Explicit clear removes it.
      const cleared = (await host.dispatch('saveModelCapability', [
        { providerId: 'goat', model: 'mystery', clear: true },
      ])) as { ok: boolean }
      expect(cleared.ok).toBe(true)
      expect(
        loadSettings().providers.find((p) => p.id === 'goat')?.modelCapabilities?.['mystery']
      ).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('import reports an unrecognized entry shape instead of a silent ok', async () => {
    const dataDir = pinEnv()
    try {
      await seedSettings()
      const result = (await host.dispatch('importModelCapabilities', [
        {
          providerId: 'goat',
          models: {
            'weird-model': { windowTokens: 128000 },
          },
        },
      ])) as { ok: boolean; lines: Array<{ model: string; ok: boolean; error?: string }> }
      expect(result.ok).toBe(false)
      expect(result.lines[0].ok).toBe(false)
      expect(result.lines[0].error).toContain('unrecognized entry shape')
      expect(
        loadSettings().providers.find((p) => p.id === 'goat')?.modelCapabilities?.['weird-model']
      ).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('declared params ride the listing (MC-1.5 editor round-trip)', async () => {
    const dataDir = pinEnv()
    try {
      await seedSettings()
      await host.dispatch('saveModelCapability', [
        {
          providerId: 'goat',
          model: 'mystery',
          reasoning: {
            efforts: ['low', 'high'],
            params: { thinking_budget: 32000 },
          },
        },
      ])
      const listed = (await host.dispatch('listModelCapabilities', [])) as unknown as {
        rows: Array<{ key: string; declared?: { params?: Record<string, string | number | boolean> } }>
      }
      const row = listed.rows.find((r) => r.key === 'goat/mystery')
      expect(row?.declared?.params).toEqual({ thinking_budget: 32000 })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('listModelCapabilities returns provenance rows for every configured model', async () => {
    const dataDir = pinEnv()
    try {
      await seedSettings()
      const listed = (await host.dispatch('listModelCapabilities', [])) as {
        ok: boolean
        rows: Array<{ key: string; source: string; efforts: string[]; verifiedAt?: string }>
      }
      expect(listed.ok).toBe(true)
      const byKey = Object.fromEntries(listed.rows.map((r) => [r.key, r]))
      // Seed-backed model carries verified provenance
      expect(byKey['goat/deepseek-v4-flash'].source).toBe('verified')
      expect(byKey['goat/deepseek-v4-flash'].verifiedAt).toBe('2026-08-12')
      // The plan's §1.1 trigger case: v4.1-flash is NOT seeded — unknown badge
      expect(byKey['goat/deepseek/deepseek-v4.1-flash'].source).toBe('unknown')
      // Unseeded model is unknown with the empty ladder
      expect(byKey['goat/mystery'].source).toBe('unknown')
      expect(byKey['goat/mystery'].efforts).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
