/**
 * Auto-update via electron-updater (#3 第一批：自動更新).
 *
 * - Provider: GitHub Releases (JasonMMIV/Anybuff) — electron-builder emits
 *   `latest.yml` + `.blockmap` alongside the NSIS installer; all three files
 *   must be attached to the release for updates to be discovered.
 * - Background: a silent check ~20s after launch, then every 4 hours.
 * - Download happens automatically once an update is found (differential
 *   blockmap download keeps it small); installation is user-triggered from
 *   the About page ("Restart & Install") or applied on app quit.
 * - Dev / unpackaged runs are a no-op: electron-updater requires an installed
 *   app; the About page falls back to the plain GitHub API version check in
 *   that case (kept in index.ts).
 */
import { app, ipcMain, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

/** Update lifecycle events forwarded to the renderer over `AnyBuff:updateEvent`. */
export interface UpdateUiEvent {
  type:
    | 'checking-for-update'
    | 'update-available'
    | 'update-not-available'
    | 'download-progress'
    | 'update-downloaded'
    | 'update-error'
  /** New version tag, when known. */
  version?: string
  /** Download progress percentage (0-100). */
  percent?: number
  message?: string
}

export interface UpdateCheckResult {
  ok: boolean
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string
  url?: string
  error?: string
}

const GITHUB_RELEASES_PAGE = 'https://github.com/JasonMMIV/Anybuff/releases/latest'
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/JasonMMIV/Anybuff/releases/latest'
const BACKGROUND_CHECK_DELAY_MS = 20_000
const BACKGROUND_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let initialized = false
let ipcRegistered = false

/** Manual check entry point (also backs the legacy `AnyBuff:checkForUpdates` IPC).
 *  Dev / unpackaged runs fall back to the plain GitHub releases API because
 *  electron-updater requires an installed app to talk to. */
export async function checkNow(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) return devGithubCheck()
  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version ?? ''
    return {
      ok: true,
      updateAvailable: Boolean(version && version !== app.getVersion()),
      currentVersion: app.getVersion(),
      latestVersion: version,
      url: GITHUB_RELEASES_PAGE
    }
  } catch (e) {
    return {
      ok: false,
      updateAvailable: false,
      currentVersion: app.getVersion(),
      latestVersion: '',
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/** Unpackaged fallback: compare app version against the latest GitHub release. */
async function devGithubCheck(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  try {
    const res = await fetch(GITHUB_RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AnyBuff-Desktop' },
      signal: AbortSignal.timeout(15000)
    })
    if (res.status === 404) {
      // Repository reachable but no published releases yet.
      return { ok: true, updateAvailable: false, currentVersion, latestVersion: '', url: GITHUB_RELEASES_PAGE }
    }
    if (!res.ok) return { ok: false, updateAvailable: false, currentVersion, latestVersion: '', error: `HTTP ${res.status} ${res.statusText}` }
    const data = (await res.json()) as { tag_name?: string; html_url?: string }
    const tagName = (data.tag_name ?? '').trim()
    if (!tagName) return { ok: false, updateAvailable: false, currentVersion, latestVersion: '', error: 'Malformed response from GitHub releases API' }
    const releaseUrl =
      data.html_url && /^https:\/\/github\.com\//.test(data.html_url) ? data.html_url : GITHUB_RELEASES_PAGE
    return {
      ok: true,
      updateAvailable: compareVersions(tagName, currentVersion) > 0,
      currentVersion,
      latestVersion: tagName.replace(/^v/i, ''),
      url: releaseUrl
    }
  } catch (e) {
    return { ok: false, updateAvailable: false, currentVersion, latestVersion: '', error: e instanceof Error ? e.message : String(e) }
  }
}

/** Returns > 0 when a > b (numeric major.minor.patch comparison, "v" prefix tolerated). */
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

function pushEvent(win: BrowserWindow | null, event: UpdateUiEvent): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('AnyBuff:updateEvent', event)
}

/**
 * Configure autoUpdater and start background checking (packaged builds only).
 * Call once at app startup from the main process. No-op when not packaged —
 * use registerUpdaterIpc() for the always-available IPC surface.
 */
export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged || initialized) return
  initialized = true

  autoUpdater.autoDownload = true
  // If the user closes the app before clicking "Restart & Install", the
  // pending update still lands on next quit — never nag, just apply.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => pushEvent(getWindow(), { type: 'checking-for-update' }))
  autoUpdater.on('update-available', (info) => pushEvent(getWindow(), { type: 'update-available', version: info.version ?? undefined }))
  autoUpdater.on('update-not-available', (info) =>
    pushEvent(getWindow(), { type: 'update-not-available', version: info.version ?? undefined })
  )
  autoUpdater.on('download-progress', (progress) => pushEvent(getWindow(), { type: 'download-progress', percent: progress.percent }))
  autoUpdater.on('update-downloaded', () => pushEvent(getWindow(), { type: 'update-downloaded' }))
  autoUpdater.on('error', (error) => pushEvent(getWindow(), { type: 'update-error', message: error?.message ?? String(error) }))

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {
      /* background checks are best-effort; failures surface as update-error */
    })
  }
  setTimeout(check, BACKGROUND_CHECK_DELAY_MS)
  setInterval(check, BACKGROUND_CHECK_INTERVAL_MS)
}

/**
 * Register the updater IPC handlers. Safe to call unconditionally at startup:
 * in dev/unpackaged runs `updateCheck` falls back to the plain GitHub API
 * comparison instead of electron-updater (which needs an installed app).
 */
export function registerUpdaterIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true
  ipcMain.handle('AnyBuff:updateCheck', () => checkNow())

  ipcMain.handle('AnyBuff:updateDownload', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('AnyBuff:updateInstall', () => {
    if (!autoUpdater.isUpdaterActive()) {
      return { ok: false, error: 'Updater is not active in this environment.' }
    }
    // Detach before-quit/window-all-closed handlers that would abortRun and
    // race with the NSIS silent-install handoff.
    setImmediate(() => {
      app.removeAllListeners('window-all-closed')
      autoUpdater.quitAndInstall()
    })
    return { ok: true }
  })
}
