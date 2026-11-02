/**
 * Maps an activity event to its icon/label. Pure and unit-tested because the
 * same `type` carries opposite outcomes: `context_compaction` covers a real
 * compaction AND a skipped manual `/compact` (ADR-37).
 */

const EVENT_META: Record<string, { icon: string; label: string }> = {
  start: { icon: '▶', label: 'Started' },
  finish: { icon: '✓', label: 'Finished' },
  subagent_start: { icon: '◈', label: 'Sub-agent started' },
  subagent_finish: { icon: '◇', label: 'Sub-agent finished' },
  tool_start: { icon: '⚙', label: 'Running tool' },
  tool_call: { icon: '⚙', label: 'Tool call' },
  tool_result: { icon: '▤', label: 'Tool result' },
  phase: { icon: '≋', label: 'Phase' },
  error: { icon: '✕', label: 'Error' },
  download: { icon: '↓', label: 'Download' },
  provider_status: { icon: '⇄', label: 'Provider' },
  job_update: { icon: '⚙', label: 'Job update' },
}

const FALLBACK_ICON = '·'

export function metaForEvent(event: {
  type: string
  action?: string
}): { icon: string; label: string } {
  if (event.type === 'context_compaction') {
    if (event.action === 'compact_skipped') {
      return { icon: '⏸', label: 'Compaction skipped' }
    }
    if (event.action === 'mechanical_trim') {
      return { icon: '□', label: 'Context trimmed' }
    }
    return { icon: '□', label: 'Context compacted' }
  }
  return EVENT_META[event.type] ?? { icon: FALLBACK_ICON, label: event.type }
}
