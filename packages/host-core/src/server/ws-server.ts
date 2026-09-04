/**
 * WebSocket host server (M-A2) — lets a headless shell (Phase-B Android
 * proot Node, or the browser-preview dev flow) drive the same host-core
 * business logic the Electron desktop uses.
 *
 * Security model (mirrors the localhost-only posture of the desktop app):
 *   - Binds to loopback only (127.0.0.1) by default.
 *   - Requires a bearer token on every connection (`ws://host?token=…`); the
 *     shell generates a random token per boot and hands it to the WebView over
 *     a private channel, never over the public network.
 *   - Validates the Origin header against an allowlist (default: the Android
 *     WebView's `https://localhost` and the dev/preview origins).
 *
 * Protocol: JSON text frames.
 *   Client → host: { id, channel, args }            (request)
 *   Host → client: { id, ok, result | error }       (response)
 *   Host → client: { event: 'event', payload }      (pushed UiEvent broadcast)
 *
 * Events are broadcast to every connected client so a future multi-surface
 * Android shell (chat WebView + settings WebView) gets all updates.
 */

import { WebSocketServer, type WebSocket } from 'ws'
import { createServer, type Server as HttpServer } from 'http'
import { randomBytes } from 'crypto'
import { isHostChannel, type HostChannel, type WsRequest, type WsResponse } from '../channels/channels'
import type { Host } from '../channels/dispatcher'
import type { EventBus } from '../events'

export interface WsHostOptions {
  host: Host
  eventBus?: EventBus
  /** Loopback port to bind. */
  port?: number
  /** Bearer token required on every connection. Default: random per boot. */
  token?: string
  /** Allowed Origin headers (no Origin = non-browser client, allowed when tokenOk). */
  allowedOrigins?: string[]
  /** Bind host. Defaults to 127.0.0.1 (loopback only). */
  bindAddress?: string
}

export interface WsHost {
  port: number
  token: string
  close(): Promise<void>
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Send a JSON frame, swallowing per-socket failures. */
function sendJson(ws: WebSocket, obj: WsResponse | { event: 'event'; payload: unknown }): void {
  if (ws.readyState !== ws.OPEN) return
  try {
    ws.send(JSON.stringify(obj))
  } catch {
    // socket gone mid-send; ignore
  }
}

/**
 * Start the WebSocket host. Resolves once the server is listening.
 * Caller must installHostEnv() first and createHost() before starting.
 */
export function startWsHost(options: WsHostOptions): Promise<WsHost> {
  const {
    host,
    eventBus,
    port = 0,
    token = randomBytes(32).toString('hex'),
    allowedOrigins,
    bindAddress = '127.0.0.1',
  } = options

  const httpServer: HttpServer = createServer()
  const wss = new WebSocketServer({ noServer: true })

  // Reject upgrade unless Origin is allowed AND token is present.
  // A rejected upgrade tears the socket down — every WS client (browser,
  // node ws, bun ws) observes this as a failed handshake (error, no open).
  // We log the reason for shell-side debugging; no HTTP body is attempted on
  // the raw upgrade socket (flaky under bun's http stack).
  httpServer.on('upgrade', (req, socket, head) => {
    const reject = (reason: string): void => {
      console.warn(`[host-core] WS upgrade rejected: ${reason}`)
      socket.destroy()
    }
    const origin = req.headers.origin
    if (origin && allowedOrigins && !allowedOrigins.includes(origin)) {
      reject(`origin ${origin} not allowed`)
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const got = url.searchParams.get('token')
    if (got !== token) {
      reject('bad or missing token')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    refreshBroadcast()
    ws.on('close', () => refreshBroadcast())
    ws.on('message', (raw) => {
      let msg: unknown
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        sendJson(ws, { id: -1, ok: false, error: 'Malformed JSON' })
        return
      }
      const req = msg as Partial<WsRequest>
      if (
        typeof req.id !== 'number' ||
        typeof req.channel !== 'string' ||
        !isHostChannel(req.channel) ||
        !Array.isArray(req.args)
      ) {
        sendJson(ws, { id: typeof req.id === 'number' ? req.id : -1, ok: false, error: 'Invalid request envelope' })
        return
      }
      void host
        .dispatch(req.channel as HostChannel, req.args as unknown[])
        .then((result) => {
          const resp: WsResponse = { id: req.id as number, ok: result.ok }
          if (result.ok) {
            // dispatch() contract: handlers that return a bare value come back
            // wrapped as { ok: true, result }; handlers that already return an
            // envelope ({ ok, ...fields }) pass through untouched. Mirror the
            // Electron host-bridge unwrap so WS clients receive the exact
            // shapes the renderer has always seen over IPC:
            //   bare      → result: <bare value>
            //   envelope  → result: <the full envelope, ok included>
            const { ok, result: inner, ...rest } = result as { ok: true } & Record<string, unknown>
            if (inner !== undefined) resp.result = inner
            else resp.result = { ok: true, ...rest }
          } else {
            resp.error = result.error
          }
          sendJson(ws, resp)
        })
        .catch((error: unknown) => {
          sendJson(ws, {
            id: req.id as number,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    })
  })

  // Broadcast UiEvents to connected clients. The bus subscription is dynamic
  // (present only while ≥1 client is connected) so that an EventBus bridged
  // into the run orchestrator's sinks reports availability exactly when a
  // renderer is attached — a headless WS host with no clients must NOT fire
  // interactive approval/ask_user prompts (the run would hang awaiting an
  // answer that can never arrive).
  let broadcastUnsub: (() => void) | null = null
  function refreshBroadcast(): void {
    const hasClients = wss.clients.size > 0
    if (hasClients && !broadcastUnsub && eventBus) {
      broadcastUnsub = eventBus.subscribe((event) => {
        for (const client of wss.clients) {
          sendJson(client, { event: 'event', payload: event })
        }
      })
    } else if (!hasClients && broadcastUnsub) {
      broadcastUnsub()
      broadcastUnsub = null
    }
  }
  refreshBroadcast()

  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      httpServer.removeListener('error', onError)
      const address = httpServer.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      console.log(`[host-core] WS host listening on ws://${bindAddress}:${actualPort}`)
      resolve({
        port: actualPort,
        token,
        close: () =>
          new Promise<void>((done) => {
            broadcastUnsub?.()
            broadcastUnsub = null
            for (const client of wss.clients) {
              try { client.terminate() } catch {}
            }
            if (typeof (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
              try { (httpServer as unknown as { closeAllConnections: () => void }).closeAllConnections() } catch {}
            }
            const timer = setTimeout(() => done(), 800)
            wss.close(() => {
              httpServer.close(() => {
                clearTimeout(timer)
                done()
              })
            })
          }),
      })
    }
    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(port, bindAddress)
  })
}

/** Origin allowlist used by the desktop/dev + Android WebView shells. */
export function defaultAllowedOrigins(): string[] {
  return ['https://localhost', 'http://localhost', 'http://127.0.0.1']
}
