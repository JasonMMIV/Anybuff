import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { QueryIndexData, QueryIndexQuery } from '../shared/codebase-index'

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
  selectFolder: () => ipcRenderer.invoke('AnyBuff:selectFolder'),
  selectFiles: () => ipcRenderer.invoke('AnyBuff:selectFiles'),
  saveSettings: (payload: unknown) => ipcRenderer.invoke('AnyBuff:saveSettings', payload),
  listSkills: (cwd: string) => ipcRenderer.invoke('AnyBuff:listSkills', cwd),
  listLocalAgents: (cwd: string) => ipcRenderer.invoke('AnyBuff:listLocalAgents', cwd),
  createLocalAgent: (payload: unknown) => ipcRenderer.invoke('AnyBuff:createLocalAgent', payload),
  deleteLocalAgent: (payload: { cwd: string; filePath?: string; id?: string }) =>
    ipcRenderer.invoke('AnyBuff:deleteLocalAgent', payload),
  readLocalAgentFile: (payload: { filePath: string }) =>
    ipcRenderer.invoke('AnyBuff:readLocalAgentFile', payload),
  saveLocalAgentFile: (payload: { filePath: string; content: string }) =>
    ipcRenderer.invoke('AnyBuff:saveLocalAgentFile', payload),
  readSkillFile: (path: string) => ipcRenderer.invoke('AnyBuff:readSkillFile', path),
  listProjects: () => ipcRenderer.invoke('AnyBuff:listProjects'),
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
    mode?: 'default' | 'plan'
  }) => ipcRenderer.invoke('AnyBuff:runPrompt', payload),
  abort: () => ipcRenderer.invoke('AnyBuff:abort'),
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
