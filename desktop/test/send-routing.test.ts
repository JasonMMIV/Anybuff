/**
 * ADR-30 send-routing gate — steer vs queue vs paused-dispatch decisions.
 *
 * Extracted from App.send()'s running branch so the queue-first default, the
 * upstream-parity fallback list (router.ts) and the leftover requeue order are
 * unit-testable without a DOM harness. The queue depth is deliberately NOT part
 * of the gate: an explicit Send now answers in the live turn even while other
 * messages wait in the queue.
 */

import { describe, test, expect } from 'bun:test'
import {
  canSteerRunningTurn,
  leftoverRequeueItems,
  type SteerGateInput
} from '../src/renderer/src/utils/send-routing'

const base: SteerGateInput = {
  sendNowIntent: true,
  text: 'try the blue theme instead',
  attachmentCount: 0,
  hasSendNowApi: true
}

describe('canSteerRunningTurn (ADR-30 send routing)', () => {
  test('an explicit Send now with plain text and an empty queue is steered', () => {
    expect(canSteerRunningTurn(base)).toBe(true)
  })

  test('without the explicit Send now intent (plain Enter) the submit queues', () => {
    expect(canSteerRunningTurn({ ...base, sendNowIntent: false })).toBe(false)
  })

  test('whitespace-only text is never steered', () => {
    expect(canSteerRunningTurn({ ...base, text: '   ' })).toBe(false)
  })

  test('a prebuilt prompt (slash command) falls back to the queue', () => {
    expect(canSteerRunningTurn({ ...base, prebuiltPrompt: '/init' })).toBe(false)
  })

  test('the interview wrapper falls back to the queue', () => {
    expect(canSteerRunningTurn({ ...base, interviewWrap: true })).toBe(false)
  })

  test('pending bash context baked into the prompt falls back to the queue', () => {
    expect(canSteerRunningTurn({ ...base, bashContext: '<user_terminal_commands>…</user_terminal_commands>' })).toBe(false)
  })

  test('attachments fall back to the queue', () => {
    expect(canSteerRunningTurn({ ...base, attachmentCount: 1 })).toBe(false)
  })

  test('bash drafts (!cmd) fall back to the queue', () => {
    expect(canSteerRunningTurn({ ...base, text: '!bun test' })).toBe(false)
  })

  test('slash drafts (/review …) fall back to the queue', () => {
    expect(canSteerRunningTurn({ ...base, text: '/review uncommitted' })).toBe(false)
  })

  test('a shell without the sendNow channel (browser preview / old preload) falls back', () => {
    expect(canSteerRunningTurn({ ...base, hasSendNowApi: false })).toBe(false)
  })
})

describe('leftoverRequeueItems (ADR-30 bubble-retract requeue)', () => {
  test('requeues at the front in FIFO order (reverse-of-arrival unshift)', () => {
    const items = leftoverRequeueItems([
      { pushId: 'steer-1', text: 'first steer' },
      { pushId: 'steer-2', text: 'second steer' }
    ])
    expect(items.map((i) => i.text)).toEqual(['first steer', 'second steer'])
    expect(items[0].id).toBe('lq-steer-1')
  })

  test('steered texts ride verbatim as finalPrompt (never re-baked)', () => {
    const items = leftoverRequeueItems([{ pushId: 'p', text: 'raw @file text stays raw' }])
    expect(items[0].finalPrompt).toBe('raw @file text stays raw')
  })

  test('an empty leftover list produces no queue entries', () => {
    expect(leftoverRequeueItems([])).toEqual([])
  })
})
