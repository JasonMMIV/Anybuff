/**
 * Provider/web-search key persistence contract (2026-09-08 device round 10).
 *
 * The Android headless host installs a memory-only keyPersistence seam
 * (anybuff-host.ts) because its SecretStore refuses disk encryption by
 * design (ADR-11/12 — the Kotlin Keystore is the durable store). These
 * tests lock the seam contract the Android shell depends on:
 *   1. saveSettings with apiKeys updates the in-memory overlay (the live
 *      read path for runs and the Key-Set badges), never throws.
 *   2. deleteKeys removes the overlay entry.
 *   3. searchApiKeys ride the same overlay under their vault-key ids
 *      (search-tinyfish / search-firecrawl, ADR-17). * 4. Without a seam (and no encryption), key failures are reported in
 *      `keyErrors` while the rest of the payload still persists — one bad
 *      key must never silently drop routing/web-search fields.
 *
 * NOTE: every test pins its own env at the top of its body instead of
 * relying on nested beforeAll hooks — bun:test hoists describe-level
 * beforeAll callbacks ahead of ALL test bodies in the file (verified with
 * a probe: execution order was top→b-before→a1→b1), so a "re-install
 * without seam" hook would clobber the seam tests' environment before
 * they ever run. dispatch() reads the env lazily per call, so pinning
 * inside the test body is authoritative.
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installHostEnv, hostKeyOverrides } from '../env'
import { createHost } from '../index'
import { noEncryptionSecrets } from './helpers'

const dataDir = mkdtempSync(join(tmpdir(), 'host-core-keys-'))
process.env.ANYBUFF_PROVIDER_CONFIG = join(dataDir, 'anybuff.json')

const providers = [
  {
    id: 'p1',
    label: 'P1',
    type: 'openai-compatible' as const,
    baseURL: 'https://api.example.com/v1',
    apiKeyEnv: 'P1_KEY',
    models: ['m1', 'm2'],
  },
]

/** Install the Android-headless env WITH the keyPersistence seam (fresh overlay).
 * The seam bodies mirror the production seam in anybuff-host.ts exactly —
 * intentionally NO-OP: the seam's only job is to gate the branch, and
 * settings.ts is the single overlay writer. Keeping the test seam no-op
 * means the overlay assertions below genuinely lock that contract (a
 * compensating write here would mask a settings.ts regression). */
function installWithSeam(): void {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
    keyOverrides: {},
    keyPersistence: {
      save: () => {},
      remove: () => {},
    },
  })
}

/** Install the same env WITHOUT the seam (falls to the disk-encrypt path, which the decrypt-only store refuses). */
function installWithoutSeam(): void {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
  })
}

afterAll(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('keyPersistence seam (Android headless host)', () => {
  test('saveSettings apiKeys update the in-memory overlay and getState reflects the key', async () => {
    installWithSeam()
    const host = createHost()
    const save = (await host.dispatch('saveSettings', [
      {
        providers,
        activeModel: 'p1/m1',
        reasoningEffort: 'default',
        approvalMode: 'balanced',
        apiKeys: { p1: 'sk-test-123' },
      },
    ])) as { ok: boolean; keyErrors?: string[] }
    expect(save.ok).toBe(true)
    expect(save.keyErrors).toBeUndefined()
    expect(hostKeyOverrides()['p1']).toBe('sk-test-123')

    const state = (await host.dispatch('getState', [])) as {
      ok: boolean
      result: { settings: { providerHasKey: Record<string, boolean> } }
    }
    expect(state.ok).toBe(true)
    expect(state.result.settings.providerHasKey['p1']).toBe(true)
  })

  test('deleteKeys clears the overlay entry', async () => {
    installWithSeam()
    const host = createHost()
    // Save a key first so the delete is a real round-trip on the overlay.
    const seed = (await host.dispatch('saveSettings', [
      {
        providers,
        activeModel: 'p1/m1',
        reasoningEffort: 'default',
        approvalMode: 'balanced',
        apiKeys: { p1: 'sk-roundtrip' },
      },
    ])) as { ok: boolean }
    expect(seed.ok).toBe(true)
    expect(hostKeyOverrides()['p1']).toBe('sk-roundtrip')

    const save = (await host.dispatch('saveSettings', [
      {
        providers,
        activeModel: 'p1/m1',
        reasoningEffort: 'default',
        approvalMode: 'balanced',
        deleteKeys: ['p1'],
      },
    ])) as { ok: boolean; keyErrors?: string[] }
    expect(save.ok).toBe(true)
    expect(save.keyErrors).toBeUndefined()
    expect(hostKeyOverrides()['p1']).toBeUndefined()
  })

  test('searchApiKeys ride the same overlay (vault-key ids search-tinyfish / search-firecrawl)', async () => {
    installWithSeam()
    const host = createHost()
    const save = (await host.dispatch('saveSettings', [
      {
        providers,
        activeModel: 'p1/m1',
        reasoningEffort: 'default',
        approvalMode: 'balanced',
        searchApiKeys: { tinyfish: 'tf-key' },
      },
    ])) as { ok: boolean; keyErrors?: string[] }
    expect(save.ok).toBe(true)
    expect(save.keyErrors).toBeUndefined()
    expect(hostKeyOverrides()['search-tinyfish']).toBe('tf-key')

    const state = (await host.dispatch('getState', [])) as {
      ok: boolean
      result: { settings: { webSearchHasKey: Record<string, boolean> } }
    }
    expect(state.ok).toBe(true)
    expect(state.result.settings.webSearchHasKey['tinyfish']).toBe(true)
  })
})

describe('no seam + no encryption: honest per-key errors, other fields still saved', () => {
  test('key failures are reported in keyErrors and do not block the rest', async () => {
    installWithoutSeam()
    const host = createHost()
    const save = (await host.dispatch('saveSettings', [
      {
        providers,
        activeModel: 'p1/m2',
        reasoningEffort: 'default',
        approvalMode: 'allow-all',
        apiKeys: { p1: 'sk-doomed' },
        webSearchProvider: 'tinyfish',
        agentRouting: { editor: { model: 'p1/m2', reasoningEffort: 'low' } },
      },
    ])) as { ok: boolean; keyErrors?: string[] }

    expect(save.ok).toBe(true) // the envelope stays ok —
    expect(save.keyErrors?.length).toBeGreaterThan(0) // the key failure is itemized
    // The non-key fields persisted regardless of the key failure.
    const state = (await host.dispatch('getState', [])) as {
      ok: boolean
      result: {
        settings: {
          activeModel: string
          approvalMode: string
          agentRouting: Record<string, { model: string }>
        }
      }
    }
    expect(state.ok).toBe(true)
    expect(state.result.settings.activeModel).toBe('p1/m2')
    expect(state.result.settings.approvalMode).toBe('allow-all')
    expect(state.result.settings.agentRouting['editor']?.model).toBe('p1/m2')
  })
})
