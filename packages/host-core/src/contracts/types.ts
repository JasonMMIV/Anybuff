/**
 * Shared host-contract value types — the single source of truth (ADR-18
 * convention) for shapes that cross the shell boundary. Previously these were
 * duplicated across desktop/src/main/*, desktop/src/preload and the renderer;
 * both the Electron preload and the WS protocol now import from here so the
 * 56 `AnyBuff:*` channels stay in lockstep.
 */

import type { QueryIndexData, QueryIndexQuery } from './codebase-index'

export interface TodoItem {
  task: string
  completed: boolean
}

export interface FileChange {
  path: string
  action: 'create' | 'modify' | 'delete'
}

/**
 * One persisted transcript message — the exact shape the session store keeps
 * per task file and the preload/renderer render. Single source of truth so
 * desktop main, the WS protocol and (Phase B) the Android WebView all agree.
 */
export interface TaskMessage {
  kind: string
  text?: string
  reasoning?: string
  files?: FileChange[]
  tool?: {
    toolName: string
    status: string
    agentType?: string
    agentName?: string
    detail?: string
    todos?: unknown[]
    toolInput?: Record<string, unknown>
    blockedPaths?: string[]
  }
  /** Epoch ms when the message was created (assistant: first token / user: send time). */
  createdAt?: number
  /** Epoch ms when the message completed (assistant: turn finished). */
  updatedAt?: number
}

/** Normalized run event pushed to the renderer (the preload's UiEvent shape). */
export interface UiEvent {
  type: string
  /** Task (conversation) this event belongs to — the renderer filters by it. */
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

/** UI agent mode — selects the bundled root agent. */
export type UIAgentMode = 'default' | 'plan' | 'chat'

/** Payload of AnyBuff:runPrompt. */
export interface RunPromptPayload {
  cwd: string
  prompt: string
  displayText?: string
  /** Existing conversation to continue; omitted = start a new one. */
  taskId?: string
  resume?: boolean
  mode?: UIAgentMode
}

/** App-level state returned by AnyBuff:getState. */
export interface AppStateSnapshot {
  cwd: string | null
  settings: unknown
  running: boolean
  runningTaskId: string | null
  agentIds: string[]
}

/** Full snapshot of a conversation (AnyBuff:getTaskView). */
export interface TaskViewSnapshot {
  exists: boolean
  cwd?: string
  transcript: TaskMessage[]
  status: 'idle' | 'running' | 'interrupted'
  canResume: boolean
  resumeReason?: string
  resumeErrorMessage?: string
  resumeSource?: 'memory' | 'runstate' | 'checkpoint'
}

/** Update lifecycle events forwarded over AnyBuff:updateEvent. */
export type UpdateUiEvent =
  | { type: 'checking-for-update' }
  | { type: 'update-available'; version?: string }
  | { type: 'update-not-available'; version?: string }
  | { type: 'download-progress'; percent?: number }
  | { type: 'update-downloaded' }
  | { type: 'update-error'; message?: string }
