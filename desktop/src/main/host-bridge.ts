/**
 * Electron → host-core bridge (ADR-21 / M-A4).
 *
 * The Electron shell's only job here is to translate between Electron
 * primitives and the host-core seams:
 *
 *   - HostPaths  ← app.getPath('userData'|'appData') + os.homedir()
 *   - SecretStore ← safeStorage (DPAPI, ADR-11); falls back to an
 *     always-unavailable store so host-core refuses to persist keys rather
 *     than silently storing plaintext.
 *   - EventSink  ← the focused BrowserWindow's webContents (AnyBuff:event)
 *   - Channel dispatch ← ipcMain.handle over the host-core registry
 *
 * All business logic lives in @codebuff/host-core (extracted, Electron-free).
 * This file must stay thin and Electron-only.
 */

import { app, safeStorage, ipcMain, type BrowserWindow } from 'electron'
import { homedir } from 'os'
import {
  installHostEnv,
  createHost,
  createEventBus,
  attachEventSink,
  detachEventSink,
  CHANNELS,
  type Host,
  type UiEvent,
} from '@codebuff/host-core'
import { type EventSink } from '@codebuff/host-core'
import { type EventBus } from '@codebuff/host-core'

let activeSink: EventSink | null = null

/** Adapter that pushes normalized events to a BrowserWindow's webContents. */
function windowSink(win: BrowserWindow): EventSink {
  return {
    send(event: UiEvent) {
      if (!win.isDestroyed()) {
        win.webContents.send('AnyBuff:event', event)
      }
    },
    isAvailable() {
      return !win.isDestroyed()
    },
  }
}

/**
 * Install the host environment + attach the current window's sink. Called once
 * after app.whenReady() (paths are only valid then), and re-called whenever the
 * active window changes. The previous window's sink is detached so a closed
 * window never keeps receiving run events.
 */
export function bindHostToWindow(win: BrowserWindow): void {
  if (activeSink) detachEventSink(activeSink)
  activeSink = windowSink(win)
  attachEventSink(activeSink)
}

/** Wire every host-core business channel onto ipcMain.handle. */
export function registerHostIpc(): { host: Host; bus: EventBus } {
  installHostEnv({
    paths: {
      dataDir: app.getPath('userData'),
      appDataDir: app.getPath('appData'),
      homeDir: homedir(),
    },
    secrets:
      safeStorage.isEncryptionAvailable()
        ? {
            isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
            encryptString: (plain: string) => safeStorage.encryptString(plain),
            decryptString: (encoded: Uint8Array) => safeStorage.decryptString(Buffer.from(encoded)),
          }
        : {
            isEncryptionAvailable: () => false,
            encryptString: () => {
              throw new Error('OS credential encryption (DPAPI) is unavailable')
            },
            decryptString: () => {
              throw new Error('OS credential encryption (DPAPI) is unavailable')
            },
          },
  })

  const bus = createEventBus()
  const host = createHost({ eventBus: bus })

  for (const channel of CHANNELS) {
    ipcMain.handle(`AnyBuff:${channel}`, async (_e, ...args: unknown[]) => {
      const result = await host.dispatch(channel, args)
      // dispatch() contract: handlers that return a bare value (arrays, task
      // snapshots) come back wrapped as { ok: true, result }; handlers that
      // already return an envelope ({ ok, ...fields } — runPrompt, saveMcpServer,
      // getTaskView, …) pass through untouched. Unwrap the former so the
      // renderer sees exactly the shapes it has always received.
      if (result.ok) {
        if ('result' in result) return result.result
        return result
      }
      return { ok: false, error: result.error }
    })
  }

  return { host, bus }
}
