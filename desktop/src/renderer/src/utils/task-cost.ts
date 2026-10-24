/**
 * Per-task cost display (UI side).
 *
 * The SDK reports `finish.totalCost` in CREDITS — `Math.round(dollars * 100)`,
 * i.e. integer cents for that prompt/run. It resets at the start of every
 * prompt, so a conversation's total is the sum of its runs' finish events.
 *
 * This module keeps that sum in memory, keyed by taskId, so a background run
 * never pollutes the visible conversation's number and switching back to an
 * already-run task (within this app session) still shows its accumulated cost.
 */

export type TaskCostMap = Record<string, number>

/** Add one run's credit cost to its task. Invalid/zero values are a no-op. */
export function addTaskCost(
  costs: TaskCostMap,
  taskId: string | undefined,
  credits: number | undefined
): TaskCostMap {
  if (!taskId) return costs
  if (typeof credits !== 'number' || !Number.isFinite(credits) || credits <= 0) return costs
  return { ...costs, [taskId]: (costs[taskId] ?? 0) + credits }
}

/** Forget a deleted task's cost (and only that task's). */
export function removeTaskCost(costs: TaskCostMap, taskId: string): TaskCostMap {
  if (!(taskId in costs)) return costs
  const next = { ...costs }
  delete next[taskId]
  return next
}

/** The viewed task's cost in USD (0 when unknown or not yet run). */
export function taskCostUsd(costs: TaskCostMap, taskId: string | null): number {
  if (!taskId) return 0
  const credits = costs[taskId]
  return credits && credits > 0 ? credits / 100 : 0
}
