/**
 * Per-tab composer selection: mode + model + reasoning effort.
 *
 * The values are intentionally view-scoped. A task tab may persist them into
 * its host TaskRecord, and every run carries a snapshot so a background tab
 * can never pick up another tab's later change.
 */

export type TabMode = 'default' | 'plan' | 'chat'

export interface TabSelection {
  mode: TabMode
  /** `${providerId}/${model}`; empty means "use the global default". */
  model: string
  /** Reasoning literal; `default` means inherit the configured effort. */
  reasoningEffort: string
}

export type PartialTabSelection = Partial<TabSelection>

export const DEFAULT_TAB_SELECTION: TabSelection = {
  mode: 'default',
  model: '',
  reasoningEffort: 'default',
}

export function isTabMode(value: unknown): value is TabMode {
  return value === 'default' || value === 'plan' || value === 'chat'
}

/** Fill missing/invalid fields from a fallback selection. */
export function resolveTabSelection(
  selection: PartialTabSelection | undefined,
  fallback: TabSelection = DEFAULT_TAB_SELECTION
): TabSelection {
  const mode = isTabMode(selection?.mode) ? selection.mode : fallback.mode
  const model =
    typeof selection?.model === 'string' && selection.model.trim()
      ? selection.model.trim()
      : fallback.model
  const reasoningEffort =
    typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort.trim()
      ? selection.reasoningEffort.trim()
      : fallback.reasoningEffort
  return { mode, model, reasoningEffort }
}

/** Merge a user change onto the current selection, keeping prior valid fields. */
export function mergeTabSelection(
  current: PartialTabSelection | undefined,
  fallback: TabSelection,
  patch: PartialTabSelection
): TabSelection {
  const base = resolveTabSelection(current, fallback)
  return resolveTabSelection({ ...base, ...patch }, base)
}

export function sameTabSelection(a: TabSelection, b: TabSelection): boolean {
  return (
    a.mode === b.mode &&
    a.model === b.model &&
    a.reasoningEffort === b.reasoningEffort
  )
}

/**
 * A model change can invalidate the previous effort rung (e.g. a GPT-only
 * `xhigh` on a model whose ladder stops at `high`). Keep the stored value
 * truthful by falling back to `default` when the new ladder rejects it.
 */
export function clampTabReasoningEffort(
  selection: TabSelection,
  reasoningOptions: readonly string[]
): TabSelection {
  return reasoningOptions.includes(selection.reasoningEffort)
    ? selection
    : { ...selection, reasoningEffort: 'default' }
}
