/**
 * Channel dispatcher (M-A2) — turns the host-core business modules into a
 * uniform, transport-agnostic `dispatch(channel, args)` surface.
 *
 * Both shells adapt this to their transport:
 *   - Electron: ipcMain.handle(channel, (_e, ...args) => dispatch(channel, args))
 *   - WebSocket: ws-server routes WsRequest frames here.
 *
 * Handlers may be sync or async; dispatch always returns a Promise. Handler
 * errors are caught and returned as `{ ok: false, error }` so a misbehaving
 * call never takes down the run loop or the transport.
 */

import { CHANNELS, type HostChannel } from './channels'
import { getState, saveSettings, fetchModels } from './handlers-app'
import { listProjects, getTaskView, deleteTask, renameTask, removeProject, trimTaskLastTurn, searchHistory } from './handlers-projects'
import { runPrompt, abortRunChannel, approvalResponse, respondAskUserChannel } from './handlers-runs'
import { listMcpServers, saveMcpServer, deleteMcpServer, updateMcpServerSettings, testMcpServer } from './handlers-mcp'
import { listLocalAgents, createLocalAgent, deleteLocalAgent, readLocalAgentFile, saveLocalAgentFile, listSkills, readSkillFile } from './handlers-agents'
import { listFiles, listDir, readFile, pathInfo, gitBranch, gitDiff, gitAccept, gitRevert, projectName } from './handlers-files'
import { attachEventSink } from '../run/start-run'
import { bridgeEventBus, type EventBus } from '../events'

/** Result envelope every channel resolves to (mirrors the renderer's expectations). */
export type ChannelResult =
  | { ok: true; [k: string]: unknown }
  | { ok: false; error: string }

// Deliberately `any[]`: handlers have heterogeneous positional signatures and
// are only invoked through dispatch() which spreads unknown[] args at runtime.
type Handler = (...args: any[]) => unknown | Promise<unknown>

/** Registry mapping channel name → handler. */
export type HandlerRegistry = Record<HostChannel, Handler>

/** Raw registry (no envelope) used internally; dispatch wraps results. */
const registry: Record<string, Handler> = {
  // App state
  getState,
  saveSettings,
  fetchModels,
  // Projects & tasks
  listProjects,
  getTaskView,
  deleteTask,
  renameTask,
  removeProject,
  trimTaskLastTurn,
  searchHistory,
  // Runs
  runPrompt,
  abort: abortRunChannel,
  approvalResponse,
  respondAskUser: respondAskUserChannel,
  // MCP
  listMcpServers,
  saveMcpServer,
  deleteMcpServer,
  updateMcpServerSettings,
  testMcpServer,
  // Agents & skills
  listLocalAgents,
  createLocalAgent,
  deleteLocalAgent,
  readLocalAgentFile,
  saveLocalAgentFile,
  listSkills,
  readSkillFile,
  // Files & git
  listFiles,
  listDir,
  readFile,
  pathInfo,
  gitBranch,
  gitDiff,
  gitAccept,
  gitRevert,
  projectName,
}

export interface Host {
  /** Dispatch a channel with positional args. Never throws — returns an envelope. */
  dispatch(channel: string, args: unknown[]): Promise<ChannelResult>
  /** Whether the channel is a known host-core business channel. */
  has(channel: string): boolean
  /** The full registry (for shell adapters that want typed access). */
  handlers: HandlerRegistry
}

const bridgedBuses = new WeakSet<EventBus>()

/**
 * Construct the host (registry is module-level; kept a factory for symmetry/tests).
 *
 * When an eventBus is supplied, it is bridged into the run orchestrator's
 * event sinks so every run UiEvent (stream chunks, tool calls, approval
 * requests, …) is emitted on the bus — the WS server (and any other
 * subscriber) broadcasts those to connected renderers. Without this bridge a
 * headless/WS host would run silently: events only reached sinks attached
 * directly by the Electron shell.
 *
 * Lifecycle note: the run orchestrator is a per-process singleton (startRun
 * guards `if (currentAbort)`), so exactly one host drives runs in a process;
 * the bridge therefore attaches once for the process lifetime and is never
 * detached. The WeakSet guard makes repeated createHost({eventBus}) calls
 * with the same bus idempotent.
 */
export function createHost(options: { eventBus?: EventBus } = {}): Host {
  if (options.eventBus && !bridgedBuses.has(options.eventBus)) {
    bridgedBuses.add(options.eventBus)
    attachEventSink(bridgeEventBus(options.eventBus))
  }
  return {
    async dispatch(channel: string, args: unknown[]): Promise<ChannelResult> {
      const handler = registry[channel]
      if (!handler) return { ok: false, error: `Unknown channel: ${channel}` }
      try {
        const result = await handler(...(args ?? []))
        // Handlers that already return an envelope pass through untouched.
        if (isEnvelope(result)) return result
        return { ok: true, result }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    has(channel: string): boolean {
      return channel in registry && (CHANNELS as readonly string[]).includes(channel)
    },
    handlers: registry as HandlerRegistry,
  }
}

function isEnvelope(value: unknown): value is ChannelResult {
  return Boolean(value) && typeof value === 'object' && 'ok' in (value as Record<string, unknown>)
}
