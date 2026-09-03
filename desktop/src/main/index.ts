import './env-shim'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { checkNow, initAutoUpdater, registerUpdaterIpc } from './updater'
import { bindHostToWindow, registerHostIpc } from './host-bridge'
import { isRunning } from '@codebuff/host-core'
import { abortRun } from '@codebuff/host-core'

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
      maximized: parsed.maximized,
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
      maximized: win.isMaximized(),
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
          join(process.cwd(), 'icon.ico'),
        ]
      : []),
    join(__dirname, '../../resources/icon.png'),
    join(__dirname, '../../icon.png'),
    join(app.getAppPath(), 'resources/icon.png'),
    join(app.getAppPath(), 'icon.png'),
    join(process.cwd(), 'resources/icon.png'),
    join(process.cwd(), 'icon.png'),
    join(__dirname, '../renderer/icon.png'),
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
      sandbox: false,
    },
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

  bindHostToWindow(win)
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

/* ─── Shell-only IPC (window, dialogs, theme, app version, updater) ─────── */
// All business channels (projects/tasks/settings/MCP/agents/files/runs) are
// registered by registerHostIpc() against @codebuff/host-core (ADR-21).

function registerShellIpc(): void {
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

  ipcMain.handle('AnyBuff:selectFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select the project folder to edit',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folder = result.filePaths[0]
    // Persist the chosen cwd + project through the host (business logic).
    // touchProject mirrors the pre-extraction behavior: opening an existing
    // project re-promotes it to the front of the sidebar's recent list.
    const { saveCwd, touchProject } = await import('@codebuff/host-core')
    saveCwd(folder)
    touchProject(folder)
    return folder
  })

  ipcMain.handle('AnyBuff:selectFiles', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.on('AnyBuff:setTheme', (_e, theme: 'dark' | 'light') => {
    // The native title bar follows nativeTheme for dark/light mode
    nativeTheme.themeSource = theme
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
  registerHostIpc()
  registerShellIpc()
  createWindow()
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
