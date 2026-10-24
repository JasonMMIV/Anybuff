/**
 * ADR-31 / ADR-32 persistence contracts.
 *
 * The generated anybuff.json is re-created from settings before every run, so
 * anything the writer does not emit — or that a Settings save drops — is
 * effectively deleted. These tests pin:
 *   - catalogProvider / catalogKeys survive a Settings payload that does not
 *     know about them (the renderer predates them);
 *   - modelCatalog.online is emitted only when false (absent = online);
 *   - reasoning.wire / budgetTokens field-merge and are never erased by a
 *     later upsert that omits them;
 *   - imported pricing/wire reach anybuff.json and pass the SDK schema.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setModelCatalogOnline } from '@codebuff/sdk'

import { installHostEnv } from '../env'
import { hydrateUnknownModelCaps } from '../run/start-run'
import { noEncryptionSecrets } from './helpers'
import {
  loadSettings,
  saveModelCapability,
  saveSettings,
  updateProviders,
  writeProviderConfigFile,
  type ProviderConfig,
} from '../settings/settings'

function pinEnv(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'host-catalog-'))
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
    keyOverrides: {},
  })
  return dataDir
}

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'my-deepseek',
    label: 'My DeepSeek',
    type: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: ['deepseek-v4-flash'],
    ...overrides,
  }
}

describe('updateProviders (ADR-31: host-only slots survive a save)', () => {
  test('catalogProvider / catalogKeys are preserved when the payload omits them', () => {
    const dataDir = pinEnv()
    try {
      updateProviders([provider()], 'my-deepseek/deepseek-v4-flash', 'default', 'balanced')
      // A renderer payload from before ADR-31 (no catalog slots).
      updateProviders(
        [provider({ catalogProvider: 'deepseek', catalogKeys: { 'deepseek-v4-flash': 'deepseek/deepseek-v4-flash' } })],
        'my-deepseek/deepseek-v4-flash',
        'default',
        'balanced',
      )
      const withoutSlots = provider()
      updateProviders([withoutSlots], 'my-deepseek/deepseek-v4-flash', 'default', 'balanced')
      const saved = loadSettings().providers[0]!
      expect(saved.catalogProvider).toBe('deepseek')
      expect(saved.catalogKeys).toEqual({
        'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a provider the user removed is not resurrected', () => {
    const dataDir = pinEnv()
    try {
      updateProviders(
        [
          provider(),
          provider({ id: 'second', label: 'Second', baseURL: 'https://second.test/v1' }),
        ],
        'my-deepseek/deepseek-v4-flash',
        'default',
        'balanced',
      )
      updateProviders(
        [provider()],
        'my-deepseek/deepseek-v4-flash',
        'default',
        'balanced',
      )
      const ids = loadSettings().providers.map((p) => p.id)
      expect(ids).toEqual(['my-deepseek'])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('reasoning wire persistence (ADR-32)', () => {
  test('wire/budgetTokens merge field-by-field and survive later upserts', () => {
    const dataDir = pinEnv()
    try {
      updateProviders([provider()], 'my-deepseek/deepseek-v4-flash', 'default', 'balanced')
      expect(
        saveModelCapability({
          providerId: 'my-deepseek',
          model: 'deepseek-v4-flash',
          reasoning: {
            efforts: ['low', 'high'],
            wire: 'chat.thinking_budget',
            budgetTokens: 32000,
          },
        }),
      ).toBe(true)

      // A later edit of the ladder must not wipe the dialect.
      expect(
        saveModelCapability({
          providerId: 'my-deepseek',
          model: 'deepseek-v4-flash',
          reasoning: { efforts: ['low', 'medium', 'high'] },
        }),
      ).toBe(true)

      const entry = loadSettings().providers[0]!.modelCapabilities![
        'deepseek-v4-flash'
      ]!
      expect(entry.reasoning?.wire).toBe('chat.thinking_budget')
      expect(entry.reasoning?.budgetTokens).toBe(32000)
      expect(entry.reasoning?.efforts).toEqual(['low', 'medium', 'high'])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('an unknown dialect is rejected with a reportable error', () => {
    const dataDir = pinEnv()
    try {
      updateProviders([provider()], 'my-deepseek/deepseek-v4-flash', 'default', 'balanced')
      expect(() =>
        saveModelCapability({
          providerId: 'my-deepseek',
          model: 'deepseek-v4-flash',
          reasoning: { wire: 'chat.not-a-dialect' },
        }),
      ).toThrow(/reasoning\.wire must be one of/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('budgetTokens must be a positive integer', () => {
    const dataDir = pinEnv()
    try {
      updateProviders([provider()], 'my-deepseek/deepseek-v4-flash', 'default', 'balanced')
      expect(() =>
        saveModelCapability({
          providerId: 'my-deepseek',
          model: 'deepseek-v4-flash',
          reasoning: { budgetTokens: 0 },
        }),
      ).toThrow(/budgetTokens/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('saveModelCapability (ADR-31/32 slots)', () => {
  test('stores wire + pricing field by field', () => {
    const dataDir = pinEnv()
    try {
      updateProviders([provider()], 'my-deepseek/deepseek-v4-flash', 'default', 'balanced')
      const saved = saveModelCapability({
        providerId: 'my-deepseek',
        model: 'deepseek-v4-flash',
        reasoning: {
          efforts: ['low', 'high'],
          wire: 'chat.effort',
          budgetTokens: 8000,
        },
        context: { windowTokens: 640000 },
        pricing: {
          inputPerMillionTokens: 0.15,
          outputPerMillionTokens: 0.6,
          tiers: [{ minContextTokens: 200000, input: 0.3 }],
        },
      })
      expect(saved).toBe(true)
      const entry = loadSettings().providers[0]!.modelCapabilities![
        'deepseek-v4-flash'
      ]!
      expect(entry.reasoning?.wire).toBe('chat.effort')
      expect(entry.reasoning?.budgetTokens).toBe(8000)
      expect(entry.pricing?.inputPerMillionTokens).toBe(0.15)
      expect(entry.pricing?.tiers?.[0]?.minContextTokens).toBe(200000)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('an invalid pricing value is rejected without writing the entry', () => {
    const dataDir = pinEnv()
    try {
      updateProviders([provider()], 'my-deepseek/deepseek-v4-flash', 'default', 'balanced')
      expect(() =>
        saveModelCapability({
          providerId: 'my-deepseek',
          model: 'deepseek-v4-flash',
          pricing: { inputPerMillionTokens: -1 },
        })
      ).toThrow(/non-negative/)
      expect(
        loadSettings().providers[0]!.modelCapabilities?.['deepseek-v4-flash']
      ).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('generated anybuff.json (ADR-31)', () => {
  test('emits catalog slots and modelCatalog.online=false; SDK schema accepts it', () => {
    const dataDir = pinEnv()
    try {
      updateProviders(
        [
          provider({
            catalogProvider: 'deepseek',
            catalogKeys: { 'deepseek-v4-flash': 'deepseek/deepseek-v4-flash' },
            modelCapabilities: {
              'deepseek-v4-flash': {
                reasoning: {
                  efforts: ['low', 'high'],
                  wire: 'chat.thinking_budget',
                  budgetTokens: 32000,
                },
                pricing: {
                  inputPerMillionTokens: 0.15,
                  cacheWritePerMillionTokens: 0.02,
                  tiers: [{ minContextTokens: 200000, input: 0.3 }],
                },
              },
            },
          }),
        ],
        'my-deepseek/deepseek-v4-flash',
        'default',
        'balanced',
      )
      const settings = loadSettings()
      settings.modelCatalogOnline = false
      saveSettings(settings)

      const path = writeProviderConfigFile()
      const config = JSON.parse(readFileSync(path, 'utf8'))
      expect(config.modelCatalog).toEqual({ online: false })
      expect(config.providers['my-deepseek'].catalogProvider).toBe('deepseek')
      expect(config.providers['my-deepseek'].catalogKeys).toEqual({
        'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
      })
      expect(
        config.providers['my-deepseek'].modelCapabilities['deepseek-v4-flash']
          .reasoning,
      ).toEqual({
        efforts: ['low', 'high'],
        wire: 'chat.thinking_budget',
        budgetTokens: 32000,
      })
      expect(
        config.providers['my-deepseek'].modelCapabilities['deepseek-v4-flash']
          .pricing,
      ).toEqual({
        inputPerMillionTokens: 0.15,
        cacheWritePerMillionTokens: 0.02,
        tiers: [{ minContextTokens: 200000, input: 0.3 }],
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('hydrateUnknownModelCaps only prefetches — never writes settings', async () => {
    const dataDir = pinEnv()
    try {
      // Offline: the prefetch resolves to false without a network call.
      setModelCatalogOnline(false)
      updateProviders(
        [provider({ models: ['mystery-model'] })],
        'my-deepseek/mystery-model',
        'default',
        'balanced',
      )
      const before = JSON.stringify(loadSettings())
      hydrateUnknownModelCaps(loadSettings(), 'base2')
      await new Promise((resolve) => setTimeout(resolve, 25))
      // Plan §8.1/D9: catalog values are read-only; only A2's overflow
      // learning may persist a capability.
      expect(JSON.stringify(loadSettings())).toBe(before)
    } finally {
      setModelCatalogOnline(undefined)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('emits no modelCatalog block by default (online)', () => {
    const dataDir = pinEnv()
    try {
      updateProviders([provider()], 'my-deepseek/deepseek-v4-flash', 'default', 'balanced')
      const path = writeProviderConfigFile()
      const config = JSON.parse(readFileSync(path, 'utf8'))
      expect('modelCatalog' in config).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
