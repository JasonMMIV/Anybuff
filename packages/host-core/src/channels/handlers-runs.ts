/**
 * Run-lifecycle handlers (AnyBuff:runPrompt / sendNow / abort /
 * approvalResponse / respondAskUser).
 *
 * Ported verbatim from the Electron shell's registerIpc(). runPrompt keeps the
 * session-store orchestration (record creation + begin + startRun) on the host
 * side so a headless/WS shell gets identical run semantics.
 */

import { startRun, abortRun, isRunning, respondApproval, respondAskUser } from '../run/start-run'
import { isSteeringActive, pushSteeringMessage } from '../run/steering-mailbox'
import {
  getRunningTaskId,
  hasActiveRun,
  beginSteeringTurn,
  retractSteeringEcho,
  getOrCreateSession
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
    mode: payload.mode,
    content: payload.content,
  })
}

/** AnyBuff:sendNow payload (ADR-30 mid-turn steering). */
export interface SendNowPayload {
  /** Raw user text. Steered messages are handed to the engine verbatim —
   *  never through buildFinalPrompt baking (the gate already excludes
   *  attachments; that baking stays the queue path's behavior). */
  text: string
  /** Accepted for interface symmetry but NOT used for routing: the run is a
   *  per-process singleton and steering always addresses the ACTIVE run,
   *  whatever conversation the caller is viewing (ADR-30 單一 run 語意). */
  taskId?: string
}

/**
 * AnyBuff:sendNow — the host-side steering gate (mirrors the upstream
 * router): accept only when a run is active AND the payload is a plain,
 * non-empty text message. The push-time user echo lands in the ACTIVE run's
 * transcript; a leftover is retracted by startRun's settleSteering and
 * reported back as steeredLeftovers.
 */
export function sendNowChannel(payload: SendNowPayload): unknown {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  if (!text) return { ok: false, error: 'Empty steering message' }
  if (!hasActiveRun() || !isRunning()) return { ok: false, error: 'No active run to steer' }
  if (!isSteeringActive()) return { ok: false, error: 'No run is accepting steering' }
  // Steering always addresses the active run: use the run's own task id so
  // the echo lands in the run's transcript, whatever view the user is on.
  const runTaskId = getRunningTaskId()
  if (!runTaskId) return { ok: false, error: 'No active run to steer' }
  const pushId = `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // Echo first (transcript row carries the pushId marker), then enqueue.
  if (!beginSteeringTurn(runTaskId, pushId, text)) {
    return { ok: false, error: 'Unknown task' }
  }
  const accepted = pushSteeringMessage({ pushId, text })
  if (!accepted) {
    // Mailbox closed between our checks and now (run settled): retract the echo.
    retractSteeringEcho(runTaskId, [pushId])
    return { ok: false, error: 'The run just finished — your message was returned to sender' }
  }
  return { ok: true, pushId }
}

/** AnyBuff:abort */
export function abortRunChannel(): unknown {
  abortRun()
  return { ok: true }
}

/** AnyBuff:approvalResponse */
export function approvalResponse(approved: boolean): unknown {
  respondApproval(approved === true)
  return { ok: true }
}

/** AnyBuff:respondAskUser */
export function respondAskUserChannel(payload: unknown): unknown {
  respondAskUser(payload)
  return { ok: true }
}
