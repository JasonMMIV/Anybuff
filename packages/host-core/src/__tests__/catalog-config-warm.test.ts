/**
 * ADR-31 trigger table (OmniChat §6.3): the models.dev catalog is warmed only
 * from configuration changes — never on startup, never on an unchanged save.
 *
 * Pins:
 *   - `getState` is offline (no request) even with an unknown model;
 *   - saving unchanged providers performs zero requests;
 *   - saving an ADDED model warms just that pair and returns its ladder;
 *   - the panel looks up once per process; a second open is a memory read;
 *   - an explicit `{ refresh: true }` always refreshes;
 *   - nothing is written back to settings (catalog is background knowledge);
 *   - `modelCatalog.online = false` keeps the whole path offline.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearModelCatalogCacheForTest, setModelCatalogOnline } from '@codebuff/sdk'
import { installHostEnv } from '../env'
import { createHost } from '../channels'
import { resetModelCapabilitiesWarmForTest } from '../channels/handlers-capabilities'
import { noEncryptionSecrets } from './helpers'
import { loadSettings, updateProviders } from '../settings/settings'
import { catalogWarmTarget, warmModelCatalogForModels } from '../model-catalog-warm'

const CATALOG = {
  deepseek: {
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-v999-anybuff-test': {
        limit: { context: 1_048_576, output: 393_216 },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        cost: { input: 0.15, output: 0.6 },
      },
      'deepseek-v998-anybuff-test': {
        limit: { context: 262_144, output: 32_768 },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }],
      },
    },
  },
}

const originalFetch = globalThis.fetch
let requests = 0
let dataDir = ''

function provider(models: string[]) {
  return {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible' as const,
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models,
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'host-catalog-warm-'))
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
    keyOverrides: {},
  })
  clearModelCatalogCacheForTest()
  resetModelCapabilitiesWarmForTest()
  requests = 0
  globalThis.fetch = (async () => {
    requests += 1
    return new Response(JSON.stringify(CATALOG), { status: 200 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearModelCatalogCacheForTest()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('catalog triggers (ADR-31, OmniChat §6.3)', () => {
  test('getState stays offline even when a model has no local ladder', async () => {
    updateProviders(
      [provider(['deepseek-v999-anybuff-test'])],
      'deepseek/deepseek-v999-anybuff-test',
      'default',
      'balanced'
    )
    const host = createHost()
    const state = (await host.dispatch('getState', [])) as {
      ok: true
      result: { settings: { reasoningLadders: Record<string, string[]> } }
    }
    // Flush a microtask: a future fire-and-forget trigger would bump the
    // counter on the next tick, not necessarily in the same synchronous frame.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toBe(0)
    expect(
      state.result.settings.reasoningLadders['deepseek/deepseek-v999-anybuff-test']
    ).toBeUndefined()
  })

  test('saving an unchanged provider list performs zero requests', async () => {
    const models = ['deepseek-v999-anybuff-test']
    updateProviders([provider(models)], 'deepseek/deepseek-v999-anybuff-test', 'default', 'balanced')
    const host = createHost()
    const saved = (await host.dispatch('saveSettings', [
      {
        providers: [provider([...models])],
        activeModel: 'deepseek/deepseek-v999-anybuff-test',
        reasoningEffort: 'default',
        approvalMode: 'balanced',
      },
    ])) as { ok: boolean }
    expect(saved.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toBe(0)
  })

  test('saving an ADDED model warms just that pair and returns its ladder', async () => {
    updateProviders(
      [provider(['deepseek-v999-anybuff-test'])],
      'deepseek/deepseek-v999-anybuff-test',
      'default',
      'balanced'
    )
    const host = createHost()
    const saved = (await host.dispatch('saveSettings', [
      {
        providers: [provider(['deepseek-v999-anybuff-test', 'deepseek-v998-anybuff-test'])],
        activeModel: 'deepseek/deepseek-v998-anybuff-test',
        reasoningEffort: 'default',
        approvalMode: 'balanced',
      },
    ])) as { ok: boolean; settings: { reasoningLadders: Record<string, string[]> } }
    expect(saved.ok).toBe(true)
    expect(requests).toBe(1)
    expect(saved.settings.reasoningLadders['deepseek/deepseek-v998-anybuff-test']).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ])
    // Background knowledge, never a persisted declaration.
    expect(loadSettings().providers[0]?.modelCapabilities).toBeUndefined()
  })

  test('a new provider warms its models and still never writes settings', async () => {
    const host = createHost()
    const saved = (await host.dispatch('saveSettings', [
      {
        providers: [
          {
            ...provider(['deepseek-v999-anybuff-test']),
            id: 'newlab',
            label: 'New Lab',
            baseURL: 'https://api.newlab.test/v1',
          },
        ],
        activeModel: 'newlab/deepseek-v999-anybuff-test',
        reasoningEffort: 'default',
        approvalMode: 'balanced',
      },
    ])) as { ok: boolean; settings: { providers: Array<{ modelCapabilities?: unknown }> } }
    expect(saved.ok).toBe(true)
    // Its model is new → one bounded warm (the pair misses → one refresh).
    expect(requests).toBe(1)
    expect(saved.settings.providers[0]?.modelCapabilities).toBeUndefined()
  })

  test('the panel looks up once per process; later opens are memory reads', async () => {
    updateProviders(
      [provider(['deepseek-v999-anybuff-test'])],
      'deepseek/deepseek-v999-anybuff-test',
      'default',
      'balanced'
    )
    const host = createHost()
    const first = (await host.dispatch('listModelCapabilities', [])) as {
      ok: boolean
      rows: Array<{ key: string; source: string; efforts: string[] }>
    }
    expect(first.ok).toBe(true)
    const row = first.rows.find((r) => r.key === 'deepseek/deepseek-v999-anybuff-test')
    expect(row?.source).toBe('catalog')
    expect(row?.efforts).toEqual(['low', 'high', 'max'])
    expect(requests).toBe(1)

    await host.dispatch('listModelCapabilities', [])
    expect(requests).toBe(1)
  })

  test('an explicit refresh bypasses the once-per-process warm', async () => {
    updateProviders(
      [provider(['deepseek-v999-anybuff-test'])],
      'deepseek/deepseek-v999-anybuff-test',
      'default',
      'balanced'
    )
    const host = createHost()
    await host.dispatch('listModelCapabilities', [])
    expect(requests).toBe(1)
    await host.dispatch('listModelCapabilities', [{ refresh: true }])
    expect(requests).toBe(2)
  })

  test('the model warm is bounded — a slow fetch still returns', async () => {
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      return new Response(JSON.stringify(CATALOG), { status: 200 })
    }) as unknown as typeof fetch
    const started = Date.now()
    const result = await warmModelCatalogForModels(
      [catalogWarmTarget(provider(['deepseek-v999-anybuff-test']), 'deepseek-v999-anybuff-test')],
      { timeoutMs: 20 }
    )
    expect(result).toEqual({ checked: 1, pending: true })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('modelCatalog.online=false keeps the panel offline', async () => {
    setModelCatalogOnline(false)
    updateProviders(
      [provider(['deepseek-v999-anybuff-test'])],
      'deepseek/deepseek-v999-anybuff-test',
      'default',
      'balanced'
    )
    const host = createHost()
    const listed = (await host.dispatch('listModelCapabilities', [])) as {
      ok: boolean
      rows: Array<{ key: string; source: string }>
    }
    expect(requests).toBe(0)
    expect(listed.rows.find((r) => r.key === 'deepseek/deepseek-v999-anybuff-test')?.source).toBe(
      'unknown'
    )
  })
})
