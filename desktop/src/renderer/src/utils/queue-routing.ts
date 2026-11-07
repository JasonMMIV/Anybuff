/**
 * Cross-tab execution-queue routing.
 *
 * A queued message was composed in a specific conversation (and its
 * `finalPrompt` was baked against that project's cwd). The host runs one task
 * at a time, so an item must never auto-dispatch into whichever conversation
 * happens to be visible when the previous run ends. Drain only items whose
 * target is on screen; everything else stays parked until its tab returns.
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

/** Index of the first queued item whose conversation is currently visible. */
export function firstReadyQueueIndex(
  items: readonly QueueTarget[],
  view: QueueView
): number {
  return items.findIndex((item) => queueTargetMatchesView(item, view))
}
