import { describe, expect, test } from 'bun:test'

import { metaForEvent } from '../src/renderer/src/utils/activity-meta'

describe('metaForEvent', () => {
  test('a skipped manual /compact is not labelled as a compaction', () => {
    expect(
      metaForEvent({ type: 'context_compaction', action: 'compact_skipped' }),
    ).toEqual({ icon: '⏸', label: 'Compaction skipped' })
  })

  test('mechanical trim has its own label', () => {
    expect(
      metaForEvent({ type: 'context_compaction', action: 'mechanical_trim' }),
    ).toEqual({ icon: '□', label: 'Context trimmed' })
  })

  test('a real compaction keeps the compaction label', () => {
    expect(metaForEvent({ type: 'context_compaction' })).toEqual({
      icon: '□',
      label: 'Context compacted',
    })
    expect(
      metaForEvent({ type: 'context_compaction', action: 'overflow_resume' }),
    ).toEqual({ icon: '□', label: 'Context compacted' })
  })

  test('non-compaction events keep their labels', () => {
    expect(metaForEvent({ type: 'tool_call' })).toEqual({
      icon: '⚙',
      label: 'Tool call',
    })
  })

  test('unknown events fall back to the raw type', () => {
    expect(metaForEvent({ type: 'mystery' })).toEqual({
      icon: '·',
      label: 'mystery',
    })
  })
})
