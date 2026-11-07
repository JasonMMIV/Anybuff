/**
 * Pure per-task renderer state helpers.
 *
 * Concurrent runs mean every Set/Record keyed by task id must be updated
 * immutably and must return the SAME reference when nothing changed. Without
 * that, a terminal event from run B re-renders (and can reset) run A's view
 * state. These helpers keep the reducers tiny and testable.
 */

export function addTaskId(
  ids: ReadonlySet<string>,
  taskId: string | null | undefined
): ReadonlySet<string> {
  if (!taskId || ids.has(taskId)) return ids
  const next = new Set(ids)
  next.add(taskId)
  return next
}

export function removeTaskId(
  ids: ReadonlySet<string>,
  taskId: string | null | undefined
): ReadonlySet<string> {
  if (!taskId || !ids.has(taskId)) return ids
  const next = new Set(ids)
  next.delete(taskId)
  return next
}

export function setTaskValue<T>(
  values: Readonly<Record<string, T>>,
  taskId: string | null | undefined,
  value: T
): Record<string, T> {
  if (!taskId) return values as Record<string, T>
  if (Object.hasOwn(values, taskId) && values[taskId] === value) {
    return values as Record<string, T>
  }
  return { ...values, [taskId]: value }
}

export function dropTaskValue<T>(
  values: Readonly<Record<string, T>>,
  taskId: string | null | undefined
): Record<string, T> {
  if (!taskId || !Object.hasOwn(values, taskId)) return values as Record<string, T>
  const next = { ...values }
  delete next[taskId]
  return next
}

export function taskValue<T>(
  values: Readonly<Record<string, T>>,
  taskId: string | null | undefined
): T | undefined {
  return taskId ? values[taskId] : undefined
}

/**
 * A terminal event belongs to a run that has already been replaced on the
 * same task (duplicate/replayed terminal, or a late old run after a new one
 * started). Applying it would clear the newer run's spinner and attention.
 */
export function isStaleTerminalRun(
  knownRunId: string | undefined,
  eventRunId: string | undefined
): boolean {
  return Boolean(eventRunId && knownRunId && knownRunId !== eventRunId)
}
