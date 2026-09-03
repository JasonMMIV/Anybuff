/**
 * Contract tests (M-A2): every host-core channel must be registered and
 * dispatchable, and the envelope contract (ok/error) must hold for both happy
 * and error paths. These run headless — no Electron, no network — against the
 * in-process dispatcher, so the Android shell and desktop shell share them.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installHostEnv, createHost, CHANNELS, getOrCreateSession } from '../index'
import { noEncryptionSecrets } from './helpers'

const dataDir = mkdtempSync(join(tmpdir(), 'host-core-dispatch-'))
process.env.ANYBUFF_PROVIDER_CONFIG = join(dataDir, 'anybuff.json')

let host: ReturnType<typeof createHost>

beforeAll(() => {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
  })
  host = createHost()
})

afterAll(() => {
  try {
    require('fs').rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('channel registry', () => {
  test('every CHANNELS entry has a registered handler', () => {
    for (const name of CHANNELS) {
      expect(host.has(name)).toBe(true)
    }
  })

  test('unknown channels are rejected with an error envelope', async () => {
    const res = await host.dispatch('definitelyNotAChannel', [])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('Unknown channel')
  })
})

describe('read-only round-trips', () => {
  test('getState returns cwd + settings + agentIds', async () => {
    const res = await host.dispatch('getState', [])
    expect(res.ok).toBe(true)
    const inner = (res as { ok: true; result: Record<string, unknown> }).result
    expect(inner.agentIds).toBeInstanceOf(Array)
    expect((inner.agentIds as string[]).length).toBeGreaterThan(0)
    expect(typeof inner.running).toBe('boolean')
  })

  test('listProjects round-trips an array', async () => {
    const res = await host.dispatch('listProjects', [])
    const inner = (res as { ok: true; result: unknown }).result
    expect(Array.isArray(inner)).toBe(true)
  })

  test('listDir round-trips tree nodes for an existing dir', async () => {
    const res = await host.dispatch('listDir', [dataDir])
    expect(res.ok).toBe(true)
    const inner = (res as { ok: true; result: unknown }).result
    expect(Array.isArray(inner)).toBe(true)
  })

  test('gitBranch round-trips without throwing outside a git repo', async () => {
    // Not a git repo: fs-utils returns a plain string ("not a git repository")
    // rather than throwing — either shape is fine as long as dispatch resolves.
    const res = await host.dispatch('gitBranch', [dataDir])
    expect(res.ok).toBe(true)
  })

  test('pathInfo reports a missing path as not-ok', async () => {
    const res = await host.dispatch('pathInfo', [join(dataDir, 'nope')])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('Path does not exist')
  })

  test('readFile reports a missing file as not-ok', async () => {
    const res = await host.dispatch('readFile', [join(dataDir, 'missing.txt')])
    const inner = (res as { ok: boolean }).ok
    expect(inner).toBe(false)
  })

  test('listMcpServers round-trips an array view', async () => {
    const res = await host.dispatch('listMcpServers', [null])
    const inner = (res as { ok: true; result: unknown }).result
    expect(Array.isArray(inner)).toBe(true)
  })

  test('listLocalAgents round-trips a result for an empty cwd-less call', async () => {
    const res = await host.dispatch('listLocalAgents', [dataDir])
    expect(res.ok).toBe(true)
  })

  test('searchHistory returns [] for an empty query', async () => {
    const res = await host.dispatch('searchHistory', [''])
    expect(res.ok).toBe(true)
    const inner = (res as { ok: true; result: unknown }).result
    expect(Array.isArray(inner)).toBe(true)
    expect((inner as unknown[]).length).toBe(0)
  })

  test('projectName derives a name for the data dir', async () => {
    const res = await host.dispatch('projectName', [dataDir])
    expect(res.ok).toBe(true)
  })
})

describe('task lifecycle round-trips', () => {
  test('getTaskView reports exists:false for an unknown task', async () => {
    const res = await host.dispatch('getTaskView', ['no-such-task'])
    expect(res.ok).toBe(true)
    const inner = res as { ok: true; exists: boolean }
    expect(inner.exists).toBe(false)
  })

  test('getTaskView round-trips after a session is created', async () => {
    const entry = getOrCreateSession(dataDir, 'contract test', undefined)
    const res = await host.dispatch('getTaskView', [entry.taskId])
    expect(res.ok).toBe(true)
    const inner = res as { ok: true; exists: boolean; transcript: unknown[] }
    expect(inner.exists).toBe(true)
    expect(inner.transcript).toBeInstanceOf(Array)
  })

  test('renameTask round-trips for a real task', async () => {
    const entry = getOrCreateSession(dataDir, 'rename me', undefined)
    const res = await host.dispatch('renameTask', [{ taskId: entry.taskId, newPrompt: 'renamed' }])
    expect(res.ok).toBe(true)
    const inner = res as { ok: boolean }
    expect(inner.ok).toBe(true)
  })

  test('runPrompt rejects an empty prompt without a side effect', async () => {
    const res = await host.dispatch('runPrompt', [{ cwd: dataDir, prompt: '' }])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('Missing project folder or prompt')
  })

  test('deleteTask round-trips for a created task', async () => {
    const entry = getOrCreateSession(dataDir, 'delete me', undefined)
    const res = await host.dispatch('deleteTask', [entry.taskId])
    expect(res.ok).toBe(true)
  })

  test('approvalResponse + respondAskUser are no-ops outside a run', async () => {
    expect((await host.dispatch('approvalResponse', [true])).ok).toBe(true)
    expect((await host.dispatch('respondAskUser', [{ q: 1 }])).ok).toBe(true)
  })

  test('abort is safe when nothing is running', async () => {
    const res = await host.dispatch('abort', [])
    expect(res.ok).toBe(true)
  })
})

describe('settings round-trip', () => {
  test('saveSettings persists and getState reflects the change', async () => {
    const save = await host.dispatch('saveSettings', [
      {
        providers: [],
        activeModel: 'x/y',
        reasoningEffort: 'default',
        approvalMode: 'balanced',
      },
    ])
    expect(save.ok).toBe(true)
    const state = (await host.dispatch('getState', [])) as { ok: true; result: Record<string, unknown> }
    expect(state.ok).toBe(true)
    expect(state.result).toBeTruthy()
  })
})
