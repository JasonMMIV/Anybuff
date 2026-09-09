import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { QueryIndexData, QueryIndexQuery } from '../shared/codebase-index'
import type { UpdateUiEvent } from '../main/updater'

export interface TodoItem {
  task: string
  completed: boolean
}

export interface FileChange {
  path: string
  action: 'create' | 'modify' | 'delete'
}

export interface UiEvent {
  type: string
  /** Task (conversation) this event belongs to — filter chat events by it. */
  taskId?: string
  text?: string
  action?: string
  toolName?: string
  status?: string
  agentType?: string
  /** Human-readable agent name from the runtime (falls back to agentType in the UI). */
  agentName?: string
  model?: string
  message?: string
  files?: string[]
  changedFiles?: FileChange[]
  used?: number
  max?: number
  totalCost?: number
  queryInput?: QueryIndexQuery
  queryIndex?: QueryIndexData
  todos?: TodoItem[]
  /** #12 工具具名卡片：lightweight tool-call parameters (paths/pattern/url/command…). */
  toolInput?: Record<string, unknown>
  /** #12 read_files 中被 isSensitiveFile 擋住的路徑（UI 畫刪除線 + blocked 徽章）。 */
  blockedPaths?: string[]
  raw?: unknown
  /* auto_retry events */
  attempt?: number
  maxAttempts?: number
  /** Unix ms when the next automatic retry will fire. */
  nextAt?: number
}

const api = {
  /* Window controls (frameless title bar) */
  windowMinimize: () => ipcRenderer.send('AnyBuff:windowMinimize'),
  windowMaximize: () => ipcRenderer.send('AnyBuff:windowMaximize'),
  windowClose: () => ipcRenderer.send('AnyBuff:windowClose'),
  windowIsMaximized: () => ipcRenderer.invoke('AnyBuff:windowIsMaximized'),
  windowReload: () => ipcRenderer.send('AnyBuff:windowReload'),
  windowForceReload: () => ipcRenderer.send('AnyBuff:windowForceReload'),
  windowToggleFullScreen: () => ipcRenderer.send('AnyBuff:windowToggleFullScreen'),
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => {
    const listener = (_e: IpcRendererEvent, maximized: boolean) => callback(maximized)
    ipcRenderer.on('AnyBuff:windowMaximizeChange', listener)
    return () => { ipcRenderer.removeListener('AnyBuff:windowMaximizeChange', listener) }
  },

  getState: () => ipcRenderer.invoke('AnyBuff:getState'),
  /** #15 /diagnostics — host process snapshot (CPU/memory/uptime/children). */
  getDiagnostics: () => ipcRenderer.invoke('AnyBuff:getDiagnostics'),
  /** Running app version (Electron, sourced from package.json). */
  getAppVersion: () => ipcRenderer.invoke('AnyBuff:getAppVersion'),
  /** Compare the running version against the latest GitHub release. */
  checkForUpdates: () => ipcRenderer.invoke('AnyBuff:checkForUpdates'),
  /** electron-updater manual check (packaged builds only; dev falls back to checkForUpdates). */
  updateCheck: () => ipcRenderer.invoke('AnyBuff:updateCheck'),
  /** Download a discovered update (auto-download is on; this is a retry path). */
  updateDownload: () => ipcRenderer.invoke('AnyBuff:updateDownload'),
  /** Quit and install a downloaded update. */
  updateInstall: () => ipcRenderer.invoke('AnyBuff:updateInstall'),
  /** Subscribe to updater lifecycle events (checking/available/progress/downloaded/error). */
  onUpdateEvent: (callback: (event: UpdateUiEvent) => void) => {
    const listener = (_e: IpcRendererEvent, event: UpdateUiEvent) => callback(event)
    ipcRenderer.on('AnyBuff:updateEvent', listener)
    return () => {
      ipcRenderer.removeListener('AnyBuff:updateEvent', listener)
    }
  },
  selectFolder: () => ipcRenderer.invoke('AnyBuff:selectFolder'),
  selectFiles: () => ipcRenderer.invoke('AnyBuff:selectFiles'),
  /** Resolve the on-disk path of a dropped File object (Electron ≥32 removed File.path). */
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  /** #8 對話匯出：renderer serializes the conversation (Markdown), the shell saves it via the native dialog. */
  exportConversationFile: (payload: { content: string; defaultName: string; startDir?: string | null }) =>
    ipcRenderer.invoke('AnyBuff:exportConversationFile', payload),
  saveSettings: (payload: unknown) => ipcRenderer.invoke('AnyBuff:saveSettings', payload),
  /* MCP servers (Settings → MCP Tools) */
  listMcpServers: (cwd: string | null) => ipcRenderer.invoke('AnyBuff:listMcpServers', cwd),
  saveMcpServer: (payload: unknown) => ipcRenderer.invoke('AnyBuff:saveMcpServer', payload),
  deleteMcpServer: (payload: { id: string }) => ipcRenderer.invoke('AnyBuff:deleteMcpServer', payload),
  updateMcpServerSettings: (payload: { cwd: string | null; id: string; enabled?: boolean; targetAgents?: string[] }) =>
    ipcRenderer.invoke('AnyBuff:updateMcpServerSettings', payload),
  testMcpServer: (payload: { record: unknown }) => ipcRenderer.invoke('AnyBuff:testMcpServer', payload),
  listSkills: (cwd: string) => ipcRenderer.invoke('AnyBuff:listSkills', cwd),
  listLocalAgents: (cwd: string) => ipcRenderer.invoke('AnyBuff:listLocalAgents', cwd),
  /** ADR-23 @-mention menu — mode-root spawnable agents (upstream semantics;
   *  picking one inserts @id into the draft, the ROOT spawns it as a sub-agent). */
  listMentionAgents: (cwd: string, mode?: 'default' | 'plan' | 'chat') =>
    ipcRenderer.invoke('AnyBuff:listMentionAgents', cwd, mode),
  createLocalAgent: (payload: unknown) => ipcRenderer.invoke('AnyBuff:createLocalAgent', payload),
  deleteLocalAgent: (payload: { cwd: string; filePath?: string; id?: string }) =>
    ipcRenderer.invoke('AnyBuff:deleteLocalAgent', payload),
  readLocalAgentFile: (payload: { filePath: string }) =>
    ipcRenderer.invoke('AnyBuff:readLocalAgentFile', payload),
  saveLocalAgentFile: (payload: { filePath: string; content: string }) =>
    ipcRenderer.invoke('AnyBuff:saveLocalAgentFile', payload),
  readSkillFile: (path: string) => ipcRenderer.invoke('AnyBuff:readSkillFile', path),
  listProjects: () => ipcRenderer.invoke('AnyBuff:listProjects'),
  /** Persist the currently open project folder (restored by getState on reload). */
  saveCwd: (cwd: string) => ipcRenderer.invoke('AnyBuff:saveCwd', cwd),
  touchProject: (cwd: string) => ipcRenderer.invoke('AnyBuff:touchProject', cwd),
  deleteTask: (taskId: string) => ipcRenderer.invoke('AnyBuff:deleteTask', taskId),
  renameTask: (payload: { taskId: string; newPrompt: string }) =>
    ipcRenderer.invoke('AnyBuff:renameTask', payload),
  removeProject: (projectPath: string) => ipcRenderer.invoke('AnyBuff:removeProject', projectPath),
  /** Full snapshot of a conversation (transcript + status + resume info). */
  getTaskView: (taskId: string) => ipcRenderer.invoke('AnyBuff:getTaskView', taskId),
  /** Revert support: drop the last user turn from transcript + run state, keeping earlier context. */
  trimTaskLastTurn: (payload: { taskId: string; userText: string }) =>
    ipcRenderer.invoke('AnyBuff:trimTaskLastTurn', payload),
  searchHistory: (query: string) => ipcRenderer.invoke('AnyBuff:searchHistory', query),
  runPrompt: (payload: {
    cwd: string
    prompt: string
    displayText?: string
    taskId?: string
    resume?: boolean
    mode?: 'default' | 'plan' | 'chat'
    /** #4 base64 image parts (composer paste/attach), see host contracts. */
    content?: Array<{ type: 'image'; image: string; mediaType: string }>
  }) => ipcRenderer.invoke('AnyBuff:runPrompt', payload),
  abort: () => ipcRenderer.invoke('AnyBuff:abort'),
  /** #9 Bash mode: run a user-initiated `!command` locally (ADR-12b scrubbed env). */
  runBashCommand: (payload: { command: string; cwd: string; timeoutSeconds?: number }) =>
    ipcRenderer.invoke('AnyBuff:runBashCommand', payload),
  respondAskUser: (payload: unknown) => ipcRenderer.invoke('AnyBuff:respondAskUser', payload),
  respondApproval: (approved: boolean) => ipcRenderer.invoke('AnyBuff:approvalResponse', approved),
  listFiles: (root: string) => ipcRenderer.invoke('AnyBuff:listFiles', root),
  listDir: (dir: string) => ipcRenderer.invoke('AnyBuff:listDir', dir),
  readFile: (path: string) => ipcRenderer.invoke('AnyBuff:readFile', path),
  gitAccept: (payload: { cwd: string; file: string }) => ipcRenderer.invoke('AnyBuff:gitAccept', payload),
  gitRevert: (payload: { cwd: string; file: string }) => ipcRenderer.invoke('AnyBuff:gitRevert', payload),
  pathInfo: (path: string) => ipcRenderer.invoke('AnyBuff:pathInfo', path),
  gitBranch: (cwd: string) => ipcRenderer.invoke('AnyBuff:gitBranch', cwd),
  gitDiff: (cwd: string) => ipcRenderer.invoke('AnyBuff:gitDiff', cwd),
  projectName: (cwd: string) => ipcRenderer.invoke('AnyBuff:projectName', cwd),
  fetchModels: (payload: { baseURL: string; apiKey?: string; providerType?: string; providerId?: string }) =>
    ipcRenderer.invoke('AnyBuff:fetchModels', payload),
  setTheme: (theme: 'dark' | 'light') => ipcRenderer.send('AnyBuff:setTheme', theme),
  /** Android-only: on-device engine diagnostics log (always null on desktop). */
  readEngineLog: async (): Promise<string | null> => null,
  /** Android-only: pull a SAF folder staged while this page was (re)loading —
   *  single-shot (clears the shell-side holder); always null on desktop. */
  takeStagedFolder: async (): Promise<string | null> => null,
  getZoomFactor: () => webFrame.getZoomFactor(),
  setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor),
  onEvent: (callback: (event: UiEvent) => void) => {
    const listener = (_e: IpcRendererEvent, event: UiEvent) => callback(event)
    ipcRenderer.on('AnyBuff:event', listener)
    return () => {
      ipcRenderer.removeListener('AnyBuff:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('AnyBuff', api)

export type AnyBuffApi = typeof api
