/**
 * Interactive prompts (ask_user / approval) belong to one task at the host.
 * The renderer keeps a single visible slot because the host FIFO serializes
 * them, but that slot must still follow the owning tab — one conversation's
 * questions must never appear in another conversation's view.
 */
export interface TaskScopedPrompt {
  taskId?: string
}

/**
 * Whether a task-scoped prompt may render in the active tab.
 *
 * - A prompt without a taskId (legacy host) keeps the old global behavior.
 * - A prompt whose task owns the active tab is visible.
 * - A prompt whose task has another open tab stays hidden there.
 * - A prompt whose task has no open tab falls back to the active tab, so a
 *   closed background tab can never strand a run that is waiting for answers.
 */
export function promptVisibleInActiveTab(
  prompt: TaskScopedPrompt | null | undefined,
  activeTaskId: string | null,
  openTaskIds: readonly string[]
): boolean {
  if (!prompt) return false
  if (!prompt.taskId) return true
  if (prompt.taskId === activeTaskId) return true
  return !openTaskIds.includes(prompt.taskId)
}
