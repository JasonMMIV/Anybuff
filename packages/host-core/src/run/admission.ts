/** Identity fields the admission policy needs from an active run. */
export interface ActiveRunIdentity {
  taskId: string
}

export type RunAdmission =
  | { ok: true }
  | { ok: false; code: 'task-busy'; runningTaskId: string }

/**
 * Concurrency policy:
 *   - one run per task (a conversation is linear);
 *   - NO per-project (cwd) limit — users may run e.g. Build and Plan on the
 *     same working tree at the same time. Work-tree conflicts are the user's
 *     responsibility (diff/revert attribution, file hooks, builds).
 *
 * There is deliberately no global process cap either. `taskId` is omitted
 * only while creating a brand-new task; a new task is always admitted.
 *
 * This function is pure so the policy is unit-testable without the SDK or the
 * registry. The caller must keep admission → registration in one synchronous
 * section (no await) to avoid a race where two prompts for the same task both
 * pass the check.
 */
export function resolveRunAdmission(input: {
  taskId?: string
  runs: readonly ActiveRunIdentity[]
}): RunAdmission {
  if (input.taskId) {
    const sameTask = input.runs.find((run) => run.taskId === input.taskId)
    if (sameTask) {
      return { ok: false, code: 'task-busy', runningTaskId: sameTask.taskId }
    }
  }

  return { ok: true }
}
