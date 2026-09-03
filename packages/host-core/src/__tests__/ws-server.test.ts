/**
 * WebSocket host contract tests (M-A2): token auth, envelope routing, event
 * broadcast, and origin checking — the transport the Android shell (Phase B)
 * will use. Uses the node `ws` client via a child bun process? No — bun's ws
 * client is enough for open/message; bad-token uses a raw http probe like the
 * smoke script.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { installHostEnv, createHost, createEventBus, bridgeEventBus, startWsHost } from '../index'
import { noEncryptionSecrets } from './helpers'

const dataDir = mkdtempSync(join(tmpdir(), 'host-core-ws-'))
process.env.ANYBUFF_PROVIDER_CONFIG = join(dataDir, 'anybuff.json')

let bus: ReturnType<typeof createEventBus>
let server: Awaited<ReturnType<typeof startWsHost>>

function wsUrl(): string {
  return `ws://127.0.0.1:${server.port}?token=${server.token}`
}

async function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  return ws
}

/** Send a request and await its matching response. */
function roundTrip(ws: WebSocket, id: number, channel: string, args: unknown[]): Promise<{ id: number; ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${channel}`)), 5000)
    const onMsg = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as { id: number; ok: boolean; result?: unknown; error?: string }
      if (msg.id === id) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, channel, args }))
  })
}

beforeAll(async () => {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets(),
  })
  bus = createEventBus()
  server = await startWsHost({
    host: createHost({ eventBus: bus }),
    eventBus: bus,
    allowedOrigins: ['https://localhost'],
  })
})

afterAll(async () => {
  await server.close()
  try {
    require('fs').rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe('auth & handshake', () => {
  test('server listens on loopback with a token', () => {
    expect(server.port).toBeGreaterThan(0)
    expect(server.token.length).toBeGreaterThanOrEqual(32)
  })

  test('a valid token connects', async () => {
    const ws = await openWs(wsUrl())
    ws.close()
  })

  test('a bad token is rejected before the WS handshake completes', async () => {
    const { createConnection } = await import('net')
    const { randomBytes } = await import('crypto')
    const key = randomBytes(16).toString('base64')
    const outcome = await new Promise<'ok' | 'rejected' | 'timeout'>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: server.port }, () => {
        socket.write(
          'GET /?token=wrong HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n' +
            '\r\n',
        )
      })
      socket.on('data', (chunk: Buffer) => {
        const head = chunk.toString().slice(0, 32)
        resolve(head.startsWith('HTTP/1.1 101') ? 'ok' : 'rejected')
        socket.destroy()
      })
      socket.on('error', () => resolve('rejected'))
      socket.on('close', () => resolve('rejected'))
      setTimeout(() => {
        socket.destroy()
        resolve('timeout')
      }, 2000)
    })
    expect(outcome).toBe('rejected')
  })

  test('a disallowed Origin is rejected before the handshake completes', async () => {
    // bun's ws client never sends an Origin header (non-browser), so probe with
    // a raw TCP upgrade carrying a full WS handshake + evil Origin. The server
    // must tear the socket down (no 101) rather than complete the upgrade.
    const { createConnection } = await import('net')
    const { randomBytes } = await import('crypto')
    const key = randomBytes(16).toString('base64')
    const outcome = await new Promise<'ok' | 'rejected' | 'timeout'>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: server.port }, () => {
        socket.write(
          `GET /?token=${server.token} HTTP/1.1\r\n` +
            'Host: 127.0.0.1\r\n' +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n' +
            'Origin: https://evil.example\r\n' +
            '\r\n',
        )
      })
      socket.on('data', (chunk: Buffer) => {
        const head = chunk.toString().slice(0, 32)
        resolve(head.startsWith('HTTP/1.1 101') ? 'ok' : 'rejected')
        socket.destroy()
      })
      socket.on('error', () => resolve('rejected'))
      socket.on('close', () => resolve('rejected'))
      setTimeout(() => {
        socket.destroy()
        resolve('timeout')
      }, 2000)
    })
    expect(outcome).toBe('rejected')
  })
})

describe('request envelope routing', () => {
  test('listProjects round-trips over WS', async () => {
    const ws = await openWs(wsUrl())
    const res = await roundTrip(ws, 1, 'listProjects', [])
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.result)).toBe(true)
    ws.close()
  })

  test('unknown channels are rejected at the envelope layer', async () => {
    const ws = await openWs(wsUrl())
    const res = await roundTrip(ws, 2, 'nonsense', [])
    expect(res.ok).toBe(false)
    // isHostChannel() gates the WS envelope before dispatch → invalid envelope.
    if (!res.ok) expect(res.error).toContain('Invalid request envelope')
    ws.close()
  })

  test('a malformed envelope is answered with an error frame', async () => {
    const ws = await openWs(wsUrl())
    const reply = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5000)
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.id === 99) {
          clearTimeout(timer)
          resolve(msg)
        }
      })
      ws.send(JSON.stringify({ id: 99, channel: 42, args: 'not-an-array' }))
    })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error).toContain('Invalid request envelope')
    ws.close()
  })

  test('getTaskView for an unknown task reports exists:false (envelope preserved)', async () => {
    const ws = await openWs(wsUrl())
    const res = await roundTrip(ws, 3, 'getTaskView', ['missing-task-xyz'])
    expect(res.ok).toBe(true)
    // dispatch() passes handler envelopes ({ ok, ...fields }) through untouched,
    // so the WS transport wraps the whole envelope under `result` (mirroring
    // the Electron host-bridge unwrap: bare → result, envelope → fields on the
    // envelope). The renderer branches on `.ok`/`.exists` either way.
    const view = res.result as { ok?: boolean; exists?: boolean }
    expect(view.ok).toBe(true)
    expect(view.exists).toBe(false)
    ws.close()
  })
})

describe('event broadcast', () => {
  test('UiEvents emitted on the bus reach a connected client', async () => {
    const ws = await openWs(wsUrl())
    const seen = new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000)
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.event === 'event') {
          clearTimeout(timer)
          resolve(msg.payload)
        }
      })
      bus.emit({ type: 'run_status', status: 'running', taskId: 'ws-test' })
    })
    const payload = await seen
    expect(payload).toBeTruthy()
    expect((payload as { type?: string }).type).toBe('run_status')
    expect((payload as { taskId?: string }).taskId).toBe('ws-test')
    ws.close()
  })

  test('a run event pushed through the bridge sink reaches connected clients', async () => {
    // This is the exact hop ADR-21/M-A2 must guarantee for a headless/WS host:
    // the run orchestrator sends UiEvents to sinks attached via
    // attachEventSink(); createHost() attaches bridgeEventBus(bus) there, so a
    // sink.send() must land on the bus and reach the WS client. (start-run's
    // sendEvent is private, so we drive the bridge sink directly — the
    // orchestrator only ever calls send()/isAvailable() on it.)
    const ws = await openWs(wsUrl())
    const sink = bridgeEventBus(bus)
    const seen = new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000)
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.event === 'event') {
          clearTimeout(timer)
          resolve(msg.payload)
        }
      })
      // A client is connected → the server's dynamic broadcast subscription is
      // live → the bridge must report availability so interactive prompts fire.
      expect(sink.isAvailable()).toBe(true)
      sink.send({ type: 'stream', text: 'hello from the run bridge', taskId: 'bridge-test' })
    })
    const payload = await seen
    expect(payload).toBeTruthy()
    expect((payload as { text?: string }).text).toBe('hello from the run bridge')
    ws.close()
  })

  test('bridge availability reflects live bus subscribers (headless guard)', async () => {
    // With no client attached the WS server holds no bus subscription, so a
    // bridged sink reports isAvailable() === false — the run must skip
    // interactive approval/ask_user prompts instead of hanging forever.
    const idleBus = createEventBus()
    const idleSink = bridgeEventBus(idleBus)
    expect(idleSink.isAvailable()).toBe(false)

    const unsub = idleBus.subscribe(() => {})
    expect(idleSink.isAvailable()).toBe(true)
    unsub()
    expect(idleSink.isAvailable()).toBe(false)
  })
})
