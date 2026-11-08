/**
 * Cross-tab queue routing: a queued message runs in its own conversation and
 * project. Visibility only controls UI affordances; the drain loop may start a
 * background item as long as its own target is not paused.
 */

import { describe, expect, test } from 'bun:test'
import {
  firstDispatchableQueueIndex,
  firstReadyQueueIndex,
  moveQueueItemWithinTarget,
  promoteQueueItemWithinTarget,
  queueItemsForView,
  queueTargetKey,
  queueTargetMatchesView,
  type QueueReorderItem,
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

describe('queueItemsForView', () => {
  const items: QueueReorderItem[] = [
    { id: 'a1', taskId: 'task-a', tabId: 'tab-a', cwd: '~/p' },
    { id: 'b1', taskId: 'task-b', tabId: 'tab-b', cwd: '~/p' },
    { id: 'a2', taskId: 'task-a', tabId: 'tab-a', cwd: '~/p' },
    { id: 'draft', taskId: null, tabId: 'tab-draft', cwd: '~/p' },
  ]

  test('returns only the visible conversation items in queue order', () => {
    expect(queueItemsForView(items, view()).map((item) => item.id)).toEqual(['a1', 'a2'])
  })

  test('draft items belong to their own tab', () => {
    expect(
      queueItemsForView(items, view({ taskId: null, tabId: 'tab-draft' })).map((item) => item.id)
    ).toEqual(['draft'])
  })

  test('a reopened conversation follows its task into the new tab', () => {
    expect(
      queueItemsForView(items, view({ tabId: 'tab-reopened' })).map((item) => item.id)
    ).toEqual(['a1', 'a2'])
  })

  test('a bound draft tab keeps the messages composed in that tab', () => {
    expect(
      queueItemsForView(
        [{ id: 'draft', taskId: null, tabId: 'tab-bound', cwd: '~/p' }],
        view({ taskId: 'task-new', tabId: 'tab-bound' })
      ).map((item) => item.id)
    ).toEqual(['draft'])
  })

  test('legacy untargeted entries are hidden instead of shown in every dock', () => {
    expect(queueItemsForView([{ id: 'legacy' }], view())).toEqual([])
  })

  test('a task target wins over a stale composition tab', () => {
    const mismatch = { id: 'mismatch', taskId: 'task-a', tabId: 'tab-b', cwd: '~/p' }
    expect(queueItemsForView([mismatch], view()).map((item) => item.id)).toEqual(['mismatch'])
    expect(
      queueItemsForView([mismatch], view({ taskId: 'task-b', tabId: 'tab-b' }))
    ).toEqual([])
  })
})

describe('scoped queue reordering', () => {
  const items: QueueReorderItem[] = [
    { id: 'a1', taskId: 'task-a', cwd: '~/p' },
    { id: 'b1', taskId: 'task-b', cwd: '~/p' },
    { id: 'a2', taskId: 'task-a', cwd: '~/p' },
    { id: 'a3', taskId: 'task-a', cwd: '~/p' },
    { id: 'b2', taskId: 'task-b', cwd: '~/p' },
  ]

  test('move up skips other conversations', () => {
    expect(moveQueueItemWithinTarget(items, 'a3', -1).map((item) => item.id)).toEqual([
      'a1', 'b1', 'a3', 'a2', 'b2',
    ])
  })

  test('move down skips other conversations', () => {
    expect(moveQueueItemWithinTarget(items, 'a1', 1).map((item) => item.id)).toEqual([
      'a2', 'b1', 'a1', 'a3', 'b2',
    ])
  })

  test('move at a boundary is a no-op', () => {
    expect(moveQueueItemWithinTarget(items, 'a1', -1)).toBe(items)
    expect(moveQueueItemWithinTarget(items, 'a3', 1)).toBe(items)
  })

  test('promote moves to the front of its own conversation only', () => {
    expect(promoteQueueItemWithinTarget(items, 'a3').map((item) => item.id)).toEqual([
      'a3', 'a1', 'b1', 'a2', 'b2',
    ])
  })

  test('promote inserts before the first sibling even when it is not global-first', () => {
    expect(promoteQueueItemWithinTarget(items, 'b2').map((item) => item.id)).toEqual([
      'a1', 'b2', 'b1', 'a2', 'a3',
    ])
  })

  test('promote of the first item is a no-op', () => {
    expect(promoteQueueItemWithinTarget(items, 'a1')).toBe(items)
  })
})
