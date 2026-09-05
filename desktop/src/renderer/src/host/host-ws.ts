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

/**
 * Result shape of the desktop updater's check (AnyBuff:checkForUpdates /
 * updateCheck IPC). Kept structurally compatible with the Electron type so the
 * Settings About tab renders identically over WS.
 */
export interface UpdateCheckResult {
  ok: boolean
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string
  url?: string
  error?: string
}

export interface UpdateUiEvent {
  type:
    | 'checking-for-update'
    | 'update-available'
    | 'update-not-available'
    | 'download-progress'
    | 'update-downloaded'
    | 'update-error'
  version?: string
  percent?: number
  message?: string
}

/**
 * Optional native bridge injected by the shell (Phase-B Android WebView).
 * WebView JS cannot open SAF pickers or launch external browsers by itself, so
 * the shell registers a message-channel proxy here; when absent the methods
 * degrade to the browser-safe fallbacks below.
 */
export interface AnyBuffNativeBridge {
  /** Open the system folder/file picker; resolve the sandbox paths. */
  pickFolder?(): Promise<string | null>
  pickFiles?(): Promise<string[]>
  /** Open an external URL in the system browser (Android: ACTION_VIEW). */
  openExternal?(url: string): void
  /** Android-only app version (from BuildConfig). */
  getVersion?(): Promise<string>
  /** Android-only: stop + restart the local engine host (WS dead recovery). */
  restartEngine?(): void
  /** Android-only: tail of the on-device engine diagnostics log. */
  readEngineLog?: () => Promise<string>
  /** Android-only: append a renderer lifecycle event to the engine log. */
  logEvent?: (kind: string, detail: string) => void
}

export interface WsHostOptions {
  /** WS URL with token, e.g. ws://127.0.0.1:8765?token=abc */
  url: string
  /** Timeout for a request before rejecting (ms). Default 30s. */
  timeoutMs?: number
  /** Installed app version reported by getAppVersion (default '0.0.0-ws'). */
  appVersion?: string
  /** Optional native bridge (Android shell / Electron preload absent). */
  native?: AnyBuffNativeBridge
  /** GitHub repo for the update check, e.g. 'JasonMMIV/Anybuff'. Default unset → update UI disabled. */
  updateRepo?: string
}

const GITHUB_RELEASES_PAGE_PREFIX = 'https://github.com/'

/** Returns > 0 when a > b (numeric major.minor.patch, "v" prefix tolerated). */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Compare the running version against the latest GitHub release (dev/unpackaged parity). */
async function githubUpdateCheck(repo: string, currentVersion: string): Promise<UpdateCheckResult> {
  const latestUrl = `${GITHUB_RELEASES_PAGE_PREFIX}${repo}/releases/latest`
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AnyBuff' },
      signal: AbortSignal.timeout(15000),
    })
    if (res.status === 404) return { ok: true, updateAvailable: false, currentVersion, latestVersion: '', url: latestUrl }
    if (!res.ok) return { ok: false, updateAvailable: false, currentVersion, latestVersion: '', error: `HTTP ${res.status}` }
    const data = (await res.json()) as { tag_name?: string; html_url?: string }
    const tagName = (data.tag_name ?? '').trim()
    if (!tagName) return { ok: false, updateAvailable: false, currentVersion, latestVersion: '', error: 'Malformed response from GitHub releases API' }
    return {
      ok: true,
      updateAvailable: compareVersions(tagName, currentVersion) > 0,
      currentVersion,
      latestVersion: tagName.replace(/^v/i, ''),
      url: data.html_url && /^https:\/\/github\.com\//.test(data.html_url) ? data.html_url : latestUrl,
    }
  } catch (e) {
    return { ok: false, updateAvailable: false, currentVersion, latestVersion: '', error: e instanceof Error ? e.message : String(e) }
  }
}

export function createWsAnyBuff(options: WsHostOptions): AnyBuffApi {
  const { url, timeoutMs = 30_000, appVersion = '0.0.0-ws', native, updateRepo } = options

  let seq = 0
  const pending = new Map<number, (v: unknown) => void>()
  const eventListeners = new Set<(event: unknown) => void>()
  const updateListeners = new Set<(event: UpdateUiEvent) => void>()

  /** The host died or the socket broke: fail every in-flight request NOW
   * (instead of letting each wait out its 30s timeout) and tell the UI, which
   * surfaces a restart affordance. Without this the renderer silently freezes
   * on a dead engine — every call resolves a timeout envelope and no events
   * ever arrive again. */
  function failPending(reason: string): void {
    for (const [id, resolve] of [...pending]) {
      pending.delete(id)
      resolve({ ok: false, error: reason })
    }
  }

  // ── Reconnect loop ─────────────────────────────────────────────────────
  // A single socket would leave the page permanently dead after one close:
  // onclose fired, the UI shows the lost-connection overlay, and nothing ever
  // re-establishes the socket — the only escape was a full page reload (and on
  // Android, a shell-driven reboot + reload). The socket can also die while
  // the ENGINE is perfectly alive (OS network teardown, a transient loopback
  // hiccup); in that case the engine never reboots and only reconnecting
  // helps. So: keep trying the same URL with backoff, and tell the UI both
  // ways — 'anybuff:host-disconnected' when the socket drops (restart
  // affordance), 'anybuff:host-reconnected' when it comes back (overlay
  // auto-dismisses, no reload needed). The shell's own recovery (Android
  // reboot + reload with a FRESH URL) simply replaces this page, killing the
  // loop with it — no conflict.
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelayMs = 1000

  // ── Liveness watchdog + engine auto-restart ────────────────────────
  // Two failure modes need different cures:
  //   1. Socket-only break (engine alive): reconnect loop fixes it — no
  //      reload, no reboot, overlay auto-dismisses on 'host-reconnected'.
  //   2. Engine process dead: reconnecting to the SAME URL can never
  //      succeed — the proot host is gone, its port+token are invalid. The
  //      page used to sit on the overlay forever; now, after several
  //      consecutive failed upgrades, we drive the native restart bridge
  //      ourselves (Kotlin tears the sandbox down, boots a fresh host,
  //      and reloads this page with a FRESH URL — the only real fix).
  // A reload alone can't help either: location.reload() re-reads the STALE
  // __ANYBUFF_WS_URL__ of the dead host. That is exactly why "reload page
  // 沒多久又 Engine connection lost" — the reload reconnected to a dead
  // engine and the overlay came right back. Only a fresh boot publishes a
  // new URL.
  const MAX_DEAD_UPGRADES = 3
  let failedUpgrades = 0
  let restartRequested = false
  let lastMessageAt = Date.now()
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  /** Whether the CURRENT socket ever reached open (reset in connect()). */
  let socketEverOpened = false

  /** On-device engine log (Android only; no-op elsewhere) — the app's Engine
   * diagnostics tab shows these entries so a tester without adb can see WHY
   * the connection drops. */
  const logEvent = (kind: string, detail: string): void => {
    try {
      native?.logEvent?.(kind, detail)
    } catch {
      // Logging must never break the transport.
    }
  }

  /** Half-dead socket detector: nothing (not even a pong or broadcast) for
   * 45s while the socket claims to be open → treat it as dead. The
   * server-side heartbeat (ping every 30s) normally surfaces a dead socket
   * as a clean 'close' long before this; this is the belt to the suspenders.
   */
  function startWatchdog(): void {
    if (watchdogTimer != null) return
    watchdogTimer = setInterval(() => {
      if (ws == null || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastMessageAt < 45_000) return
      // Force the socket through close → the reconnect loop takes over.
      try { ws.close() } catch {}
    }, 15_000)
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
  }

  function requestEngineRestart(reason: string): void {
    if (restartRequested) return
    restartRequested = true
    const native = (typeof window !== 'undefined'
      ? (window as unknown as { __ANYBUFF_NATIVE__?: AnyBuffNativeBridge }).__ANYBUFF_NATIVE__
      : undefined)
    if (native?.restartEngine) {
      console.warn(`[host-ws] engine appears dead (${reason}) — requesting native restart`)
      logEvent('engine', `auto-restart requested: ${reason}`)
      try { native.restartEngine() } catch {}
      // Keep the reconnect loop running: if the reboot lands while this page
      // is still alive, the fresh URL re-injection reloads us anyway.
      setTimeout(() => { restartRequested = false }, 20_000)
    }
    // No native bridge (browser preview): the overlay's Restart button is
    // the manual path; the reconnect loop keeps trying the same URL.
  }

  function connect(): void {
    socketEverOpened = false
    const socket = new WebSocket(url)
    ws = socket

    socket.onopen = () => {
      if (socket !== ws) return // superseded by a newer attempt
      reconnectDelayMs = 1000
      failedUpgrades = 0
      socketEverOpened = true
      lastMessageAt = Date.now()
      startWatchdog()
      logEvent('ws', 'connected')
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('anybuff:host-reconnected'))
      }
    }

    socket.onerror = () => {
      // onclose follows; fail-fast there so the page can offer recovery.
    }

    socket.onclose = () => {
      if (socket !== ws) return // superseded by a newer attempt
      logEvent('ws', `closed (failedUpgrades=${failedUpgrades}, everOpened=${socketEverOpened})`)
      failPending('Host connection lost')
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('anybuff:host-disconnected'))
      }
      // The upgrade was REJECTED (engine down / stale token) rather than
      // dropped mid-session? A handshake that never completes goes
      // error → close without ever opening. Count consecutive never-opened
      // failures — that signature means the engine is gone, not the socket.
      if (!socketEverOpened) failedUpgrades++
      if (failedUpgrades >= MAX_DEAD_UPGRADES) {
        requestEngineRestart('multiple failed connections')
      }
      // Schedule the next attempt (only once per close; the timer itself
      // re-arms via connect()).
      if (reconnectTimer == null) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000)
          connect()
        }, reconnectDelayMs)
      }
    }

    socket.onmessage = (raw: MessageEvent) => {
      lastMessageAt = Date.now()
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
  }

  connect()

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
      const socket = ws
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        // Socket down (reconnecting): fail fast instead of throwing
        // InvalidStateError from send() on a closed socket. The overlay is up
        // and the reconnect loop owns recovery; the caller gets an error
        // envelope like any other failed call.
        pending.delete(id)
        clearTimeout(timer)
        resolve({ ok: false, error: 'Host connection lost' } as T)
        return
      }
      socket.send(JSON.stringify({ id, channel, args }))
    })
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
    saveCwd: (cwd: string) => call('saveCwd', cwd),
    touchProject: (cwd: string) => call('touchProject', cwd),
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
    getAppVersion: async () => ({ version: native?.getVersion ? await native.getVersion() : appVersion }),
    checkForUpdates: async () => (updateRepo ? githubUpdateCheck(updateRepo, appVersion) : { status: 'disabled' }),
    updateCheck: async () => (updateRepo ? githubUpdateCheck(updateRepo, appVersion) : { status: 'disabled' }),
    updateDownload: async () => ({ status: 'disabled' }),
    updateInstall: shellNoOps,
    onUpdateEvent: (callback: (event: UpdateUiEvent) => void) => {
      updateListeners.add(callback)
      return () => updateListeners.delete(callback)
    },
    selectFolder: async () => {
      if (!native?.pickFolder) return null
      const path = await native.pickFolder()
      // Parity with the desktop shell's selectFolder IPC handler, which
      // persists the picked folder (saveCwd + touchProject) so a page reload
      // restores the open project. Android must do the same or every reload
      // (renderer crash recovery, activity recreation, process restart) lands
      // back on the "select a project folder" welcome screen. Best-effort: a
      // dead/connecting socket must never swallow a successful pick — the UI
      // applies the returned path either way.
      if (path) {
        try {
          await call('saveCwd', path)
          await call('touchProject', path)
        } catch {
          // Host unreachable; the folder is still copied on the device and the
          // in-session cwd below still applies until the next reload.
        }
      }
      return path
    },
    selectFiles: async () => (native?.pickFiles ? await native.pickFiles() : []),
    getPathForFile: (_file: File) => '',
    setTheme: shellNoOps,
    getZoomFactor: () => 1,
    setZoomFactor: shellNoOps,
    /** Android-only: on-device engine diagnostics log (null elsewhere). */
    readEngineLog: async (): Promise<string | null> =>
      native?.readEngineLog ? await native.readEngineLog() : null,
  }

  return api as unknown as AnyBuffApi
}
