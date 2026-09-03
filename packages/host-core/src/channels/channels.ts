/**
 * AnyBuff host-channel registry (ADR-21 / M-A2).
 *
 * Single source of truth for the *business* channel names the renderer can
 * invoke on the host. The Electron shell (ipcMain.handle) and the WebSocket
 * host (server/ws-server.ts) both dispatch against this same registry, so the
 * desktop preload and the Phase-B Android WebView stay in lockstep.
 *
 * Shell-only channels (window controls, folder/file dialogs, theme, updater,
 * app version) are intentionally NOT listed here — they belong to the Electron
 * shell (M-A4 keeps them in desktop/src/main).
 */

export const CHANNELS = [
  // App state
  'getState',
  'saveSettings',
  'fetchModels',
  // Projects & tasks
  'listProjects',
  'getTaskView',
  'deleteTask',
  'renameTask',
  'removeProject',
  'trimTaskLastTurn',
  'searchHistory',
  // Runs
  'runPrompt',
  'abort',
  'approvalResponse',
  'respondAskUser',
  // MCP servers
  'listMcpServers',
  'saveMcpServer',
  'deleteMcpServer',
  'updateMcpServerSettings',
  'testMcpServer',
  // Custom agents & skills
  'listLocalAgents',
  'createLocalAgent',
  'deleteLocalAgent',
  'readLocalAgentFile',
  'saveLocalAgentFile',
  'listSkills',
  'readSkillFile',
  // File system / git
  'listFiles',
  'listDir',
  'readFile',
  'pathInfo',
  'gitBranch',
  'gitDiff',
  'gitAccept',
  'gitRevert',
  'projectName',
] as const

export type HostChannel = (typeof CHANNELS)[number]

export function isHostChannel(name: string): name is HostChannel {
  return (CHANNELS as readonly string[]).includes(name)
}

/**
 * Envelope for WS requests/responses. Electron IPC skips the envelope (the IPC
 * channel name carries the routing), but the WS protocol needs it.
 */
export interface WsRequest {
  /** Monotonic client-generated id echoed back in the response. */
  id: number
  channel: HostChannel
  /** Arguments array (positional, matching each handler's signature). */
  args: unknown[]
}

export interface WsResponse {
  id: number
  ok: boolean
  /** Result when ok; error message otherwise. */
  result?: unknown
  error?: string
}

/** Outbound host event pushed to subscribed renderers (WS `event` frames). */
export interface WsEventFrame {
  event: 'event'
  payload: import('../contracts/types').UiEvent
}
