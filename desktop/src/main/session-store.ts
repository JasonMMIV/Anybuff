import type { FileChange, TaskMessage } from './settings'
import {
  deleteTaskCheckpoint,
  ensureProjectTask,
  getRecoveryFileInfo,
  loadTaskCheckpoint,
  loadTaskRunState,
  loadTaskTranscript,
  saveTaskRunState,
  saveTaskTranscript
} from './settings'

/**
 * Main-process session store — the single source of truth for conversations.
 *
 * The renderer is a pure view: it renders either a snapshot from this store or
 * live events tagged with a taskId. Conversation state (transcript + SDK run
 * state) lives here so that navigating away mid-run, closing the window, or
 * reloading the renderer can never lose history.
 */

/** Mirrors the renderer's UiEvent shape (structural subset). */
export interface StoreEvent {
  type: string
  text?: string
  toolName?: string
  status?: string
  agentType?: string
  message?: string
  files?: string[]
  changedFiles?: FileChange[]
  todos?: { task: string; completed: boolean }[]
}

export interface SessionEntry {
  taskId: string
  cwd: string
  transcript: TaskMessage[]
  runState: unknown | null
  status: 'idle' | 'running' | 'interrupted'
}

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

const sessions = new Map<string, SessionEntry>()
let runningTaskId: string | null = null

/** Tools hidden from the conversation timeline (mirrors the renderer's list). */
function isSilentTool(name?: string): boolean {
  if (!name) return false
  const n = name.toLowerCase().trim()
  return (
    n === 'git_status' ||
    n === 'suggest_followups' ||
    n === 'check_job' ||
    n === 'check_background_agent' ||
    n === 'list_jobs' ||
    n === 'end_turn' ||
    n === 'add_message' ||
    n === 'set_messages' ||
    n === 'set_output' ||
    n === 'spawn_agents' ||
    n === 'spawn_agent_inline' ||
    n === 'run_file_change_hooks' ||
    n === 'run_targeted_validation'
  )
}

/* ─── Transcript building (mirrors the renderer's chat-item logic) ─── */

type Accum = {
  changedFiles: FileChange[]
  runningToolIndex: number
}

const accums = new Map<string, Accum>()

function accumOf(taskId: string): Accum {
  let a = accums.get(taskId)
  if (!a) {
    a = { changedFiles: [], runningToolIndex: -1 }
    accums.set(taskId, a)
  }
  return a
}

function lastIsAssistant(entry: SessionEntry): boolean {
  const last = entry.transcript[entry.transcript.length - 1]
  return Boolean(last && last.kind === 'assistant')
}

function pushSystem(entry: SessionEntry, text: string): void {
  entry.transcript.push({ kind: 'system', text })
}

/**
 * Apply a normalized SDK event to the session transcript.
 * The logic mirrors the renderer's event handler so persisted transcripts look
 * identical to what the user saw live.
 */
export function applyEvent(taskId: string, ev: StoreEvent): void {
  const entry = sessions.get(taskId)
  if (!entry) return
  switch (ev.type) {
    case 'stream': {
      const chunk = ev.text ?? ''
      if (!chunk) return
      if (lastIsAssistant(entry)) {
        const last = entry.transcript[entry.transcript.length - 1]
        last.text = (last.text ?? '') + chunk
      } else {
        entry.transcript.push({ kind: 'assistant', text: chunk })
      }
      persistSoon(entry)
      return
    }
    case 'reasoning_stream':
    case 'reasoning_delta': {
      const delta = ev.text ?? ''
      if (!delta) return
      if (lastIsAssistant(entry)) {
        const last = entry.transcript[entry.transcript.length - 1]
        last.reasoning = (last.reasoning ?? '') + delta
      } else {
        entry.transcript.push({ kind: 'assistant', text: '', reasoning: delta })
      }
      persistSoon(entry)
      return
    }
    case 'tool_call':
    case 'tool_start': {
      if (isSilentTool(ev.toolName)) return
      if (ev.changedFiles?.length) {
        accumOf(taskId).changedFiles.push(...ev.changedFiles)
      }
      const tool: NonNullable<TaskMessage['tool']> = {
        toolName: ev.toolName ?? 'tool',
        status: 'running',
        agentType: ev.agentType,
        todos: ev.toolName === 'write_todos' && Array.isArray(ev.todos) ? ev.todos : undefined
      }
      entry.transcript.push({ kind: 'tool', tool })
      accumOf(taskId).runningToolIndex = entry.transcript.length - 1
      persistSoon(entry)
      return
    }
    case 'tool_result': {
      if (isSilentTool(ev.toolName)) return
      const acc = accumOf(taskId)
      const idx = acc.runningToolIndex
      acc.runningToolIndex = -1
      const item = idx >= 0 ? entry.transcript[idx] : undefined
      if (item && item.kind === 'tool' && item.tool) {
        item.tool = { ...item.tool, status: 'done', detail: ev.message ?? ev.status ?? item.tool.status }
      }
      persistSoon(entry)
      return
    }
    case 'subagent_start': {
      const agentType = ev.agentType ?? 'subagent'
      entry.transcript.push({
        kind: 'tool',
        tool: { toolName: `agent:${agentType}`, status: 'running', agentType, detail: ev.message }
      })
      persistSoon(entry)
      return
    }
    case 'subagent_stream': {
      const agentType = ev.agentType
      const text = ev.text ?? ''
      if (!text || !agentType) return
      for (let i = entry.transcript.length - 1; i >= 0; i--) {
        const item = entry.transcript[i]
        if (item.kind === 'tool' && item.tool && item.tool.agentType === agentType && item.tool.status === 'running') {
          item.tool = { ...item.tool, detail: (item.tool.detail ?? '') + text }
          break
        }
      }
      persistSoon(entry)
      return
    }
    case 'subagent_finish': {
      const agentType = ev.agentType
      if (!agentType) return
      for (let i = entry.transcript.length - 1; i >= 0; i--) {
        const item = entry.transcript[i]
        if (item.kind === 'tool' && item.tool && item.tool.agentType === agentType && item.tool.status === 'running') {
          item.tool = { ...item.tool, status: 'done', detail: ev.message || item.tool.detail || 'Completed' }
          break
        }
      }
      persistSoon(entry)
      return
    }
    case 'context_compaction': {
      // Make context compaction visible instead of looking like amnesia.
      const action = String((ev as unknown as Record<string, unknown>).action ?? '')
      const note =
        action === 'mechanical_trim'
          ? 'Older tool outputs were trimmed to fit the context window.'
          : 'Earlier messages were summarized to fit the context window.'
      entry.transcript.push({ kind: 'compaction', text: note })
      return
    }
    case 'finish': {
      // Append the per-turn file-changes summary (mirrors the renderer).
      const acc = accumOf(taskId)
      const changedFiles = acc.changedFiles
      if (changedFiles.length > 0) {
        // Deduplicate by path, keeping the most severe action.
        const actionPriority: Record<string, number> = { delete: 3, create: 2, modify: 1 }
        const deduped = new Map<string, FileChange>()
        for (const fc of changedFiles) {
          const existing = deduped.get(fc.path)
          if (!existing || (actionPriority[fc.action] ?? 0) > (actionPriority[existing.action] ?? 0)) {
            deduped.set(fc.path, fc)
          }
        }
        entry.transcript.push({ kind: 'file-changes', files: Array.from(deduped.values()) })
      }
      acc.changedFiles = []
      persistNow(entry)
      return
    }
    case 'error': {
      if (ev.message) pushSystem(entry, ev.message)
      persistSoon(entry)
      return
    }
    default:
      return
  }
}

/** A new user turn: append the user message plus an empty assistant placeholder. */
export function beginUserTurn(taskId: string, displayText: string): void {
  const entry = sessions.get(taskId)
  if (!entry) return
  entry.transcript.push({ kind: 'user', text: displayText })
  entry.transcript.push({ kind: 'assistant', text: '' })
  persistNow(entry)
}

/** Resume turn: the user prompt already exists in history; just open a new bubble. */
export function beginResumeTurn(taskId: string): void {
  const entry = sessions.get(taskId)
  if (!entry) return
  entry.transcript.push({ kind: 'assistant', text: '' })
  persistNow(entry)
}

/* ─── Persistence ─── */

const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
const FLUSH_DELAY_MS = 800

function persistSoon(entry: SessionEntry): void {
  const existing = flushTimers.get(entry.taskId)
  if (existing) return
  const timer = setTimeout(() => {
    flushTimers.delete(entry.taskId)
    persistNow(entry)
  }, FLUSH_DELAY_MS)
  flushTimers.set(entry.taskId, timer)
}

function persistNow(entry: SessionEntry): void {
  try {
    saveTaskTranscript(entry.taskId, entry.transcript)
  } catch {
    // best-effort; never kill a run over persistence
  }
}

function clearFlushTimer(taskId: string): void {
  const timer = flushTimers.get(taskId)
  if (timer) {
    clearTimeout(timer)
    flushTimers.delete(taskId)
  }
}

/* ─── Session lifecycle ─── */

/**
 * Return the in-memory session for a task, or create one. When no in-memory
 * entry exists (app restart / first touch of a historical task), seed it from
 * disk so continuing an old conversation keeps full context.
 */
export function getOrCreateSession(cwd: string, title: string, taskId?: string): SessionEntry {
  const record = ensureProjectTask(cwd, title, taskId)
  const existing = sessions.get(record.id)
  if (existing) return existing

  // Seed from disk when available (historical conversation continuation).
  const diskTranscript = loadTaskTranscript(record.id) ?? []
  const entry: SessionEntry = {
    taskId: record.id,
    cwd,
    transcript: diskTranscript,
    runState: loadTaskRunState(record.id),
    status: 'idle'
  }
  sessions.set(record.id, entry)
  return entry
}

export function getSession(taskId: string): SessionEntry | undefined {
  return sessions.get(taskId)
}

/** Mark the session running and remember it as the single active run. */
export function markRunning(taskId: string): void {
  const entry = sessions.get(taskId)
  if (entry) entry.status = 'running'
  runningTaskId = taskId
}

/**
 * Finalize a finished run: store + persist the run state, drop stale
 * checkpoints on success, and guarantee one final transcript flush.
 */
export function finishRun(
  taskId: string,
  runState: unknown | null,
  opts: { interrupted: boolean; errorMessage?: string; silentError?: boolean }
): void {
  clearFlushTimer(taskId)
  const entry = sessions.get(taskId)
  if (entry) {
    // Drop a trailing empty assistant placeholder (no content arrived).
    const last = entry.transcript[entry.transcript.length - 1]
    if (last && last.kind === 'assistant' && !last.text && !last.reasoning) {
      entry.transcript.pop()
    }
    // silentError: persist the failure state without printing the raw error —
    // used by auto-retry attempts that may succeed on the next try.
    if (opts.interrupted && opts.errorMessage && !opts.silentError) {
      pushSystem(entry, opts.errorMessage)
    }

    // Never regress to null: an unexpected failure keeps whatever preserved
    // state existed before so the conversation can still be resumed.
    if (runState !== null && runState !== undefined) {
      entry.runState = runState
      saveTaskRunState(taskId, runState)
    }
    entry.status = opts.interrupted ? 'interrupted' : 'idle'

    persistNow(entry)
  }
  if (!opts.interrupted) {
    // Success: the run state now contains everything up to the last completed
    // turn; any older mid-turn checkpoint would only regress recovery.
    deleteTaskCheckpoint(taskId)
  }
  if (runningTaskId === taskId) runningTaskId = null
}

export function isTaskRunning(taskId: string): boolean {
  return runningTaskId === taskId
}

export function getRunningTaskId(): string | null {
  return runningTaskId
}

export function hasActiveRun(): boolean {
  return runningTaskId !== null
}

/** Forget an in-memory session (task deleted). Refuses while its run is active. */
export function dropSession(taskId: string): boolean {
  if (runningTaskId === taskId) return false
  clearFlushTimer(taskId)
  accums.delete(taskId)
  sessions.delete(taskId)
  return true
}

/* ─── Recovery & snapshots ─── */

interface RunStateLike {
  sessionState?: { mainAgentState?: unknown } & Record<string, unknown>
  output?: { type?: string; message?: string; error?: string }
}

function isErrorOutput(runState: unknown): boolean {
  const rs = runState as RunStateLike | null
  return Boolean(rs && typeof rs === 'object' && rs.output?.type === 'error')
}

function errorOutputMessage(runState: unknown): string | undefined {
  const rs = runState as RunStateLike | null
  if (!rs?.output) return undefined
  return [rs.output.message, rs.output.error].filter((v): v is string => typeof v === 'string' && v.length > 0).join(' ') || undefined
}

/**
 * Build the best available previousRun for continuing a conversation:
 * memory → disk runstate → disk runstate with a fresher mid-turn checkpoint
 * spliced in (crash recovery). Returns null when nothing is available.
 */
export function buildResumableState(taskId: string): { previousRun: unknown; source: 'memory' | 'runstate' | 'checkpoint'; errorMessage?: string } | null {
  const memory = sessions.get(taskId)?.runState
  if (memory) return { previousRun: memory, source: 'memory', errorMessage: errorOutputMessage(memory) }

  const disk = loadTaskRunState(taskId)
  if (!disk) return null

  const { runStateMtime, checkpointMtime } = getRecoveryFileInfo(taskId)
  if (checkpointMtime !== null && checkpointMtime > (runStateMtime ?? 0)) {
    // Upstream onStateSnapshot yields a COMPLETE RunState (prompt + completed
    // steps + interruption note) designed to be fed back as previousRun —
    // no splicing needed; prefer it wholesale when fresher than disk state.
    const snapshot = loadTaskCheckpoint(taskId)
    if (snapshot && (snapshot as RunStateLike)?.sessionState) {
      return { previousRun: snapshot, source: 'checkpoint', errorMessage: errorOutputMessage(snapshot) }
    }
  }
  return { previousRun: disk, source: 'runstate', errorMessage: errorOutputMessage(disk) }
}

/** Classify a failure message into a short reason key (mirrors the renderer). */
export function classifyFailure(rawMessage: string): string {
  const lower = rawMessage.toLowerCase()
  if (/abort|aborted|cancelled|canceled/.test(lower) && !/quota|rate/.test(lower)) return 'stopped'
  if (/quota|rate limit|rate_limit|429/.test(lower)) return 'rate-limit'
  if (/invalid api key|unauthorized|401|403|authentication|auth/i.test(lower)) return 'auth'
  if (/timed out|timeout/.test(lower)) return 'timeout'
  if (/network|fetch failed|socket|econnreset|econnrefused|enotfound|etimedout|connection interrupted|closed unexpectedly|no data was received/i.test(lower)) return 'network'
  return 'error'
}

/** Extract plain text from an SDK message content value (string | parts array). */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p && typeof p === 'object') {
          const rec = p as Record<string, unknown>
          if (rec.type === 'text' && typeof rec.text === 'string') return rec.text
        }
        return ''
      })
      .join('')
  }
  return ''
}

/**
 * Remove the last user turn — and everything after it — from both the
 * transcript and the SDK run state's messageHistory. Used by Revert so the
 * conversation keeps its earlier context instead of being wiped wholesale.
 * Returns false when the turn cannot be located (caller decides fallback).
 */
export function trimLastTurn(taskId: string, userText: string): boolean {
  const entry = sessions.get(taskId)
  if (!entry) return false
  const needle = userText.trim().slice(0, 120)
  if (!needle) return false

  // 1) Transcript: find the last user message containing the text; cut there.
  let cutIdx = -1
  for (let i = entry.transcript.length - 1; i >= 0; i--) {
    const item = entry.transcript[i]
    if (item.kind === 'user' && typeof item.text === 'string' && item.text.includes(needle)) {
      cutIdx = i
      break
    }
  }
  if (cutIdx < 0) return false
  entry.transcript.length = cutIdx

  // 2) SDK run state: truncate messageHistory before the matching user message
  //    so the next turn continues from the prior context without the reverted one.
  if (entry.runState && typeof entry.runState === 'object') {
    const rs = entry.runState as { sessionState?: { mainAgentState?: { messageHistory?: unknown[] } & Record<string, unknown> } & Record<string, unknown> }
    const history = rs.sessionState?.mainAgentState?.messageHistory
    if (Array.isArray(history)) {
      let hIdx = -1
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i] as { role?: string; content?: unknown } | null
        if (!m || m.role !== 'user') continue
        if (messageText(m.content).includes(needle)) {
          hIdx = i
          break
        }
      }
      if (hIdx >= 0) history.length = hIdx
      saveTaskRunState(taskId, entry.runState)
    }
  }

  persistNow(entry)
  return true
}

/**
 * Snapshot of a task's view state for the renderer (re-attach after navigation
 * or app restart). Reads through the in-memory session when present, otherwise
 * reconstructs from disk.
 */
export function getSessionSnapshot(taskId: string): TaskViewSnapshot {
  const entry = sessions.get(taskId)
  if (entry) {
    const resumable = entry.status !== 'running' && isErrorOutput(entry.runState)
    const message = resumable ? errorOutputMessage(entry.runState) : undefined
    return {
      exists: true,
      cwd: entry.cwd,
      transcript: entry.transcript,
      status: entry.status,
      canResume: resumable,
      resumeReason: resumable ? classifyFailure(message ?? '') : undefined,
      resumeErrorMessage: message
    }
  }

  const transcript = loadTaskTranscript(taskId)
  const runState = loadTaskRunState(taskId)
  if (transcript === null && runState === null) {
    return { exists: false, transcript: [], status: 'idle', canResume: false }
  }

  const interrupted = runState !== null && isErrorOutput(runState)
  const message = interrupted ? errorOutputMessage(runState) : undefined

  // Crash recovery: a checkpoint newer than the saved run state means the app
  // died mid-turn — offer resume even though the last completed turn succeeded.
  const { runStateMtime, checkpointMtime } = getRecoveryFileInfo(taskId)
  const checkpointFresher =
    checkpointMtime !== null && runStateMtime !== null && checkpointMtime > runStateMtime
  const crashedMidTurn = checkpointFresher && runState !== null && !interrupted

  return {
    exists: true,
    transcript: transcript ?? [],
    status: interrupted || crashedMidTurn ? 'interrupted' : 'idle',
    canResume: interrupted || (crashedMidTurn && Boolean(loadTaskCheckpoint(taskId))),
    resumeReason: interrupted || crashedMidTurn ? classifyFailure(message ?? '') : undefined,
    resumeErrorMessage: message,
    resumeSource: checkpointFresher ? 'checkpoint' : 'runstate'
  }
}
