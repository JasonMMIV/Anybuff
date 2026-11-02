import type { UiEvent } from '../../../preload'

/** Wire action for a skipped manual `/compact` (ADR-37). */
export const COMPACT_SKIPPED_ACTION = 'compact_skipped'

export type CompactionNote =
  { kind: 'system'; text: string } | { kind: 'compaction'; text: string }

/**
 * Map a `context_compaction` UiEvent to the transcript row the renderer shows.
 * Kept pure so the live event handler and tests agree on all three cases.
 *
 * The skipped note is a system row (it is an outcome the user must notice).
 * The other two are informational compaction notes.
 */
export function compactionNote(
  event: Pick<UiEvent, 'action' | 'message'>,
): CompactionNote {
  if (event.action === 'mechanical_trim') {
    return {
      kind: 'compaction',
      text: 'Older tool outputs were trimmed to fit the context window.',
    }
  }
  if (event.action === COMPACT_SKIPPED_ACTION) {
    return {
      kind: 'system',
      text: event.message?.trim() || 'Conversation history was preserved.',
    }
  }
  return {
    kind: 'compaction',
    text: 'Earlier messages were summarized to fit the context window.',
  }
}
