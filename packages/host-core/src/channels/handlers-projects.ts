/**
 * Project & task-history handlers (AnyBuff:listProjects / deleteTask /
 * renameTask / removeProject / getTaskView / trimTaskLastTurn / searchHistory).
 *
 * Ported verbatim from the Electron shell's registerIpc().
 */

import {
  listProjects as listProjectsFn,
  deleteTask as deleteTaskFn,
  renameTask as renameTaskFn,
  removeProject as removeProjectFn,
  searchHistory as searchHistoryFn,
} from '../settings/settings'
import {
  getSessionSnapshot,
  isTaskRunning,
  dropSession,
  trimLastTurn,
} from '../sessions/session-store'
import { getAppSettings } from '../settings/settings'

/** AnyBuff:listProjects */
export function listProjects(): unknown {
  return listProjectsFn()
}

/** AnyBuff:deleteTask */
export function deleteTask(taskId: string): unknown {
  if (!taskId) return { ok: false, error: 'Missing taskId' }
  if (isTaskRunning(taskId)) return { ok: false, error: 'Stop the running task before deleting it.' }
  dropSession(taskId)
  deleteTaskFn(taskId)
  return { ok: true }
}

/** AnyBuff:renameTask */
export function renameTask(payload: { taskId: string; newPrompt: string }): unknown {
  if (!payload || typeof payload.taskId !== 'string' || typeof payload.newPrompt !== 'string') {
    return { ok: false, error: 'Invalid payload' }
  }
  const ok = renameTaskFn(payload.taskId, payload.newPrompt)
  return { ok }
}

/** AnyBuff:removeProject */
export function removeProject(projectPath: string): unknown {
  if (!projectPath) return { ok: false, error: 'Missing projectPath' }
  const project = getAppSettings().projects.find((p) => p.path === projectPath)
  const runningInside = (project?.tasks ?? []).some((t) => isTaskRunning(t.id))
  if (runningInside) {
    return { ok: false, error: 'Stop the running task before removing this project.' }
  }
  for (const t of project?.tasks ?? []) {
    dropSession(t.id)
  }
  const ok = removeProjectFn(projectPath)
  return { ok }
}

/** AnyBuff:getTaskView — full snapshot of a conversation. */
export function getTaskView(taskId: string): unknown {
  if (!taskId) return { ok: false, error: 'Missing taskId' }
  const snapshot = getSessionSnapshot(taskId)
  return { ok: true, ...snapshot }
}

/** AnyBuff:trimTaskLastTurn — revert support. */
export function trimTaskLastTurn(payload: { taskId: string; userText: string }): unknown {
  if (!payload?.taskId || !payload.userText) return { ok: false, error: 'Invalid payload' }
  if (isTaskRunning(payload.taskId)) return { ok: false, error: 'Stop the running task first.' }
  const ok = trimLastTurn(payload.taskId, payload.userText)
  return ok ? { ok: true } : { ok: false, error: 'Original turn not found in this conversation.' }
}

/** AnyBuff:searchHistory */
export async function searchHistory(query: string): Promise<unknown> {
  return await searchHistoryFn(query)
}
