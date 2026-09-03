/**
 * Event sink seam (ADR-21): the run orchestrator and session store push
 * normalized UiEvents here; each shell routes them to the renderer.
 *
 *   - Electron main: webContents.send('AnyBuff:event', …) to the active window.
 *   - Android (Phase B): broadcast over the WebSocket to the WebView host.
 *
 * Because both the desktop session store and the WS server need a subscriber
 * per transport, the channel is a small typed pub/sub with unsubscribe —
 * exactly what the preload's onEvent(callback) → ipcRenderer.on contract needs.
 */

import type { UiEvent } from './contracts/types'

export type EventListener = (event: UiEvent) => void

export interface EventBus {
  /** Push an event to every current subscriber. */
  emit(event: UiEvent): void
  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void
  /** Number of live subscribers (used to decide transport availability). */
  listenerCount(): number
}

/**
 * The run orchestrator's UI output seam (ADR-21). The desktop shell adapts its
 * BrowserWindow (webContents.send) to this; the Android shell routes it over
 * the WebSocket broadcast. `isAvailable()` mirrors the old
 * `mainWindow && !mainWindow.isDestroyed()` guard that gated interactive
 * prompts (approval / ask_user).
 */
export interface EventSink {
  /** Push a normalized UiEvent toward the renderer/transport. */
  send(event: UiEvent): void
  /** Whether an interactive surface is currently attached (false → skip prompts). */
  isAvailable(): boolean
}

/** In-process bus used by the desktop shell (attachWindow wiring) and tests. */
export function createEventBus(): EventBus {
  const listeners = new Set<EventListener>()
  return {
    emit(event: UiEvent) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch (error) {
          // A misbehaving subscriber must never break the run loop.
          console.error('[host-core] event subscriber threw:', error)
        }
      }
    },
    subscribe(listener: EventListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listenerCount() {
      return listeners.size
    },
  }
}

/**
 * Adapt an EventBus into an EventSink so a host can push run UiEvents onto it.
 * createHost() uses this to feed the WS broadcast bus from the run
 * orchestrator's sink (ADR-21). The sink stays attached until the returned
 * unsubscribe is called (host teardown).
 *
 * isAvailable() reflects whether the bus currently has subscribers — a WS host
 * subscribes when it starts listening, so interactive approval/ask_user prompts
 * only fire when a transport is actually attached (headless hosts with no
 * client would otherwise hang the run waiting for an answer that never comes).
 */
export function bridgeEventBus(bus: EventBus): EventSink & { unsubscribe(): void } {
  return {
    send(event: UiEvent) {
      bus.emit(event)
    },
    isAvailable() {
      return bus.listenerCount() > 0
    },
    unsubscribe() {
      // nothing to release — the bus owns its subscribers
    },
  }
}
