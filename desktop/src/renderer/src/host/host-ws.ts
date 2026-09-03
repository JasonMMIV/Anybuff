/**
 * WS-backed AnyBuff host (M-A3) — lets the same renderer UI run against a
 * headless @codebuff/host-core over a WebSocket when the Electron preload is
 * absent (browser preview, and Phase-B Android WebView).
 *
 * The renderer only ever talks to `window.AnyBuff`; this module produces an
 * object with the same shape as the Electron preload API (AnyBuffApi). Methods
 * that map onto host-core business channels use the WS request envelope
 * ({ id, channel, args } → { id, ok, result | error }); the onEvent/updater
 * subscriptions consume pushed event frames. Electron-only shell methods
 * (window controls, zoom, file dialogs, updater) degrade to safe no-ops or
 * nulls — the Android shell supplies its own equivalents later (Phase B).
 */

import type { AnyBuffApi } from '../../../preload'

const shellNoOps = (): void => {}

export interface WsHostOptions {
  /** WS URL with token, e.g. ws://127.0.0.1:8765?token=abc */
  url: string
  /** Timeout for a request before rejecting (ms). Default 30s. */
  timeoutMs?: number
}

export function createWsAnyBuff(options: WsHostOptions): AnyBuffApi {
  const { url, timeoutMs = 30_000 } = options
  const ws = new WebSocket(url)

  let seq = 0
  const pending = new Map<number, (v: unknown) => void>()
  const eventListeners = new Set<(event: unknown) => void>()
  const updateListeners = new Set<(event: unknown) => void>()

  /** Invoke a host-core business channel over the WS envelope. */
  function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    const id = ++seq
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        // Transport-level failure (no reply). Resolve an error envelope rather
        // than reject so the UI can render it like any other failed call.
        resolve({ ok: false, error: `WS request timed out: ${channel}` } as T)
      }, timeoutMs)
      pending.set(id, (v) => {
        clearTimeout(timer)
        resolve(v as T)
      })
      ws.send(JSON.stringify({ id, channel, args }))
    })
  }

  ws.onmessage = (raw: MessageEvent) => {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; payload?: unknown }
    try {
      msg = JSON.parse(String(raw.data))
    } catch {
      return
    }
    if (msg.event === 'event') {
      for (const l of [...eventListeners]) l(msg.payload)
      return
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.ok) p(msg.result)
      // Parity with the Electron IPC path: business-channel failures travel as
      // RESOLVED { ok: false, error } objects (dispatch never rejects and the
      // host-bridge returns the envelope), never as thrown exceptions. The
      // renderer branches on `.ok` either way — only a true transport failure
      // (timeout / dead socket) resolves an error envelope.
      else p({ ok: false, error: msg.error ?? 'WS request failed' })
    }
  }

  // Result shape note: the WS host mirrors the Electron host-bridge unwrap —
  // bare-value handlers (listProjects → array) come back under `result`;
  // envelope handlers ({ ok, ...fields } — deleteTask, getTaskView, …) arrive
  // whole with their own ok field. call() resolves `result` for bare values
  // and the full envelope for envelope results; the renderer branches on
  // `.ok`/fields so both transports behave identically.

  const api: Record<string, unknown> = {
    // ── Business channels (WS) ─────────────────────────────────────────
    getState: () => call('getState'),
    saveSettings: (payload: unknown) => call('saveSettings', payload),
    listMcpServers: (cwd: string | null) => call('listMcpServers', cwd),
    saveMcpServer: (payload: unknown) => call('saveMcpServer', payload),
    deleteMcpServer: (payload: { id: string }) => call('deleteMcpServer', payload),
    updateMcpServerSettings: (payload: { cwd: string | null; id: string; enabled?: boolean; targetAgents?: string[] }) =>
      call('updateMcpServerSettings', payload),
    testMcpServer: (payload: { record: unknown }) => call('testMcpServer', payload),
    listSkills: (cwd: string) => call('listSkills', cwd),
    listLocalAgents: (cwd: string) => call('listLocalAgents', cwd),
    createLocalAgent: (payload: unknown) => call('createLocalAgent', payload),
    deleteLocalAgent: (payload: { cwd: string; filePath?: string; id?: string }) => call('deleteLocalAgent', payload),
    readLocalAgentFile: (payload: { filePath: string }) => call('readLocalAgentFile', payload),
    saveLocalAgentFile: (payload: { filePath: string; content: string }) => call('saveLocalAgentFile', payload),
    readSkillFile: (path: string) => call('readSkillFile', path),
    listProjects: () => call('listProjects'),
    deleteTask: (taskId: string) => call('deleteTask', taskId),
    renameTask: (payload: { taskId: string; newPrompt: string }) => call('renameTask', payload),
    removeProject: (projectPath: string) => call('removeProject', projectPath),
    getTaskView: (taskId: string) => call('getTaskView', taskId),
    trimTaskLastTurn: (payload: { taskId: string; userText: string }) => call('trimTaskLastTurn', payload),
    searchHistory: (query: string) => call('searchHistory', query),
    runPrompt: (payload: {
      cwd: string
      prompt: string
      displayText?: string
      taskId?: string
      resume?: boolean
      mode?: 'default' | 'plan' | 'chat'
    }) => call('runPrompt', payload),
    abort: () => call('abort'),
    respondAskUser: (payload: unknown) => call('respondAskUser', payload),
    respondApproval: (approved: boolean) => call('approvalResponse', approved),
    listFiles: (root: string) => call('listFiles', root),
    listDir: (dir: string) => call('listDir', dir),
    readFile: (path: string) => call('readFile', path),
    gitAccept: (payload: { cwd: string; file: string }) => call('gitAccept', payload),
    gitRevert: (payload: { cwd: string; file: string }) => call('gitRevert', payload),
    pathInfo: (path: string) => call('pathInfo', path),
    gitBranch: (cwd: string) => call('gitBranch', cwd),
    gitDiff: (cwd: string) => call('gitDiff', cwd),
    projectName: (cwd: string) => call('projectName', cwd),
    fetchModels: (payload: { baseURL: string; apiKey?: string; providerType?: string; providerId?: string }) =>
      call('fetchModels', payload),

    // ── Events (WS pushed frames) ──────────────────────────────────────
    onEvent: (callback: (event: unknown) => void) => {
      eventListeners.add(callback)
      return () => eventListeners.delete(callback)
    },

    // ── Shell-only: safe no-ops / nulls until Phase B supplies real ones ──
    windowMinimize: shellNoOps,
    windowMaximize: shellNoOps,
    windowClose: shellNoOps,
    windowIsMaximized: async () => false,
    windowReload: shellNoOps,
    windowForceReload: shellNoOps,
    windowToggleFullScreen: shellNoOps,
    onWindowMaximizeChange: (_callback: (maximized: boolean) => void) => {
      // No window state over WS — nothing to subscribe to.
      return () => {}
    },
    getAppVersion: async () => ({ version: '0.0.0-ws' }),
    checkForUpdates: async () => ({ status: 'disabled' }),
    updateCheck: async () => ({ status: 'disabled' }),
    updateDownload: async () => ({ status: 'disabled' }),
    updateInstall: shellNoOps,
    onUpdateEvent: (callback: (event: unknown) => void) => {
      updateListeners.add(callback)
      return () => updateListeners.delete(callback)
    },
    selectFolder: async () => null,
    selectFiles: async () => [],
    getPathForFile: (_file: File) => '',
    setTheme: shellNoOps,
    getZoomFactor: () => 1,
    setZoomFactor: shellNoOps,
  }

  return api as unknown as AnyBuffApi
}
