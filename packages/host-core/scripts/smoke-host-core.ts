#!/usr/bin/env bun
/**
 * Headless smoke test for @codebuff/host-core (M-A1/M-A2 acceptance).
 *
 * Exercises the module the way a headless host (Android proot Node, or the
 * browser-preview WS host) would: install a temp HostEnv, persist settings,
 * then invoke the channel dispatcher round-trips and a live WebSocket
 * round-trip over loopback.
 *
 * Usage: bun packages/host-core/scripts/smoke-host-core.ts
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import WebSocket from 'ws'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-core-smoke-'))
process.env.ANYBUFF_PROVIDER_CONFIG = path.join(tmp, 'anybuff.json')

async function main() {
  // Import after env defaults are set (sdk validates env at import time).
  const hostCore = await import('../src/index.ts')
  const {
    installHostEnv,
    createEventBus,
    saveSettings,
    loadSettings,
    createHost,
    startWsHost,
  } = hostCore as unknown as {
    installHostEnv: (e: unknown) => void
    createEventBus: () => {
      emit: (e: unknown) => void
      subscribe: (l: (e: unknown) => void) => () => void
    }
    saveSettings: (s: unknown) => void
    loadSettings: () => { cwd: string | null; [k: string]: unknown }
    createHost: (o: unknown) => { dispatch: (channel: string, args: unknown[]) => Promise<unknown> }
    startWsHost: (o: unknown) => Promise<{ port: number; token: string; close: () => Promise<void> }>
  }

  installHostEnv({
    paths: { dataDir: tmp, appDataDir: tmp, homeDir: tmp },
    secrets: {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('encryption unavailable in smoke env')
      },
      decryptString: () => new Uint8Array(0),
    },
  })

  // Settings round-trip (persists into tmp).
  const s = loadSettings()
  s.cwd = tmp
  saveSettings(s)
  const loaded = loadSettings()
  if (loaded.cwd !== tmp) throw new Error('settings round-trip failed')
  console.log('✓ settings persisted + reloaded')

  const bus = createEventBus()
  const host = createHost({ eventBus: bus })

  // Dispatcher round-trips.
  const projects = await host.dispatch('listProjects', [])
  if (!Array.isArray((projects as { result?: unknown }).result)) throw new Error('listProjects dispatch failed')
  console.log('✓ dispatcher round-trip (listProjects)')

  const state = await host.dispatch('getState', [])
  const stateObj = state as { ok: boolean; result?: { cwd: string | null; agentIds?: string[] } }
  if (!stateObj.ok || stateObj.result?.cwd !== tmp) throw new Error('getState dispatch failed')
  console.log(`✓ getState round-trip (${(stateObj.result?.agentIds ?? []).length} bundled agents)`)

  // Event bus broadcast.
  let sawEvent: unknown = null
  const unsub = bus.subscribe((e) => {
    sawEvent = e
  })
  bus.emit({ type: 'run_status', status: 'idle', taskId: 'smoke' })
  unsub()
  if (!sawEvent || (sawEvent as { type?: string }).type !== 'run_status') {
    throw new Error('event bus broadcast failed')
  }
  console.log('✓ event bus subscribe/emit')

  // Live WebSocket round-trip over loopback.
  const wsHost = await startWsHost({ host, eventBus: bus })
  const ws = new WebSocket(`ws://127.0.0.1:${wsHost.port}?token=${wsHost.token}`)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })

  // Bad token must be rejected — the client must NOT complete a handshake.
  // bun's ws client lacks 'unexpected-response', so assert on open-not-firing.
  const badOpened = await new Promise<boolean>((resolve) => {
    const bad = new WebSocket(`ws://127.0.0.1:${wsHost.port}?token=wrong`)
    bad.on('open', () => resolve(true))
    bad.on('error', () => resolve(false))
    setTimeout(() => {
      try {
        bad.close()
      } catch {
        // already closed
      }
      resolve(false)
    }, 1500)
  })
  if (badOpened) throw new Error('bad token was NOT rejected')
  console.log('✓ WS rejects bad token')

  const reply = await new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS request timed out')), 5000)
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id === 1) {
        clearTimeout(timer)
        resolve(msg)
      }
    })
    ws.send(JSON.stringify({ id: 1, channel: 'listProjects', args: [] }))
  })
  if (!reply.ok) throw new Error(`WS listProjects failed: ${reply.error}`)
  console.log('✓ WS dispatcher round-trip (listProjects)')

  // WS event broadcast.
  const eventSeen = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000)
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.event === 'event') {
        clearTimeout(timer)
        resolve(true)
      }
    })
    bus.emit({ type: 'run_status', status: 'running', taskId: 'ws-smoke' })
  })
  if (!(await eventSeen)) throw new Error('WS event broadcast failed')
  console.log('✓ WS event broadcast')

  ws.close()
  await wsHost.close()
  console.log('\nHOST-CORE SMOKE OK')
}

main().catch((error) => {
  console.error('\nHOST-CORE SMOKE THREW:', error)
  process.exit(1)
})
