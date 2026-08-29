import { CodebuffClient, type FileFilter, type PrintModeEvent, type RunState } from '@codebuff/sdk'
import type { BrowserWindow } from 'electron'
import { isSensitiveFile } from './file-filter'
import { applySettingsToEnv, saveTaskCheckpoint, loadTaskRunState, loadSettings, getProviderApiKeyOverrides } from './settings'
import { bundledAgents } from './agents/bundled-agents'
import { loadProjectLocalAgents, type LocalAgentsResult } from './agents/local-agents'
import {
  applyEvent,
  beginResumeTurn,
  beginUserTurn,
  buildResumableState,
  classifyFailure,
  finishRun,
  getSession,
  markRunning
} from './session-store'
import type { QueryIndexData, QueryIndexQuery, QueryIndexResult } from '../shared/codebase-index'

/**
 * Embeds CodebuffClient in the main process.
 * - The run is owned here and tied to a taskId from the session store; renderer
 *   navigation can never interrupt it or lose its history.
 * - Events (tool_call, text, subagent_start, etc.) are normalized, tagged with
 *   the taskId, persisted into the session transcript, and pushed to the
 *   renderer.
 * - Stream chunks are forwarded live (assistant message text).
 */

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
  /** #12 工具具名卡片：lightweight tool-call parameters (paths/pattern/url/command…), content-heavy fields stripped. */
  toolInput?: Record<string, unknown>
  /** #12 read_files 中被 isSensitiveFile 擋住的路徑（UI 畫刪除線 + blocked 徽章）。 */
  blockedPaths?: string[]
  raw?: unknown
  /* auto_retry events */
  attempt?: number
  maxAttempts?: number
  nextAt?: number
}

/* ─── Auto-retry on transient failures (network / timeout / rate-limit) ─── */

/**
 * Fork-parity: OpenBuff-Desktop suppressed ALL context-pruner events at
 * emission; upstream freebuff forwards lifecycle cards ("silent pause"
 * explainer). We choose silence — the pruner is a zero-LLM history
 * maintenance routine spawned programmatically every step, not user-visible
 * work. To debug context pruning, empty this set. See PLAN.md §10.
 */
const SILENT_AGENT_TYPES = new Set(['context-pruner'])

function isSilentAgentEvent(event: UiEvent): boolean {
  return (
    'agentType' in event &&
    typeof event.agentType === 'string' &&
    SILENT_AGENT_TYPES.has(event.agentType)
  )
}

/** Failure reasons eligible for automatic retry (classifyFailure keys). */
const AUTO_RETRY_REASONS = new Set(['network', 'timeout', 'rate-limit'])
/** Retries after the initial attempt (total attempts = 1 + AUTO_RETRY_MAX_RETRIES). */
const AUTO_RETRY_MAX_RETRIES = 3
const AUTO_RETRY_BASE_DELAY_MS = 2000
const AUTO_RETRY_MAX_DELAY_MS = 10_000

/** Exponential backoff with ±20% jitter: ~2s → ~4s → ~8s (capped). */
function computeRetryDelayMs(retryNumber: number): number {
  const exponent = Math.max(0, retryNumber - 1)
  const base = Math.min(AUTO_RETRY_BASE_DELAY_MS * Math.pow(2, exponent), AUTO_RETRY_MAX_DELAY_MS)
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

/**
 * Wait for the backoff delay. Resolves true when the delay elapsed and false
 * when the abort signal fired (user pressed Stop during the wait).
 */
function waitForDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs)
    function onAbort(): void {
      cleanup()
      resolve(false)
    }
    function done(): void {
      cleanup()
      resolve(true)
    }
    function cleanup(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** File paths a tool mutates, keyed by tool name (mirrors the SDK's PATH_INPUTS). */
function extractMutationFiles(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const rec = input as Record<string, unknown>
  const paths: string[] = []
  const push = (p: unknown): void => {
    if (typeof p === 'string' && p.trim()) paths.push(p.trim())
  }
  switch (toolName) {
    case 'edit_transaction': {
      const edits = rec.edits
      if (Array.isArray(edits)) {
        for (const e of edits) {
          if (e && typeof e === 'object') push((e as Record<string, unknown>).path)
        }
      }
      break
    }
    case 'write_file':
    case 'str_replace':
    case 'replace_range':
    case 'rewrite_symbol':
    case 'create_file':
    case 'move_file':
    case 'delete_file':
      push(rec.path)
      if (toolName === 'move_file') push(rec.newPath)
      break
    default:
      return []
  }
  return paths
}

/** Extract file changes with action types (create/modify/delete) from tool input. */
function extractFileChanges(toolName: string, input: unknown): FileChange[] {
  if (!input || typeof input !== 'object') return []
  const rec = input as Record<string, unknown>
  const changes: FileChange[] = []
  const add = (p: unknown, action: FileChange['action']): void => {
    if (typeof p === 'string' && p.trim()) changes.push({ path: p.trim(), action })
  }
  switch (toolName) {
    case 'edit_transaction': {
      const edits = rec.edits
      if (Array.isArray(edits)) {
        for (const e of edits) {
          if (e && typeof e === 'object') {
            const editRec = e as Record<string, unknown>
            // Determine action from the edit operation
            const operation = String(editRec.operation ?? '').toLowerCase()
            if (operation === 'create' || operation === 'new_file') {
              add(editRec.path, 'create')
            } else if (operation === 'delete' || operation === 'remove') {
              add(editRec.path, 'delete')
            } else {
              add(editRec.path, 'modify')
            }
          }
        }
      }
      break
    }
    case 'write_file':
    case 'str_replace':
    case 'replace_range':
    case 'rewrite_symbol':
      add(rec.path, 'modify')
      break
    case 'create_file':
      add(rec.path, 'create')
      break
    case 'move_file':
      add(rec.path, 'delete')
      add(rec.newPath, 'create')
      break
    case 'delete_file':
      add(rec.path, 'delete')
      break
    default:
      return []
  }
  return changes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeQueryIndexInput(input: unknown): QueryIndexQuery | undefined {
  if (!isRecord(input)) return undefined
  const query: QueryIndexQuery = {}
  if (typeof input.query === 'string') query.query = input.query
  if (typeof input.limit === 'number') query.limit = input.limit
  if (typeof input.mode === 'string') query.mode = input.mode
  if (typeof input.from === 'string') query.from = input.from
  if (typeof input.to === 'string') query.to = input.to
  if (Array.isArray(input.fileTypes)) query.fileTypes = input.fileTypes.filter((v): v is string => typeof v === 'string')
  if (Array.isArray(input.pathPrefixes)) query.pathPrefixes = input.pathPrefixes.filter((v): v is string => typeof v === 'string')
  return query
}

/**
 * #12 工具具名卡片：pull the lightweight, display-relevant parameters out of a
 * tool-call input for the renderer. Content-heavy fields (file contents, diff
 * bodies, full question payloads…) are deliberately NOT forwarded — the
 * renderer only needs the title-line facts.
 */
function normalizeToolInput(toolName: string, input: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined
  const out: Record<string, unknown> = {}
  switch (toolName) {
    case 'read_files':
      if (Array.isArray(input.paths)) out.paths = input.paths.filter((p): p is string => typeof p === 'string')
      break
    case 'read_subtree':
      if (Array.isArray(input.paths)) out.paths = input.paths.filter((p): p is string => typeof p === 'string')
      if (typeof input.maxTokens === 'number') out.maxTokens = input.maxTokens
      break
    case 'list_directory':
      if (typeof input.path === 'string') out.path = input.path
      break
    case 'glob':
      if (typeof input.pattern === 'string') out.pattern = input.pattern
      if (typeof input.cwd === 'string') out.cwd = input.cwd
      break
    case 'find_files':
      if (typeof input.prompt === 'string') out.prompt = input.prompt
      break
    case 'code_search':
      if (typeof input.pattern === 'string') out.pattern = input.pattern
      if (typeof input.flags === 'string') out.flags = input.flags
      if (typeof input.cwd === 'string') out.cwd = input.cwd
      if (typeof input.maxResults === 'number') out.maxResults = input.maxResults
      break
    case 'web_search':
      if (typeof input.query === 'string') out.query = input.query
      if (typeof input.depth === 'string') out.depth = input.depth
      break
    case 'read_url':
      if (typeof input.url === 'string') out.url = input.url
      break
    case 'read_docs':
      if (typeof input.libraryTitle === 'string') out.libraryTitle = input.libraryTitle
      if (typeof input.topic === 'string') out.topic = input.topic
      break
    case 'run_terminal_command':
      if (typeof input.command === 'string') out.command = input.command
      if (typeof input.process_type === 'string') out.processType = input.process_type
      if (typeof input.cwd === 'string') out.cwd = input.cwd
      break
    case 'write_file':
    case 'propose_write_file':
      if (typeof input.path === 'string') out.path = input.path
      break
    case 'str_replace':
    case 'propose_str_replace':
      if (typeof input.path === 'string') out.path = input.path
      if (Array.isArray(input.replacements)) out.replacements = input.replacements.length
      break
    case 'apply_patch': {
      const op = isRecord(input.operation) ? input.operation : undefined
      if (op && typeof op.path === 'string') out.path = op.path
      if (op && typeof op.type === 'string') out.operation = op.type
      break
    }
    case 'edit_transaction': {
      if (Array.isArray(input.edits)) {
        out.editPaths = input.edits
          .filter((e): e is Record<string, unknown> => isRecord(e) && typeof e.path === 'string')
          .map((e) => String(e.path))
      }
      break
    }
    case 'think_deeply':
      if (typeof input.thought === 'string') out.thought = input.thought
      break
    case 'update_subgoal':
      if (typeof input.id === 'string') out.id = input.id
      break
    case 'skill':
      if (typeof input.name === 'string') out.name = input.name
      break
    case 'gravity_index':
      if (typeof input.action === 'string') out.action = input.action
      if (typeof input.query === 'string') out.query = input.query
      if (typeof input.slug === 'string') out.slug = input.slug
      break
    case 'ask_user':
      if (Array.isArray(input.questions)) out.questions = input.questions.length
      break
    case 'spawn_agents':
      if (Array.isArray(input.agents)) {
        out.agentTypes = input.agents
          .filter((a): a is Record<string, unknown> => isRecord(a) && typeof a.agent_type === 'string')
          .map((a) => String(a.agent_type))
      }
      break
    default:
      return undefined
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** #12 read_files 中被敏感檔過濾擋住的路徑（與 fileFilter 同一套 isSensitiveFile 規則）。 */
function extractBlockedPaths(toolName: string, input: unknown): string[] | undefined {
  if (toolName !== 'read_files') return undefined
  if (!isRecord(input) || !Array.isArray(input.paths)) return undefined
  const blocked = input.paths.filter((p): p is string => typeof p === 'string' && isSensitiveFile(p))
  return blocked.length > 0 ? blocked : undefined
}

function normalizeQueryIndexResult(value: unknown): QueryIndexResult | null {
  if (!isRecord(value) || typeof value.path !== 'string') return null
  const result: QueryIndexResult = { path: value.path }
  if (typeof value.indexedHash === 'string') result.indexedHash = value.indexedHash
  if (typeof value.score === 'number') result.score = value.score
  if (Array.isArray(value.matchedOn)) result.matchedOn = value.matchedOn.filter((v): v is string => typeof v === 'string')
  if (Array.isArray(value.symbols)) result.symbols = value.symbols.filter((v): v is string => typeof v === 'string')
  if (Array.isArray(value.headings)) result.headings = value.headings.filter((v): v is string => typeof v === 'string')
  if (Array.isArray(value.matchedSnippets)) result.matchedSnippets = value.matchedSnippets.filter((v): v is string => typeof v === 'string')
  if (typeof value.explanation === 'string') result.explanation = value.explanation
  if (Array.isArray(value.relatedFiles)) {
    result.relatedFiles = value.relatedFiles.filter(isRecord).flatMap((related) => {
      if (typeof related.path !== 'string') return []
      return [{
        path: related.path,
        ...(typeof related.score === 'number' ? { score: related.score } : {}),
        ...(typeof related.reason === 'string' ? { reason: related.reason } : {}),
        ...(typeof related.via === 'string' ? { via: related.via } : {})
      }]
    })
  }
  return result
}

function extractQueryIndexData(output: unknown): QueryIndexData | undefined {
  const items = Array.isArray(output) ? output : [output]
  for (const item of items) {
    if (!isRecord(item)) continue
    const candidate = item.type === 'json' && isRecord(item.value) ? item.value : item
    if (!isRecord(candidate) || !Array.isArray(candidate.results)) continue
    const results = candidate.results.flatMap((value) => {
      const result = normalizeQueryIndexResult(value)
      return result ? [result] : []
    })
    const data: QueryIndexData = { results }
    if (typeof candidate.kind === 'string') data.kind = candidate.kind
    if (typeof candidate.schemaVersion === 'number') data.schemaVersion = candidate.schemaVersion
    if (typeof candidate.totalIndexed === 'number') data.totalIndexed = candidate.totalIndexed
    if (typeof candidate.indexAge === 'number') data.indexAge = candidate.indexAge
    if (typeof candidate.message === 'string') data.message = candidate.message
    if (isRecord(candidate.status)) data.status = candidate.status as QueryIndexData['status']
    if (isRecord(candidate.snapshot)) data.snapshot = candidate.snapshot as QueryIndexData['snapshot']
    return data
  }
  return undefined
}

let client: CodebuffClient | null = null
let currentAbort: AbortController | null = null
/** Task id of the active run — used to tag every outgoing event. */
let activeRunTaskId: string | null = null
let mainWindow: BrowserWindow | null = null
let pendingApprovalResolver: ((approved: boolean) => void) | null = null

let pendingAskUserResolver: ((answers: unknown) => void) | null = null

/** Resolve the in-flight ask_user override (null answers = skipped). */
export function respondAskUser(answers: unknown): void {
  if (pendingAskUserResolver) {
    const fn = pendingAskUserResolver
    pendingAskUserResolver = null
    fn(answers ?? { skipped: true })
  }
}

export function respondApproval(approved: boolean): void {
  if (pendingApprovalResolver) {
    const fn = pendingApprovalResolver
    pendingApprovalResolver = null
    fn(approved)
  }
}
/** Custom agents loaded for the current cwd (used by the Settings status panel). */
let lastLocalAgents: LocalAgentsResult = { agents: [], validationErrors: [] }


export function attachWindow(win: BrowserWindow): void {
  mainWindow = win
}

function sendEvent(event: UiEvent): void {
  if (event.type === 'ignored') return
  // Tag every run-derived event with the owning task so the renderer can
  // route it to the right conversation view.
  const tagged = event.taskId ? event : { ...event, taskId: activeRunTaskId ?? undefined }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('AnyBuff:event', tagged)
  }
}

/** Normalize the SDK's PrintModeEvent into a compact event the UI can render */
function normalizeEvent(event: PrintModeEvent): UiEvent {
  const e = event as unknown as Record<string, unknown>
  const type = String(e.type ?? 'unknown')
  const base: UiEvent = { type }
  switch (type) {
    case 'text':
      base.text = String(e.text ?? '')
      break
    case 'tool_call':
      base.toolName = String(e.toolName ?? '')
      base.status = 'running'
      base.agentType = e.agentType ? String(e.agentType) : undefined
      if (
        base.toolName === 'add_message' ||
        base.toolName === 'set_messages' ||
        base.toolName === 'set_output' ||
        base.toolName === 'end_turn' ||
        base.toolName === 'git_status' ||
        base.toolName === 'check_job' ||
        base.toolName === 'check_background_agent' ||
        base.toolName === 'list_jobs'
      ) {
        return { type: 'ignored' }
      }
      if (base.toolName === 'suggest_followups') {
        if (e.input) {
          try {
            base.message = typeof e.input === 'string' ? e.input : JSON.stringify(e.input)
          } catch {
            // ignore
          }
        }
        return base
      }
      if (base.toolName === 'write_todos' && e.input && typeof e.input === 'object') {
        const input = e.input as Record<string, unknown>
        if (Array.isArray(input.todos)) {
          base.todos = (input.todos as Record<string, unknown>[])
            .filter((item) => typeof item === 'object' && item !== null)
            .map((item) => ({
              task: String(item.task ?? ''),
              completed: Boolean(item.completed)
            }))
        }
      }
      if (base.toolName === 'query_index') base.queryInput = normalizeQueryIndexInput(e.input)
      // #12 工具具名卡片：forward lightweight tool params + sensitive-file blocks.
      const toolInput = normalizeToolInput(base.toolName, e.input)
      if (toolInput) base.toolInput = toolInput
      const blockedPaths = extractBlockedPaths(base.toolName, e.input)
      if (blockedPaths) base.blockedPaths = blockedPaths
      // Track files this run modifies so the UI can offer "revert changes up to this point".
      const mutated = extractMutationFiles(base.toolName, e.input)
      if (mutated.length > 0) base.files = mutated
      // Extract file changes with action types for the UI summary
      const fileChanges = extractFileChanges(base.toolName, e.input)
      if (fileChanges.length > 0) base.changedFiles = fileChanges
      break
    case 'tool_start':
      base.toolName = String(e.toolName ?? '')
      base.status = 'running'
      base.agentType = e.agentType ? String(e.agentType) : undefined
      if (
        base.toolName === 'add_message' ||
        base.toolName === 'set_messages' ||
        base.toolName === 'set_output' ||
        base.toolName === 'end_turn' ||
        base.toolName === 'git_status' ||
        base.toolName === 'check_job' ||
        base.toolName === 'check_background_agent' ||
        base.toolName === 'list_jobs' ||
        base.toolName === 'suggest_followups' ||
        base.toolName === 'run_file_change_hooks' ||
        base.toolName === 'run_targeted_validation'
      ) {
        return { type: 'ignored' }
      }
      break
    case 'tool_result': {
      base.toolName = String(e.toolName ?? '')
      base.status = String(e.status ?? 'done')
      base.agentType = e.agentType ? String(e.agentType) : undefined
      if (
        base.toolName === 'add_message' ||
        base.toolName === 'set_messages' ||
        base.toolName === 'set_output' ||
        base.toolName === 'end_turn' ||
        base.toolName === 'git_status' ||
        base.toolName === 'check_job' ||
        base.toolName === 'check_background_agent' ||
        base.toolName === 'list_jobs' ||
        base.toolName === 'suggest_followups' ||
        base.toolName === 'run_file_change_hooks' ||
        base.toolName === 'run_targeted_validation'
      ) {
        return { type: 'ignored' }
      }
      if (base.toolName === 'spawn_agents' || base.toolName === 'spawn_agent_inline') {
        base.message = 'Subagents finished'
        break
      }
      if (base.toolName === 'query_index') {
        const queryIndex = extractQueryIndexData(e.output)
        if (queryIndex) {
          base.queryIndex = queryIndex
          base.message = queryIndex.message ?? `Found ${queryIndex.results.length} indexed file result(s).`
        }
      }
      // Carry tool output text into the UI so completed tools don't render as an empty line
      const output = e.output
      if (Array.isArray(output)) {
        const parts: string[] = []
        for (const o of output) {
          if (o && typeof o === 'object') {
            if (o.type === 'text' && typeof o.text === 'string') parts.push(o.text)
            else if (o.type === 'json' && o.value !== undefined) {
              try {
                const v = o.value
                parts.push(typeof v === 'string' ? v : JSON.stringify(v))
              } catch {
                // ignore serialization failure
              }
            } else if (o.type === 'media') {
              parts.push(`[${String(o.mediaType ?? 'media')}]`)
            }
          } else if (typeof o === 'string') {
            parts.push(o)
          }
        }
        const joined = parts.join('\n').slice(0, 4000)
        if (joined && !base.queryIndex) base.message = joined
      }
      break
    }
    case 'subagent_start':
      base.agentType = String(e.agentType ?? '')
      base.agentName = typeof e.displayName === 'string' && e.displayName ? e.displayName : undefined
      if (e.prompt) base.message = String(e.prompt)
      break
    case 'subagent_finish':
      base.agentType = String(e.agentType ?? '')
      base.agentName = typeof e.displayName === 'string' && e.displayName ? e.displayName : undefined
      base.status = 'done'
      if (e.output) {
        try {
          base.message = typeof e.output === 'string' ? e.output : JSON.stringify(e.output)
        } catch {
          // ignore
        }
      }
      break
    case 'start':
      base.agentType = String(e.agentType ?? '')
      base.status = 'started'
      break
    case 'finish':
      base.status = 'done'
      base.totalCost = typeof e.totalCost === 'number' ? e.totalCost : undefined
      break
    case 'error': {
      const msg = String(e.error ?? e.message ?? '')
      // SDK-internal schema validation warnings on streaming chunks (e.g. some OpenAI-compatible
      // endpoints omit the tool_calls index) or followups termination warning — harmless, don't surface to the user
      if (
        msg.includes('Type validation failed') ||
        msg.includes('suggest_followups already ended') ||
        msg.includes('No more non-terminal tools are available after followups')
      ) {
        return { type: 'ignored' }
      }
      base.message = msg
      break
    }
    case 'phase':
      base.status = String(e.status ?? '')
      break
    case 'context_compaction':
      // Surfaced so users understand why very old context may be summarized.
      base.action = String(e.action ?? '')
      base.status = String(e.action ?? '')
      break
    case 'reasoning_delta':
      base.text = String(e.delta ?? e.chunk ?? e.text ?? '')
      break
    case 'provider_status':
      base.message = String(e.status ?? '')
      break
    case 'context_window':
      base.used = typeof e.used === 'number' ? e.used : undefined
      base.max = typeof e.max === 'number' ? e.max : undefined
      break
    case 'download':
      base.message = String(e.label ?? '')
      base.status = String(e.status ?? '')
      break
    default:
      base.raw = e
  }
  return base
}

export function isRunning(): boolean {
  return currentAbort !== null
}

/** Custom agents (.agents/) discovered for the current project. */
export function getLastLocalAgents(): LocalAgentsResult {
  return lastLocalAgents
}

/** Load custom agents for a project and merge them over the bundled definitions. */
async function buildAgentDefinitions(cwd: string): Promise<{ definitions: Record<string, any>; local: LocalAgentsResult }> {
  const local = await loadProjectLocalAgents(cwd)
  lastLocalAgents = local
  const merged: Record<string, any> = { ...bundledAgents }
  // Project/home agents override bundled ones with the same id (CLI behavior).
  for (const [id, def] of Object.entries(local.agents)) {
    merged[id] = def
  }
  const customIds = local.agents.map((a) => a.id)
  // Expose custom agents to every selectable root variant so they remain
  // spawnable regardless of which UI mode (default/plan) is active.
  for (const rootId of ['base2', 'base2-plan']) {
    const baseDef = merged[rootId]
    if (!baseDef || customIds.length === 0) continue
    const existing = new Set(baseDef.spawnableAgents ?? [])
    const added = customIds.filter((id) => !existing.has(id))
    if (added.length > 0) {
      merged[rootId] = { ...baseDef, spawnableAgents: [...(baseDef.spawnableAgents ?? []), ...added] }
    }
  }
  return { definitions: merged, local }
}

export interface RunResult {
  ok: boolean
  taskId?: string
  error?: string
  interrupted?: boolean
  reason?: string
  errorMessage?: string
}

export interface StartRunOptions {
  cwd: string
  /** Final prompt sent to the SDK (attachments/skills already resolved). */
  prompt: string
  /** Raw user text persisted in the transcript. */
  displayText: string
  taskId: string
  /** Resume an interrupted turn (Resume banner) — supports checkpoint recovery. */
  resume?: boolean
  /** UI agent mode — selects the bundled root agent ('default' → base2, 'plan' → base2-plan). */
  mode?: 'default' | 'plan'
}

/** UI agent mode → bundled root agent id (mirrors the upstream CLI's AGENT_MODE_TO_ID table). */
const AGENT_ID_FOR_MODE: Record<'default' | 'plan', string> = {
  default: 'base2',
  plan: 'base2-plan'
}

/**
 * Run the agent for a conversation. The run is owned by the main process and
 * keyed by taskId; all context resolution (previousRun) happens here, so the
 * renderer never needs to hold or restore an opaque state blob.
 */
export async function startRun(opts: StartRunOptions): Promise<RunResult> {
  const { cwd, prompt, displayText, taskId } = opts
  const agentId = AGENT_ID_FOR_MODE[opts.mode ?? 'default']

  if (currentAbort) return { ok: false, taskId, error: 'Another task is already running' }

  const entry = getSession(taskId)
  if (!entry) return { ok: false, taskId, error: 'Unknown task' }
  if (!prompt.trim()) return { ok: false, taskId, error: 'Empty prompt' }

  currentAbort = new AbortController()
  activeRunTaskId = taskId
  markRunning(taskId)

  // Open a fresh assistant bubble in the transcript (and the user message for
  // non-resume turns), then announce the run so any view can show its status.
  if (opts.resume === true) {
    beginResumeTurn(taskId)
  } else {
    beginUserTurn(taskId, displayText || prompt.trim())
  }
  sendEvent({ type: 'run_status', status: 'running', taskId })

  try {
    // Apply provider settings (API key + config path) before each run
    applySettingsToEnv()

    // Load custom agents (.agents/). A broken agent file must never block the whole
    // run — fall back to the bundled definitions and report the load failure.
    let definitions: Record<string, any>
    try {
      const built = await buildAgentDefinitions(cwd)
      definitions = built.definitions
    } catch (agentLoadError) {
      definitions = bundledAgents
      sendEvent({ type: 'error', message: `Custom agents failed to load: ${agentLoadError instanceof Error ? agentLoadError.message : String(agentLoadError)}` })
    }
    const currentSettings = loadSettings()

    let attempt = 0
    while (true) {
      attempt++

      // Resolve conversation context fresh on every attempt. Attempt 1 follows
      // the caller's intent; automatic retries behave exactly like a manual
      // Resume (memory → disk runstate → checkpoint splice), so a mid-turn
      // crash during any attempt still recovers.
      let previousRun: unknown | undefined
      let resumeFromCheckpoint = false
      if (attempt > 1 || opts.resume === true) {
        const resumable = buildResumableState(taskId)
        previousRun = resumable?.previousRun ?? undefined
        resumeFromCheckpoint = resumable?.source === 'checkpoint'
        if (attempt > 1) sendEvent({ type: 'run_status', status: 'running', taskId })
      } else {
        // Plain continuation: the last completed turn's state only — never a
        // mid-turn checkpoint (its pending prompt would duplicate the turn).
        previousRun = entry.runState ?? loadTaskRunState(taskId) ?? undefined
      }

      client = new CodebuffClient({
        cwd,
        agentDefinitions: Object.values(definitions),
        approvalMode: currentSettings.approvalMode ?? 'balanced',
        requestApproval: async (request: { command: string; cwd: string; mode: string }) => {
          if (!mainWindow || mainWindow.isDestroyed()) return false

          // Cancel previous pending approval if any
          if (pendingApprovalResolver) {
            const prev = pendingApprovalResolver
            pendingApprovalResolver = null
            prev(false)
          }

          sendEvent({ type: 'approval_request', message: request.command, raw: request })

          return new Promise<boolean>((resolve) => {
            pendingApprovalResolver = resolve
          })
        },
        overrideTools: {
          ask_user: async (input: { questions?: unknown }) => {
            const questions = Array.isArray(input?.questions) ? input.questions : []
            if (!mainWindow || mainWindow.isDestroyed() || questions.length === 0) {
              return [{ type: 'json', value: { skipped: true } }]
            }
            if (pendingAskUserResolver) {
              const prev = pendingAskUserResolver
              pendingAskUserResolver = null
              prev({ skipped: true })
            }
            sendEvent({ type: 'ask_user', raw: questions } as never)
            const answers: unknown = await new Promise((resolve) => {
              pendingAskUserResolver = resolve as (v: unknown) => void
            })
            return [{ type: 'json', value: answers ?? { skipped: true } }]
          },
        },
        handleEvent: (event) => {
          const normalized = normalizeEvent(event)
          if (normalized.type !== 'ignored') {
            if (isSilentAgentEvent(normalized)) return
            applyEvent(taskId, normalized)
            sendEvent(normalized)
          }
        },
        handleStreamChunk: (chunk) => {
          // Only the main agent's plain-text chunks belong in the assistant bubble.
          // Sub-agent / reasoning chunks are forwarded as events so the UI can
          // choose to render them separately — they must not be appended to the
          // main assistant message (that caused duplicated/spliced replies).
          if (typeof chunk === 'string') {
            applyEvent(taskId, { type: 'stream', text: chunk })
            sendEvent({ type: 'stream', text: chunk })
          } else if (chunk && typeof chunk === 'object' && 'chunk' in chunk) {
            if (chunk.type === 'subagent_chunk') {
              const ev = { type: 'subagent_stream', text: String(chunk.chunk), agentType: chunk.agentType ? String(chunk.agentType) : undefined }
              if (ev.agentType && SILENT_AGENT_TYPES.has(ev.agentType)) return
              applyEvent(taskId, ev)
              sendEvent(ev)
            } else if (chunk.type === 'reasoning_chunk') {
              const ev = { type: 'reasoning_stream', text: String(chunk.chunk) }
              applyEvent(taskId, ev)
              sendEvent(ev)
            }
          }
        },
      })

      const runState = await client.run({
        agent: agentId,
        // Upstream resume semantics: when the restored history already ends
        // with this turn's user prompt, pass an empty prompt so the runtime
        // does not append a duplicate USER_PROMPT message.
        prompt: resumeFromCheckpoint ? '' : prompt,
        previousRun: previousRun as RunState | undefined,
        signal: currentAbort.signal,
        // ADR-12: decrypted provider keys travel through the SDK injection
        // channel, not process.env.
        apiKeyOverrides: getProviderApiKeyOverrides(),
        // Upstream emits full RunState snapshots every ~5s while in flight;
        // #1 資安級防護：敏感檔（.env、SSH 金鑰、kubeconfig、憑證…）一律
        // 擋在 agent 可讀範圍外，避免金鑰內容隨 LLM context 離開本機。
        fileFilter: ((filePath: string) =>
          isSensitiveFile(filePath) ? { status: 'blocked' as const } : { status: 'allow' as const }
        ) satisfies FileFilter,
        // persist them so a crashed session resumes mid-turn.
        onStateSnapshot: (snapshot) => {
          try {
            saveTaskCheckpoint(taskId, snapshot)
          } catch {
            // checkpoint persistence is best-effort; never kill the run
          }
        }
      })

      const failure = classifyInterrupted(runState)
      if (!failure) {
        finishRun(taskId, runState, { interrupted: false })
        sendEvent({ type: 'run_status', status: 'idle', taskId })
        return { ok: true, taskId, interrupted: false }
      }

      // Transient failures (network / timeout / rate-limit) auto-retry with
      // backoff before giving up and falling back to the manual Resume banner.
      const retryEligible =
        !currentAbort.signal.aborted &&
        failure.reason !== undefined &&
        AUTO_RETRY_REASONS.has(failure.reason) &&
        failure.autoRetryable !== false
      const canAutoRetry = retryEligible && attempt <= AUTO_RETRY_MAX_RETRIES

      if (!canAutoRetry) {
        finishRun(taskId, runState, { interrupted: true, errorMessage: failure.errorMessage })
        sendEvent({ type: 'run_status', status: 'interrupted', taskId })
        return {
          ok: true,
          taskId,
          interrupted: true,
          reason: failure.reason,
          errorMessage: failure.errorMessage
        }
      }

      // Persist the failed attempt's state (it becomes the retry's context and
      // a crash-safety net) without spamming the transcript with the raw error —
      // the next attempt will likely succeed and make the noise pointless.
      finishRun(taskId, runState, { interrupted: true, errorMessage: failure.errorMessage, silentError: true })

      const delayMs = computeRetryDelayMs(attempt)
      sendEvent({
        type: 'auto_retry',
        taskId,
        status: failure.reason,
        message: autoRetryHeadline(failure.reason),
        text: failure.errorMessage,
        attempt: attempt + 1,
        maxAttempts: AUTO_RETRY_MAX_RETRIES + 1,
        nextAt: Date.now() + delayMs
      })

      const elapsed = await waitForDelay(delayMs, currentAbort.signal)
      if (!elapsed) {
        // User pressed Stop while waiting — treat as an intentional stop.
        sendEvent({ type: 'run_status', status: 'interrupted', taskId })
        return {
          ok: true,
          taskId,
          interrupted: true,
          reason: 'stopped',
          errorMessage: failure.errorMessage
        }
      }

      beginResumeTurn(taskId)
      markRunning(taskId)
    }
  } catch (error) {
    // The SDK resolves (not rejects) on abort/API errors, so this only fires on
    // unexpected failures. Report the error so the UI can offer to retry.
    finishRun(taskId, null, { interrupted: true, errorMessage: error instanceof Error ? error.message : String(error) })
    sendEvent({ type: 'run_status', status: 'interrupted', taskId })
    return {
      ok: false,
      taskId,
      error: error instanceof Error ? error.message : String(error),
      interrupted: true,
      reason: 'error'
    }
  } finally {
    // ask_user parked across abort/run-end: resolve as skipped
    
if (pendingAskUserResolver) {
      const fnAsk = pendingAskUserResolver
      pendingAskUserResolver = null
      fnAsk({ skipped: true })
    }
    if (pendingApprovalResolver) {
      const fn = pendingApprovalResolver
      pendingApprovalResolver = null
      fn(false)
    }
    client = null
    activeRunTaskId = null
    currentAbort = null
  }
}

/**
 * Classify a finished run state. Returns null when the run completed normally;
 * otherwise carries the raw error message, its classified reason key, and
 * whether the failure qualifies for automatic retry.
 */
function classifyInterrupted(runState: RunState): {
  reason?: string
  errorMessage?: string
  autoRetryable?: boolean
} | null {
  const output = runState.output as {
    type?: string
    message?: string
    error?: string
    statusCode?: number
  } | undefined
  const interrupted = output?.type === 'error'
  if (!interrupted) return null

  const errorMessage =
    [output?.message, output?.error].filter((v): v is string => typeof v === 'string' && v.length > 0).join(' ') ||
    'Run failed'

  // A whole-run safety timeout ("Run timed out after Nms") means the turn got
  // stuck, not that the provider hiccuped — re-running it up to 3 more times
  // would silently burn hours and tokens. Request-level timeouts (different
  // messages) stay retryable.
  if (/^run timed out after/i.test(errorMessage)) {
    return { reason: classifyFailure(errorMessage), errorMessage, autoRetryable: false }
  }

  // Structured status codes beat message-text matching: providers localize or
  // reword errors, but 429/408/5xx are unambiguous transient signals.
  let reason = classifyFailure(errorMessage)
  if (typeof output?.statusCode === 'number') {
    if (output.statusCode === 429) reason = 'rate-limit'
    else if (output.statusCode === 408) reason = 'timeout'
    else if (output.statusCode >= 500) reason = 'network'
    else if (output.statusCode === 401 || output.statusCode === 403) reason = 'auth'
  }

  return { reason, errorMessage }
}

/** Short human headline per retryable failure reason (renderer mirrors this). */
function autoRetryHeadline(reason: string | undefined): string {
  switch (reason) {
    case 'network':
      return 'Network error — reconnecting automatically'
    case 'timeout':
      return 'Request timed out — retrying automatically'
    case 'rate-limit':
      return 'Rate limited — backing off before retrying'
    default:
      return 'Temporary issue — retrying automatically'
  }
}

export function abortRun(): void {
  // ask_user parked across abort/run-end: resolve as skipped
  
if (pendingAskUserResolver) {
    const fnAsk = pendingAskUserResolver
    pendingAskUserResolver = null
    fnAsk({ skipped: true })
  }
  if (pendingApprovalResolver) {
    const fn = pendingApprovalResolver
    pendingApprovalResolver = null
    fn(false)
  }
  currentAbort?.abort()
}