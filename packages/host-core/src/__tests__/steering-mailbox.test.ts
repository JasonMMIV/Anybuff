/**
 * ADR-30 mid-turn steering mailbox — claim/accept + owner-guard semantics
 * (mirrors upstream cli/src/utils/steering-buffer.ts, which this module is
 * the host-side port of).
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  activateSteering,
  deactivateSteering,
  pushSteeringMessage,
  isSteeringActive,
  drainSteeringMessages,
  __resetSteeringForTests,
} from '../run/steering-mailbox'

beforeEach(() => {
  __resetSteeringForTests()
})

describe('steering mailbox (ADR-30)', () => {
  test('push without an active run is refused', () => {
    expect(isSteeringActive()).toBe(false)
    expect(pushSteeringMessage({ pushId: 'p1', text: 'hi' })).toBe(false)
  })

  test('activate opens the mailbox; push is accepted and drained FIFO', () => {
    activateSteering('run-1')
    expect(isSteeringActive()).toBe(true)
    expect(pushSteeringMessage({ pushId: 'p1', text: 'first' })).toBe(true)
    expect(pushSteeringMessage({ pushId: 'p2', text: 'second' })).toBe(true)
    expect(drainSteeringMessages('run-1')).toEqual(['first', 'second'])
    // Drained is emptied.
    expect(drainSteeringMessages('run-1')).toEqual([])
  })

  test('drain is owner-guarded: a stale owner gets nothing and cannot empty the buffer', () => {
    activateSteering('run-1')
    pushSteeringMessage({ pushId: 'p1', text: 'kept' })
    expect(drainSteeringMessages('run-2')).toEqual([])
    expect(drainSteeringMessages('run-1')).toEqual(['kept'])
  })

  test('deactivate is owner-guarded: only the owning run sees its leftovers', () => {
    activateSteering('run-1')
    pushSteeringMessage({ pushId: 'p1', text: 'late' })
    // A stale settle must not reap the owner run's buffer: owner mismatch →
    // [] and the buffer stays put (still drainable by the owner).
    expect(deactivateSteering('run-old')).toEqual([])
    expect(drainSteeringMessages('run-1')).toEqual(['late'])
    // Drain again after a fresh push (the drain path is idempotent-empty).
    pushSteeringMessage({ pushId: 'p2', text: 'late2' })
    // The real owner's settle reaps the leftovers and empties the buffer.
    expect(deactivateSteering('run-1')).toEqual([{ pushId: 'p2', text: 'late2' }])
    expect(isSteeringActive()).toBe(false)
    expect(pushSteeringMessage({ pushId: 'p3', text: 'again' })).toBe(false)
  })

  test('deactivate after a new run started does NOT hand it stale entries', () => {
    activateSteering('run-1')
    pushSteeringMessage({ pushId: 'p1', text: 'stale' })
    activateSteering('run-2') // run-2's activate resets the buffer
    expect(deactivateSteering('run-1')).toEqual([])
    expect(drainSteeringMessages('run-2')).toEqual([])
  })

  test('re-activating the SAME owner (retry attempt) preserves undrained entries', () => {
    activateSteering('run-1')
    pushSteeringMessage({ pushId: 'p1', text: 'pushed before the failure' })
    // startRun's retry loop re-activates with the same owner id — the buffer
    // must survive so the fresh attempt drains it (not stranded as echoes).
    activateSteering('run-1')
    expect(isSteeringActive()).toBe(true)
    expect(drainSteeringMessages('run-1')).toEqual(['pushed before the failure'])
  })

  test('abort path: entries left in the mailbox survive until the owner settles', () => {
    activateSteering('run-1')
    pushSteeringMessage({ pushId: 'p1', text: 'visible' })
    // The run's drain hook returns [] while aborted — entries stay queued.
    // (start-run checks currentAbort.signal.aborted before calling drain.)
    expect(drainSteeringMessages('another-owner')).toEqual([])
    expect(deactivateSteering('run-1')).toEqual([{ pushId: 'p1', text: 'visible' }])
  })
})
