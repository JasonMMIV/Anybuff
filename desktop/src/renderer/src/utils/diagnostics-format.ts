export type RunMode = 'default' | 'plan' | 'chat'

const RUN_MODE_LABELS: Record<RunMode, string> = {
  default: 'Build',
  plan: 'Plan',
  chat: 'Chat',
}

/** Short, human-readable task id for the diagnostics run list. */
export function shortTaskId(taskId: string): string {
  const trimmed = taskId.trim()
  if (!trimmed) return '—'
  return trimmed.length <= 8 ? trimmed : `${trimmed.slice(0, 8)}…`
}

/**
 * Compact elapsed time for a live run. `startedAt` is a Unix epoch in ms.
 * Invalid/missing timestamps render as an em dash.
 */
export function runModeLabel(mode: string): string {
  return RUN_MODE_LABELS[mode as RunMode] ?? mode
}

/** Last path segment only, safe to include in a copyable diagnostics report. */
export function projectBasename(cwd: string): string {
  const trimmed = cwd.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return '—'
  const parts = trimmed.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? '—'
}

export function formatRunDuration(startedAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0 || !Number.isFinite(now)) return '—'
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (totalSeconds < 1) return '<1s'
  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}
