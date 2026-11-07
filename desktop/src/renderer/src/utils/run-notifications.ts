/**
 * Terminal-run notification helpers.
 *
 * A run can end (or be interrupted) in a background tab. The renderer only
 * wants to surface each terminal transition once even if the host re-emits it
 * while reconnecting, so the key is `runId + terminal`; the task id is a
 * fallback for old hosts that do not send a runId yet.
 */

export interface TerminalRunEvent {
  runId?: string
  taskId?: string
  status?: string
}

/** `null` for non-terminal statuses (running / auto-retry / unknown). */
export function terminalRunKey(event: TerminalRunEvent): string | null {
  if (event.status !== 'idle' && event.status !== 'interrupted') return null
  const owner = event.runId || event.taskId
  if (!owner) return null
  return `${owner}:${event.status}`
}

/** Human-readable body for the desktop notification. */
export function terminalRunBody(title: string | undefined, status: string): string {
  const label = title?.trim() || 'Task'
  return status === 'interrupted'
    ? `${label} needs attention — the run stopped.`
    : `${label} finished.`
}

/** Notification heading. Kept short so Windows/macOS toasts stay readable. */
export function terminalRunHeading(status: string): string {
  return status === 'interrupted' ? 'Run interrupted' : 'Run finished'
}
