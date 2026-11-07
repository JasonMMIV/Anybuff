/**
 * Run-lifecycle handlers (AnyBuff:runPrompt / sendNow / abort /
 * approvalResponse / respondAskUser).
 *
 * P1 keeps the old call signatures working while adding optional run/task
 * targeting: the renderer is still single-run for now, but the host no longer
 * treats the process as having exactly one run.
 */

import { startRun, abortRun, respondApproval, respondAskUser } from '../run/start-run'
import { pushSteeringMessageFor, isSteeringActive } from '../run/steering-mailbox'
import { getRunByTaskId, listRuns } from '../run/run-registry'
import { resolveRunAdmission } from '../run/admission'
import { resolveProjectKey } from '../run/project-key'
import {
  beginSteeringTurn,
  retractSteeringEcho,
  getOrCreateSession,
} from '../sessions/session-store'
import { applySettingsToEnv } from '../settings/settings'

export interface RunPromptPayload {
  cwd: string
  prompt: string
  displayText?: string
  taskId?: string
  resume?: boolean
  mode?: 'default' | 'plan' | 'chat'
  /** #4 base64 image parts (see contracts/types.ts RunImagePart). */
  content?: Array<{ type: 'image'; image: string; mediaType: string }>
}

/** AnyBuff:runPrompt */
export async function runPrompt(payload: RunPromptPayload): Promise<unknown> {
  if (!payload.cwd || !payload.prompt.trim()) {
    return { ok: false, error: 'Missing project folder or prompt' }
  }

  const taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : undefined
  const projectKey = await resolveProjectKey(payload.cwd)

  // Fast, non-authoritative pre-check before creating a task record or
  // rewriting anybuff.json. startRun repeats admission atomically with the
  // registry, so two prompts for the same task racing here still cannot both
  // start. A different task in the same project is intentionally admitted.
  const pre = resolveRunAdmission({ taskId, runs: listRuns() })
  if (!pre.ok) {
    return {
      ok: false,
      error: 'Another task is already running',
      code: pre.code,
      runningTaskId: pre.runningTaskId,
    }
  }

  // Single write point for the provider config (the old code wrote it again
  // inside startRun). Skipped entirely when admission rejects above.
  applySettingsToEnv()

  // One record per conversation: reuse the provided task or create a new one.
  // The record title comes from what the user typed (not the expanded prompt).
  const title = (payload.displayText ?? payload.prompt).trim().slice(0, 300)
  const entry = getOrCreateSession(payload.cwd, title, taskId)

  return await startRun({
    cwd: payload.cwd,
    projectKey,
    prompt: payload.prompt,
    displayText: payload.displayText ?? payload.prompt,
    taskId: entry.taskId,
    resume: payload.resume === true,
    mode: payload.mode,
    content: payload.content,
  })
}

/** AnyBuff:sendNow payload (ADR-30 mid-turn steering). */
export interface SendNowPayload {
  /** Raw user text. Steered messages are handed to the engine verbatim —
   *  never through buildFinalPrompt baking. */
  text: string
  /** Address a specific conversation. Omitted is allowed only when exactly
   *  one run is active (legacy single-run clients). */
  taskId?: string
}

/**
 * AnyBuff:sendNow — the host-side steering gate. Accept only when the target
 * run is active AND the payload is a plain, non-empty text message. The echo
 * lands in the target run's transcript; a leftover is retracted by startRun's
 * settleSteering and reported back as steeredLeftovers.
 */
export function sendNowChannel(payload: SendNowPayload): unknown {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  if (!text) return { ok: false, error: 'Empty steering message' }

  const runs = listRuns()
  const run = payload.taskId
    ? getRunByTaskId(payload.taskId)
    : runs.length === 1
      ? runs[0]
      : undefined

  if (!run) {
    if (!payload.taskId && runs.length > 1) {
      return {
        ok: false,
        code: 'ambiguous-target',
        error: 'More than one run is active — specify taskId.',
      }
    }
    return { ok: false, error: 'No active run to steer' }
  }
  if (run.abort.signal.aborted) {
    return { ok: false, error: 'The run is already stopping' }
  }
  if (!isSteeringActive(run.steeringOwnerId)) {
    return { ok: false, error: 'No run is accepting steering' }
  }

  const pushId = `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // Echo first (transcript row carries the pushId marker), then enqueue.
  if (!beginSteeringTurn(run.taskId, pushId, text)) {
    return { ok: false, error: 'Unknown task' }
  }
  const accepted = pushSteeringMessageFor(run.steeringOwnerId, { pushId, text })
  if (!accepted) {
    // Mailbox closed between our checks and now (run settled): retract the echo.
    retractSteeringEcho(run.taskId, [pushId])
    return { ok: false, error: 'The run just finished — your message was returned to sender' }
  }
  return { ok: true, pushId }
}

/** AnyBuff:abort — optional { taskId, runId }; no target only works for one run. */
export function abortRunChannel(payload?: { taskId?: string; runId?: string }): unknown {
  return abortRun(payload ?? {})
}

export interface ApprovalResponsePayload {
  approved?: boolean
  promptId?: string
  taskId?: string
  runId?: string
}

/** AnyBuff:approvalResponse — accepts a boolean (old) or a targeted object. */
export function approvalResponse(input: boolean | ApprovalResponsePayload): unknown {
  const approved = typeof input === 'boolean' ? input : input?.approved === true
  const target =
    typeof input === 'boolean'
      ? {}
      : { promptId: input.promptId, taskId: input.taskId, runId: input.runId }
  respondApproval(approved, target)
  // Legacy callers treat this as a fire-and-forget no-op outside a run.
  return { ok: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * AnyBuff:respondAskUser — accepts the old answers object or the P2 wrapper
 * `{ answers, promptId?, taskId?, runId? }`.
 */
export function respondAskUserChannel(payload: unknown): unknown {
  // The renderer's banner sends `{ answers }` or `{ skipped: true }`; P2
  // wraps either in promptId/taskId/runId for concurrent runs. Accept both
  // spellings and keep the legacy bare-answers payload working.
  const wrapped =
    isRecord(payload) &&
    ('answers' in payload || 'skipped' in payload) &&
    Object.keys(payload).every(
      (key) =>
        key === 'answers' ||
        key === 'skipped' ||
        key === 'promptId' ||
        key === 'taskId' ||
        key === 'runId'
    )

  const answers = wrapped
    ? (payload as Record<string, unknown>).skipped === true
      ? { skipped: true }
      : (payload as Record<string, unknown>).answers
    : payload
  const target = wrapped
    ? {
        promptId: asString((payload as Record<string, unknown>).promptId),
        taskId: asString((payload as Record<string, unknown>).taskId),
        runId: asString((payload as Record<string, unknown>).runId),
      }
    : {}

  respondAskUser(answers, target)
  return { ok: true }
}
