/**
 * Cross-tab queue routing: a queued message runs in its own conversation and
 * project. Visibility only controls UI affordances; the drain loop may start a
 * background item as long as its own target is not paused.
 */

import { describe, expect, test } from 'bun:test'
import {
  firstDispatchableQueueIndex,
  firstReadyQueueIndex,
  queueTargetKey,
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

describe('queueTargetKey', () => {
  test('prefers task over tab over cwd', () => {
    expect(queueTargetKey({ taskId: 't', tabId: 'tab', cwd: '~/p' })).toBe('task:t')
    expect(queueTargetKey({ taskId: null, tabId: 'tab', cwd: '~/p' })).toBe('tab:tab')
    expect(queueTargetKey({ cwd: '~/p' })).toBe('cwd:~/p')
    expect(queueTargetKey({})).toBe('global')
  })
})

describe('firstDispatchableQueueIndex', () => {
  const items: QueueTarget[] = [
    { taskId: 'task-a', cwd: '~/p' },
    { taskId: 'task-b', cwd: '~/q' },
    { taskId: 'task-c', cwd: '~/r' },
  ]

  test('allows background targets and preserves FIFO order', () => {
    expect(firstDispatchableQueueIndex(items)).toBe(0)
  })

  test('skips paused targets without blocking later conversations', () => {
    const paused = new Set([queueTargetKey(items[0])])
    expect(firstDispatchableQueueIndex(items, { pausedKeys: paused })).toBe(1)
  })

  test('skips a task that is already running', () => {
    expect(
      firstDispatchableQueueIndex(items, { runningTaskIds: new Set(['task-a']) })
    ).toBe(1)
  })

  test('skips a project whose dispatch was rejected as busy', () => {
    expect(
      firstDispatchableQueueIndex(items, { blockedCwds: new Set(['~/p']) })
    ).toBe(1)
  })

  test('ignores entries without a project cwd', () => {
    expect(firstDispatchableQueueIndex([{ taskId: 'task-a' }])).toBe(-1)
    expect(firstDispatchableQueueIndex([{ taskId: 'task-a' }, { taskId: 'task-b', cwd: '~/q' }])).toBe(1)
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
