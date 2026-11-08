/**
 * Cross-tab execution-queue routing.
 *
 * A queued message was composed in a specific conversation (and its
 * `finalPrompt` was baked against that project's cwd). It must run in THAT
 * conversation/project, never in whichever tab happens to be visible when a
 * run ends. P2 dispatches background items too, so visibility only decides
 * which tab's queue dock shows an item; targeting and pause keys decide where
 * a message runs.
 */

export interface QueueTarget {
  /** Host conversation; null for a message composed in an unsent draft. */
  taskId?: string | null
  /** Draft tab id used when `taskId` is null. */
  tabId?: string | null
  /** Project the prompt was baked against. */
  cwd?: string
}

export interface QueueView {
  taskId: string | null
  tabId: string | null
  cwd: string | null
}

/** Stable identity of a queue target. Used for per-conversation pause state. */
export function queueTargetKey(target: QueueTarget): string {
  if (target.taskId) return `task:${target.taskId}`
  if (target.tabId) return `tab:${target.tabId}`
  if (target.cwd) return `cwd:${target.cwd}`
  return 'global'
}

/** True when the queued message belongs to the conversation currently on screen. */
export function queueTargetMatchesView(item: QueueTarget, view: QueueView): boolean {
  // A prompt baked in another project must never run against this one, even if
  // target ids happen to match during an in-flight project switch.
  if (item.cwd && view.cwd && item.cwd !== view.cwd) return false
  if (item.taskId) return view.taskId === item.taskId
  if (item.tabId) return view.taskId === null && view.tabId === item.tabId
  // Legacy/unknown target: keep the old global-queue behavior rather than
  // stranding the entry forever.
  return true
}

/**
 * Queued items owned by the given tab/view. Once a message has a taskId it
 * belongs to that conversation (including when reopened in another tab); only
 * draft messages are tab-scoped. Legacy untargeted entries are excluded so they
 * cannot leak into every tab's dock. `view.cwd` is intentionally not used for
 * visibility — dispatch already routes each prompt to its baked cwd.
 */
export function queueItemsForView<T extends QueueTarget>(
  items: readonly T[],
  view: QueueView
): T[] {
  return items.filter((item) => {
    if (item.taskId) return item.taskId === view.taskId
    if (item.tabId) return item.tabId === view.tabId
    return false
  })
}

/** Index of the first queued item whose conversation is currently visible. */
export function firstReadyQueueIndex(
  items: readonly QueueTarget[],
  view: QueueView
): number {
  return items.findIndex((item) => queueTargetMatchesView(item, view))
}

export interface QueueDispatchFilter {
  /** Per-conversation ADR-30 pauses. */
  pausedKeys?: ReadonlySet<string>
  /** Tasks with a live run — never start their queued message twice. */
  runningTaskIds?: ReadonlySet<string>
  /** Project cwds whose last dispatch was rejected as project-busy. */
  blockedCwds?: ReadonlySet<string>
}

/**
 * Index of the first item the drain loop may start now. Background targets are
 * allowed (the prompt carries its own cwd/task); paused targets are skipped so
 * one conversation's Stop cannot hold every other conversation's queue.
 * A queued message for a task that is already running must wait — dispatching
 * it again would only earn a `task-busy` rejection.
 */
export function firstDispatchableQueueIndex(
  items: readonly QueueTarget[],
  filter: QueueDispatchFilter = {}
): number {
  return items.findIndex((item) => {
    if (!item.cwd) return false
    if (filter.pausedKeys?.has(queueTargetKey(item))) return false
    if (item.taskId && filter.runningTaskIds?.has(item.taskId)) return false
    if (filter.blockedCwds?.has(item.cwd)) return false
    return true
  })
}

export interface QueueReorderItem extends QueueTarget {
  id: string
}

/**
 * Swap a visible queued message with its nearest sibling in the SAME
 * conversation. Other conversations keep their relative order, so the queue
 * dock can reorder only the items it actually shows.
 */
export function moveQueueItemWithinTarget<T extends QueueReorderItem>(
  items: T[],
  id: string,
  direction: -1 | 1
): T[] {
  const idx = items.findIndex((item) => item.id === id)
  if (idx < 0) return items
  const targetKey = queueTargetKey(items[idx])
  let swapIdx = idx + direction
  while (swapIdx >= 0 && swapIdx < items.length) {
    if (queueTargetKey(items[swapIdx]) === targetKey) {
      const next = [...items]
      ;[next[idx], next[swapIdx]] = [next[swapIdx], next[idx]]
      return next
    }
    swapIdx += direction
  }
  return items
}

/**
 * Move a queued message to the front of its own conversation's queue without
 * disturbing the relative order of other conversations' items.
 */
export function promoteQueueItemWithinTarget<T extends QueueReorderItem>(
  items: T[],
  id: string
): T[] {
  const idx = items.findIndex((item) => item.id === id)
  if (idx < 0) return items
  const targetKey = queueTargetKey(items[idx])
  const firstIdx = items.findIndex((item) => queueTargetKey(item) === targetKey)
  if (idx <= firstIdx) return items
  const next = [...items]
  const [item] = next.splice(idx, 1)
  const insertAt = next.findIndex((entry) => queueTargetKey(entry) === targetKey)
  next.splice(insertAt, 0, item)
  return next
}
