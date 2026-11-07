/**
 * Cross-tab queue routing: a queued message may only auto-dispatch when its own
 * conversation (and project) is on screen.
 */

import { describe, expect, test } from 'bun:test'
import {
  firstReadyQueueIndex,
  queueTargetMatchesView,
  type QueueTarget,
  type QueueView,
} from '../src/renderer/src/utils/queue-routing'

const view = (overrides: Partial<QueueView> = {}): QueueView => ({
  taskId: 'task-a',
  tabId: 'tab-a',
  cwd: '~/p',
  ...overrides,
})

describe('queueTargetMatchesView', () => {
  test('a task-targeted message matches only its own conversation', () => {
    expect(queueTargetMatchesView({ taskId: 'task-a' }, view())).toBe(true)
    expect(queueTargetMatchesView({ taskId: 'task-b' }, view())).toBe(false)
  })

  test('project mismatch wins even when the task ids match', () => {
    expect(
      queueTargetMatchesView({ taskId: 'task-a', cwd: '~/q' }, view())
    ).toBe(false)
  })

  test('a draft-targeted message needs the draft tab and a null view', () => {
    const draft = { taskId: null, tabId: 'tab-draft', cwd: '~/p' }
    expect(queueTargetMatchesView(draft, view({ taskId: null, tabId: 'tab-draft' }))).toBe(true)
    expect(queueTargetMatchesView(draft, view({ taskId: null, tabId: 'tab-other' }))).toBe(false)
    expect(queueTargetMatchesView(draft, view())).toBe(false)
  })

  test('a draft message waits after its tab is bound to a task', () => {
    expect(
      queueTargetMatchesView(
        { taskId: null, tabId: 'tab-draft', cwd: '~/p' },
        view({ taskId: 'task-new', tabId: 'tab-draft' })
      )
    ).toBe(false)
  })

  test('legacy entries without a target keep the old global behavior', () => {
    expect(queueTargetMatchesView({}, view())).toBe(true)
    expect(queueTargetMatchesView({}, view({ taskId: null, tabId: null }))).toBe(true)
  })
})

describe('firstReadyQueueIndex', () => {
  const items: QueueTarget[] = [
    { taskId: 'task-b', cwd: '~/p' },
    { taskId: 'task-a', cwd: '~/p' },
    { taskId: 'task-a', cwd: '~/q' },
  ]

  test('skips items parked for other conversations', () => {
    expect(firstReadyQueueIndex(items, view())).toBe(1)
  })

  test('returns -1 when nothing on screen owns a queued item', () => {
    expect(firstReadyQueueIndex(items, view({ taskId: 'task-c' }))).toBe(-1)
  })

  test('preserves per-conversation FIFO order', () => {
    const sameConversation: QueueTarget[] = [
      { taskId: 'task-a', cwd: '~/p' },
      { taskId: 'task-a', cwd: '~/p' },
    ]
    expect(firstReadyQueueIndex(sameConversation, view())).toBe(0)
  })
})
