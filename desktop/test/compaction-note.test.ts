/**
 * Renderer-side mapping for `context_compaction` events (ADR-37): the
 * `compact_skipped` action must render as a visible system note, not as a
 * normal "messages were summarized" informational row.
 */

import { describe, expect, test } from 'bun:test'

import {
  COMPACT_SKIPPED_ACTION,
  compactionNote,
} from '../src/renderer/src/utils/compaction-note'

describe('compactionNote', () => {
  test('mechanical trim stays an informational compaction note', () => {
    expect(compactionNote({ action: 'mechanical_trim' })).toEqual({
      kind: 'compaction',
      text: 'Older tool outputs were trimmed to fit the context window.',
    })
  })

  test('a skipped /compact becomes a system note carrying the runtime message', () => {
    expect(
      compactionNote({
        action: COMPACT_SKIPPED_ACTION,
        message: 'Your conversation history was kept.',
      }),
    ).toEqual({ kind: 'system', text: 'Your conversation history was kept.' })
  })

  test('a skipped /compact without a message still renders something useful', () => {
    expect(compactionNote({ action: COMPACT_SKIPPED_ACTION })).toEqual({
      kind: 'system',
      text: 'Conversation history was preserved.',
    })
    expect(
      compactionNote({ action: COMPACT_SKIPPED_ACTION, message: '   ' }),
    ).toEqual({
      kind: 'system',
      text: 'Conversation history was preserved.',
    })
  })

  test('other compaction actions keep the default informational note', () => {
    expect(compactionNote({ action: 'overflow_resume' })).toEqual({
      kind: 'compaction',
      text: 'Earlier messages were summarized to fit the context window.',
    })
  })
})
