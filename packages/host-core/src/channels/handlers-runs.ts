/**
 * Run-lifecycle handlers (AnyBuff:runPrompt / abort / approvalResponse /
 * respondAskUser).
 *
 * Ported verbatim from the Electron shell's registerIpc(). runPrompt keeps the
 * session-store orchestration (record creation + begin + startRun) on the host
 * side so a headless/WS shell gets identical run semantics.
 */

import { startRun, abortRun, isRunning, respondApproval, respondAskUser } from '../run/start-run'
import { getOrCreateSession } from '../sessions/session-store'
import { applySettingsToEnv } from '../settings/settings'

export interface RunPromptPayload {
  cwd: string
  prompt: string
  displayText?: string
  taskId?: string
  resume?: boolean
  mode?: 'default' | 'plan' | 'chat'
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
  })
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
