/**
 * Titlebar workspace tabs — pure helpers shared by App and unit tests.
 *
 * A tab is a VIEW over the host conversation store (never a second copy):
 * task tabs reattach via `getTaskView`; draft tabs have no host task yet and
 * become a task tab when their first prompt is sent.
 */

export interface WorkspaceTab {
  id: string
  /** Host task id; `null` while this is an unsent draft. */
  taskId: string | null
  /** Project the conversation belongs to; `null` only before a folder is picked. */
  projectPath: string | null
  title: string
}

/** Unique renderer-local tab id (never persisted, never sent to the host). */
export function makeTabId(now = Date.now(), random = Math.random()): string {
  return `tab-${now.toString(36)}-${random.toString(36).slice(2, 8)}`
}

/**
 * First line, collapsed whitespace, capped for a titlebar tab. Code-point
 * slicing keeps surrogate pairs (emoji) intact at the truncation boundary.
 */
export function tabTitleFromPrompt(prompt: string | undefined, fallback = 'New Task'): string {
  const text = (prompt ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  const chars = Array.from(text)
  return chars.length > 72 ? `${chars.slice(0, 71).join('')}…` : text
}

/** First empty draft tab for a project (reuse instead of piling up blanks). */
export function findDraftTab(
  tabs: readonly WorkspaceTab[],
  projectPath: string
): WorkspaceTab | undefined {
  return tabs.find((tab) => tab.taskId === null && tab.projectPath === projectPath)
}

/**
 * Retarget an active DRAFT tab at another project, in place. Returns the next
 * tab list (the caller commits it) or null when the tab is missing or is a
 * task tab — a task tab belongs to its host conversation, whose project cannot
 * be changed by retargeting the view.
 *
 * Used by the New Task page's project picker: switching projects there must
 * keep the current tab (and its composer draft), not spawn another one.
 */
export function retargetDraftTab(
  tabs: readonly WorkspaceTab[],
  tabId: string | null,
  projectPath: string
): WorkspaceTab[] | null {
  if (!tabId) return null
  const tab = tabs.find((item) => item.id === tabId)
  if (!tab || tab.taskId !== null) return null
  return tabs.map((item) => (item.id === tabId ? { ...item, projectPath } : item))
}

/** Neighbour to select after closing a tab (null when no tabs remain). */
export function neighborTabAfterClose(
  tabs: readonly WorkspaceTab[],
  closedId: string
): WorkspaceTab | null {
  const idx = tabs.findIndex((tab) => tab.id === closedId)
  if (idx < 0) return null
  const remaining = tabs.filter((tab) => tab.id !== closedId)
  return remaining[Math.min(idx, remaining.length - 1)] ?? null
}
