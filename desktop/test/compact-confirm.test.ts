import { describe, expect, test } from 'bun:test'

import { compactConfirmState } from '../src/renderer/src/utils/compact-confirm'

describe('compactConfirmState', () => {
  test('can confirm when idle and the conversation has context', () => {
    expect(compactConfirmState({ used: 1_200, max: 200_000 })).toEqual({
      canConfirm: true,
    })
  })

  test('blocks an empty conversation', () => {
    expect(compactConfirmState({ used: 0, max: 200_000 })).toEqual({
      canConfirm: false,
      note: 'Nothing to compact yet.',
    })
  })

  test('blocks while a run is in flight', () => {
    expect(
      compactConfirmState({ used: 1_200, max: 200_000, running: true }),
    ).toEqual({
      canConfirm: false,
      note: 'Wait for the current run to finish.',
    })
  })
})
