import './env-shim'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen } from 'electron'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { attachWindow, startRun, abortRun, isRunning, getLastLocalAgents, respondApproval, respondAskUser } from './start-run'
import { createLocalAgent, loadProjectLocalAgents, deleteLocalAgent, readLocalAgentFile, saveLocalAgentFile, type CreateLocalAgentInput } from './agents/local-agents'
import {
  getAppSettings,
  getProviderApiKey,
  saveProviderApiKey,
  updateProviders,
  updateAgentRouting,
  applySettingsToEnv,
  saveCwd,
  listProjects,
  deleteTask,
  renameTask,
  removeProject,
  searchHistory,
  touchProject,
  saveSearchApiKey,
  setWebSearchProvider,
  type ProviderConfig,
  type ReasoningEffort,
  type ApprovalMode,
  type AgentRoute,
  type WebSearchProviderId
} from './settings'
import {
  getOrCreateSession,
  getRunningTaskId,
  getSessionSnapshot,
  isTaskRunning,
  dropSession,
  trimLastTurn
} from './session-store'
import { bundledAgents } from './agents/bundled-agents'
import { listFiles, listDir, readProjectFile, getGitBranch, getGitDiff, gitAcceptFile, gitRevertFile, projectName } from './fs-utils'
import { checkNow, initAutoUpdater, registerUpdaterIpc } from './updater'
import { writeFileSync } from 'fs'

// Handle global uncaught errors gracefully to prevent silent crashes
process.on('uncaughtException', (error) => {
  console.error('[Main process] Uncaught exception:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Main process] Unhandled rejection:', reason)
})

// Packaged builds carry ripgrep via extraResources (<install>/resources/bin/rg.exe);
// point the SDK at it before any tool runs (executables cannot be spawned from inside
// app.asar). Dev mode resolves sdk/dist/vendor relative paths and needs no override.
// Note: ESM imports below are hoisted above this assignment, but that is safe —
// getBundledRgPath() is resolved lazily on first code-search tool call, never at
// module-evaluation time.
if (app.isPackaged) {
  process.env.CODEBUFF_RG_PATH = join(process.resourcesPath, 'bin', 'rg.exe')
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.AnyBuff.desktop')
}

// Smoke-test hook (scripts/smoke-packaged.mjs): point the test instance at a
// throwaway userData dir so it never contends for the real single-instance
// lock or touches the user's session data while the real app is running.
if (process.env.ANYBUFF_SMOKE_USER_DATA) {
  app.setPath('userData', process.env.ANYBUFF_SMOKE_USER_DATA)
}

// Single instance lock to prevent duplicate concurrent processes
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0) {
      const win = windows[0]
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

function windowStateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): { x?: number; y?: number; width: number; height: number; maximized?: boolean } {
  const fallback = { width: 1280, height: 820 }
  try {
    const raw = readFileSync(windowStateFile(), 'utf-8')
    const parsed = JSON.parse(raw) as { x?: number; y?: number; width?: number; height?: number; maximized?: boolean }
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return fallback

    const displays = screen.getAllDisplays()
    let maxWorkAreaWidth = 1280
    let maxWorkAreaHeight = 820
    for (const d of displays) {
      if (d.workArea.width > maxWorkAreaWidth) maxWorkAreaWidth = d.workArea.width
      if (d.workArea.height > maxWorkAreaHeight) maxWorkAreaHeight = d.workArea.height
    }

    const clampedWidth = Math.max(960, Math.min(parsed.width, maxWorkAreaWidth))
    const clampedHeight = Math.max(640, Math.min(parsed.height, maxWorkAreaHeight))

    // Guard against the window being saved off-screen (e.g. monitor unplugged or resized)
    const visible = displays.some((d) => {
      const b = d.workArea
      return (
        typeof parsed.x === 'number' &&
        typeof parsed.y === 'number' &&
        parsed.x >= b.x - 100 &&
        parsed.x < b.x + b.width - 100 &&
        parsed.y >= b.y &&
        parsed.y < b.y + b.height - 100
      )
    })
    return {
      x: visible ? parsed.x : undefined,
      y: visible ? parsed.y : undefined,
      width: clampedWidth,
      height: clampedHeight,
      maximized: parsed.maximized
    }
  } catch {
    return fallback
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getNormalBounds()
    const state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: win.isMaximized()
    }
    writeFileSync(windowStateFile(), JSON.stringify(state))
  } catch {
    // ignore state save failures
  }
}

function getAppIconPath(): string | undefined {
  const isWin = process.platform === 'win32'
  const candidates = [
    ...(isWin
      ? [
          join(__dirname, '../../resources/icon.ico'),
          join(__dirname, '../../icon.ico'),
          join(app.getAppPath(), 'resources/icon.ico'),
          join(app.getAppPath(), 'icon.ico'),
          join(process.cwd(), 'resources/icon.ico'),
          join(process.cwd(), 'icon.ico')
        ]
      : []),
    join(__dirname, '../../resources/icon.png'),
    join(__dirname, '../../icon.png'),
    join(app.getAppPath(), 'resources/icon.png'),
    join(app.getAppPath(), 'icon.png'),
    join(process.cwd(), 'resources/icon.png'),
    join(process.cwd(), 'icon.png'),
    join(__dirname, '../renderer/icon.png')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return undefined
}

/** Module-level window ref for subsystems that push events to the renderer (updater). */
let activeWindow: BrowserWindow | null = null

function createWindow(): void {
  const saved = loadWindowState()
  const iconPath = getAppIconPath()
  const win = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    title: 'AnyBuff Desktop',
    icon: iconPath,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f6f7f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (saved.maximized) win.maximize()
  win.on('resize', () => saveWindowState(win))
  win.on('move', () => saveWindowState(win))
  win.on('maximize', () => {
    saveWindowState(win)
    win.webContents.send('AnyBuff:windowMaximizeChange', true)
  })
  win.on('unmaximize', () => {
    saveWindowState(win)
    win.webContents.send('AnyBuff:windowMaximizeChange', false)
  })
  win.on('close', () => {
    if (isRunning()) {
      abortRun()
    }
    saveWindowState(win)
  })

  // Open external links securely in the system default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      void import('electron').then(({ shell }) => shell.openExternal(url))
    }
    return { action: 'deny' }
  })

  attachWindow(win)
  activeWindow = win
  win.on('closed', () => {
    if (activeWindow === win) activeWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/* ─── Skills ─────────────────────────────────────────── */

export interface SkillInfo {
  name: string
  description: string
  path: string
  source: 'project' | 'home'
}

const SKILL_ROOTS = ['.agents', '.claude'] as const

function scanSkillRoot(dir: string, source: 'project' | 'home'): SkillInfo[] {
  const out: SkillInfo[] = []
  for (const rootName of SKILL_ROOTS) {
    const skillsDir = join(dir, rootName, 'skills')
    if (!existsSync(skillsDir)) continue
    let entries: string[]
    try {
      entries = (readdirSync(skillsDir, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[])
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const name of entries) {
      const skillFile = join(skillsDir, name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      try {
        const content = readFileSync(skillFile, 'utf-8')
        const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        let description = ''
        if (fm) {
          const descMatch = fm[1].match(/^description:\s*(.+)$/m)
          description = descMatch ? descMatch[1].trim() : ''
        }
        out.push({ name, description, path: skillFile, source })
      } catch {
        // skip unreadable skill
      }
    }
  }
  return out
}

function listSkills(cwd: string): SkillInfo[] {
  const project = scanSkillRoot(cwd, 'project')
  const home = scanSkillRoot(homedir(), 'home')
  return [...project, ...home]
}

/* ─── Updates (About tab) ─────────────────────────────── */
// Version comparison + GitHub release lookup moved to ./updater.ts, which now
// owns both the electron-updater flow and its unpackaged fallback.

function registerIpc(): void {
  /* ─── Window Controls (frameless title bar) ─────── */
  ipcMain.on('AnyBuff:windowMinimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize()
  })
  ipcMain.on('AnyBuff:windowMaximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('AnyBuff:windowClose', () => {
    BrowserWindow.getFocusedWindow()?.close()
  })
  ipcMain.handle('AnyBuff:windowIsMaximized', () => {
    return BrowserWindow.getFocusedWindow()?.isMaximized() ?? false
  })
  ipcMain.on('AnyBuff:windowReload', () => {
    BrowserWindow.getFocusedWindow()?.webContents.reload()
  })
  ipcMain.on('AnyBuff:windowForceReload', () => {
    BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache()
  })
  ipcMain.on('AnyBuff:windowToggleFullScreen', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.setFullScreen(!win.isFullScreen())
  })

  ipcMain.handle('AnyBuff:getState', () => {
    const settings = getAppSettings()
    return {
      cwd: settings.cwd,
      settings,
      running: isRunning(),
      runningTaskId: getRunningTaskId(),
      agentIds: Object.keys(bundledAgents).sort()
    }
  })

  ipcMain.handle('AnyBuff:selectFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select the project folder to edit',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    saveCwd(result.filePaths[0])
    touchProject(result.filePaths[0])
    return result.filePaths[0]
  })

  ipcMain.handle('AnyBuff:selectFiles', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Attach files',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.on('AnyBuff:setTheme', (_e, theme: 'dark' | 'light') => {
    // The native title bar follows nativeTheme for dark/light mode
    nativeTheme.themeSource = theme
  })

  ipcMain.handle('AnyBuff:saveSettings', (_e, payload: {
    providers: ProviderConfig[]
    activeModel: string
    reasoningEffort: ReasoningEffort
    approvalMode: ApprovalMode
    apiKeys?: Record<string, string> // providerId -> key (empty = unchanged; empty string + deleteKey = delete)
    deleteKeys?: string[]
    agentRouting?: Record<string, AgentRoute>
    /** Active web search provider (Web Search settings tab). */
    webSearchProvider?: WebSearchProviderId
    /** Search-provider API keys (tinyfish / firecrawl) → DPAPI storage. */
    searchApiKeys?: Partial<Record<WebSearchProviderId, string>>
    /** Search-provider keys to delete. */
    deleteSearchKeys?: WebSearchProviderId[]
  }) => {
    updateProviders(payload.providers, payload.activeModel, payload.reasoningEffort, payload.approvalMode)
    if (payload.apiKeys) {
      for (const [id, key] of Object.entries(payload.apiKeys)) {
        if (key) saveProviderApiKey(id, key.trim())
      }
    }
    for (const id of payload.deleteKeys ?? []) {
      saveProviderApiKey(id, '')
    }
    if (payload.agentRouting) updateAgentRouting(payload.agentRouting)
    if (payload.webSearchProvider) setWebSearchProvider(payload.webSearchProvider)
    if (payload.searchApiKeys) {
      for (const [provider, key] of Object.entries(payload.searchApiKeys)) {
        if (key && (provider === 'tinyfish' || provider === 'firecrawl')) {
          saveSearchApiKey(provider, key.trim())
        }
      }
    }
    for (const provider of payload.deleteSearchKeys ?? []) {
      if (provider === 'tinyfish' || provider === 'firecrawl') saveSearchApiKey(provider, '')
    }
    return { ok: true, settings: getAppSettings() }
  })

  ipcMain.handle('AnyBuff:listSkills', (_e, cwd: string) => {
    return listSkills(cwd)
  })

  ipcMain.handle('AnyBuff:listLocalAgents', async (_e, cwd: string) => {
    if (!cwd) return getLastLocalAgents()
    try {
      return await loadProjectLocalAgents(cwd)
    } catch (err) {
      return { agents: [], validationErrors: [{ agentId: '', filePath: '', message: err instanceof Error ? err.message : String(err) }] }
    }
  })

  ipcMain.handle('AnyBuff:createLocalAgent', (_e, payload: CreateLocalAgentInput) => {
    return createLocalAgent(payload)
  })

  ipcMain.handle('AnyBuff:deleteLocalAgent', (_e, payload: { cwd: string; filePath?: string; id?: string }) => {
    return deleteLocalAgent(payload)
  })

  ipcMain.handle('AnyBuff:readLocalAgentFile', (_e, payload: { filePath: string }) => {
    return readLocalAgentFile(payload)
  })

  ipcMain.handle('AnyBuff:saveLocalAgentFile', (_e, payload: { filePath: string; content: string }) => {
    return saveLocalAgentFile(payload)
  })

  ipcMain.handle('AnyBuff:readSkillFile', (_e, path: string) => {
    try {
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > 200 * 1024) return { ok: false, error: 'Not a file or larger than 200KB' }
      return { ok: true, content: readFileSync(path, 'utf-8') }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('AnyBuff:listProjects', () => {
    return listProjects()
  })

  ipcMain.handle('AnyBuff:deleteTask', (_e, taskId: string) => {
    if (!taskId) return { ok: false, error: 'Missing taskId' }
    if (isTaskRunning(taskId)) return { ok: false, error: 'Stop the running task before deleting it.' }
    dropSession(taskId)
    deleteTask(taskId)
    return { ok: true }
  })

  ipcMain.handle('AnyBuff:renameTask', (_e, payload: { taskId: string; newPrompt: string }) => {
    if (!payload || typeof payload.taskId !== 'string' || typeof payload.newPrompt !== 'string') {
      return { ok: false, error: 'Invalid payload' }
    }
    const ok = renameTask(payload.taskId, payload.newPrompt)
    return { ok }
  })

  ipcMain.handle('AnyBuff:removeProject', (_e, projectPath: string) => {
    if (!projectPath) return { ok: false, error: 'Missing projectPath' }
    const project = getAppSettings().projects.find((p) => p.path === projectPath)
    const runningInside = (project?.tasks ?? []).some((t) => isTaskRunning(t.id))
    if (runningInside) {
      return { ok: false, error: 'Stop the running task before removing this project.' }
    }
    for (const t of project?.tasks ?? []) {
      dropSession(t.id)
    }
    const ok = removeProject(projectPath)
    return { ok }
  })

  /** Full view snapshot of a conversation: transcript + status + resume info. */
  ipcMain.handle('AnyBuff:getTaskView', (_e, taskId: string) => {
    if (!taskId) return { ok: false, error: 'Missing taskId' }
    const snapshot = getSessionSnapshot(taskId)
    return { ok: true, ...snapshot }
  })

  /**
   * Revert support: drop the last user turn (and everything after it) from the
   * persisted transcript AND the SDK run state, keeping earlier context.
   */
  ipcMain.handle('AnyBuff:trimTaskLastTurn', (_e, payload: { taskId: string; userText: string }) => {
    if (!payload?.taskId || !payload.userText) return { ok: false, error: 'Invalid payload' }
    if (isTaskRunning(payload.taskId)) return { ok: false, error: 'Stop the running task first.' }
    const ok = trimLastTurn(payload.taskId, payload.userText)
    return ok ? { ok: true } : { ok: false, error: 'Original turn not found in this conversation.' }
  })

  ipcMain.handle('AnyBuff:searchHistory', async (_e, query: string) => {
    return await searchHistory(query)
  })

  ipcMain.handle(
    'AnyBuff:runPrompt',
    async (_e, payload: {
      cwd: string
      prompt: string
      displayText?: string
      /** Existing conversation to continue; omitted = start a new one. */
      taskId?: string
      resume?: boolean
      /** UI agent mode — selects the bundled root agent. */
      mode?: 'default' | 'plan'
    }) => {
      if (!payload.cwd || !payload.prompt.trim()) return { ok: false, error: 'Missing project folder or prompt' }
      if (isRunning()) return { ok: false, error: 'Another task is already running' }

      // One record per conversation: reuse the provided task or create a new one.
      // The record title comes from what the user typed (not the expanded prompt).
      const title = (payload.displayText ?? payload.prompt).trim().slice(0, 300)
      let taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : undefined
      const entry = getOrCreateSession(payload.cwd, title, taskId)
      taskId = entry.taskId

      applySettingsToEnv()
      return await startRun({
        cwd: payload.cwd,
        prompt: payload.prompt,
        displayText: payload.displayText ?? payload.prompt,
        taskId,
        resume: payload.resume === true,
        mode: payload.mode
      })
    }
  )

  ipcMain.handle('AnyBuff:abort', () => {
    abortRun()
    return { ok: true }
  })

  ipcMain.handle('AnyBuff:approvalResponse', (_e, approved: boolean) => {
    respondApproval(approved)
    return { ok: true }
  })

  ipcMain.handle('AnyBuff:listFiles', (_e, root: string) => {
    return listFiles(root)
  })

  ipcMain.handle('AnyBuff:listDir', (_e, dir: string) => {
    return listDir(dir)
  })

  ipcMain.handle('AnyBuff:gitAccept', async (_e, payload: { cwd: string; file: string }) => {
    return gitAcceptFile(payload.cwd, payload.file)
  })

  ipcMain.handle('AnyBuff:gitRevert', async (_e, payload: { cwd: string; file: string }) => {
    return gitRevertFile(payload.cwd, payload.file)
  })

  ipcMain.handle('AnyBuff:readFile', (_e, path: string) => {
    return readProjectFile(path)
  })

  ipcMain.handle('AnyBuff:pathInfo', (_e, path: string) => {
    try {
      const stat = statSync(path)
      return { ok: true, isDir: stat.isDirectory(), name: basename(path) }
    } catch {
      return { ok: false, error: 'Path does not exist' }
    }
  })

  ipcMain.handle('AnyBuff:gitBranch', (_e, cwd: string) => {
    return getGitBranch(cwd)
  })

  ipcMain.handle('AnyBuff:gitDiff', (_e, cwd: string) => {
    return getGitDiff(cwd)
  })

  ipcMain.handle('AnyBuff:projectName', (_e, cwd: string) => {
    return projectName(cwd)
  })

  ipcMain.handle('AnyBuff:respondAskUser', (_e, payload: unknown) => {
    respondAskUser(payload)
  })

  ipcMain.handle('AnyBuff:fetchModels', async (_e, payload: { baseURL: string; apiKey: string; providerType: string; providerId?: string }) => {
    try {
      const base = payload.baseURL.replace(/\/+$/, '')
      // Stored DPAPI keys are never echoed back to the renderer, so an empty
      // payload.apiKey after reopening Settings must fall back to the
      // persisted key — otherwise every re-fetch goes out unauthenticated.
      const apiKey = payload.apiKey || (payload.providerId ? getProviderApiKey(payload.providerId) : undefined)
      // Ollama-compatible endpoint (/api/tags)
      if (/ollama|:11434/i.test(base)) {
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(15000) })
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
        const data = (await res.json()) as { models?: { name?: string }[] }
        const models = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean).sort()
        if (models.length === 0) return { ok: false, error: 'No model data in response' }
        return { ok: true, models }
      }
      // OpenAI-compatible /models
      const res = await fetch(`${base}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` }
      const data = (await res.json()) as { data?: { id?: string }[] }
      // Gemini-style endpoints list ids with a "models/" prefix; strip it so
      // stored ids match what /chat/completions expects and selectors render
      // clean names.
      const models = [...new Set((data.data ?? []).map((m) => (m.id ?? '').replace(/^models\//, '')).filter(Boolean).sort())]
      if (models.length === 0) return { ok: false, error: 'No model data in response' }
      return { ok: true, models }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('AnyBuff:getAppVersion', () => {
    return { version: app.getVersion() }
  })

  ipcMain.handle('AnyBuff:checkForUpdates', async () => {
    // Single entry point: packaged installs go through electron-updater,
    // dev/unpackaged runs fall back to the plain GitHub API version check
    // (both live in ./updater so the logic cannot drift apart).
    return checkNow()
  })
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.AnyBuff.desktop')
  }
  registerIpc()
  createWindow()
  // #3 自動更新：IPC handlers always exist（dev 走 GitHub API fallback）；
  // 背景 GitHub Releases 檢查（~20s 後首次，之後每 4 小時）僅在打包版啟用。
  registerUpdaterIpc()
  initAutoUpdater(() => activeWindow)


  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (isRunning()) {
    abortRun()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
