/**
 * Per-tab composer drafts.
 *
 * The composer is a single controlled textarea, but the draft belongs to the
 * TAB, not to the app: switching tabs must restore that tab's text AND its
 * caret/selection (and the textarea's internal scroll for long drafts).
 *
 * Kept as pure functions so the clamping/round-trip rules are unit-testable
 * without a DOM harness.
 */

export interface ComposerDraft {
  text: string
  /** Caret / selection start, clamped to the text length. */
  selectionStart: number
  /** Caret / selection end (>= start), clamped to the text length. */
  selectionEnd: number
  /** textarea.scrollTop while the draft exceeds the auto-grow height. */
  scrollTop: number
}

/** Shared immutable empty draft (never mutated by callers). */
export const EMPTY_COMPOSER_DRAFT: ComposerDraft = Object.freeze({
  text: '',
  selectionStart: 0,
  selectionEnd: 0,
  scrollTop: 0,
})

/**
 * Build a draft from live textarea values. Defaults the caret to the end (the
 * natural position for a restored draft) and never emits an inverted or
 * out-of-range selection.
 */
export function createComposerDraft(
  text: string,
  selectionStart: number = text.length,
  selectionEnd: number = selectionStart,
  scrollTop: number = 0
): ComposerDraft {
  const { start, end } = clampComposerSelection(text, selectionStart, selectionEnd)
  return {
    text,
    selectionStart: start,
    selectionEnd: end,
    scrollTop: Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0,
  }
}

/**
 * Clamp a selection to the current text length. A negative / non-finite value
 * falls back to the end; `end` never precedes `start`. This is the guard that
 * makes restoring a draft safe after the text was edited elsewhere.
 */
export function clampComposerSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number
): { start: number; end: number } {
  const length = text.length
  const rawStart = Number.isFinite(selectionStart) ? Math.floor(selectionStart) : length
  const start = Math.min(Math.max(0, rawStart), length)
  const rawEnd = Number.isFinite(selectionEnd) ? Math.floor(selectionEnd) : start
  const end = Math.min(Math.max(start, rawEnd), length)
  return { start, end }
}

/**
 * Only text makes a draft worth keeping; a caret position or scroll offset on
 * its own is not content (matches the pre-existing "empty prompt deletes the
 * draft" behavior).
 */
export function isComposerTextEmpty(text: string | null | undefined): boolean {
  return !text || text.length === 0
}

/**
 * Which bucket the live composer belongs to. A task view wins; desktop falls
 * back to the TAB (two new-chat tabs in one project must not share a draft);
 * the Android WebView has one implicit tab, so it keeps the pre-tabs
 * project-scoped bucket.
 */
export function composerDraftKey(input: {
  activeViewTaskId: string | null
  activeTabId: string | null
  cwd: string | null
  isAndroidShell: boolean
}): string {
  if (input.activeViewTaskId) return input.activeViewTaskId
  if (input.isAndroidShell) return `__new__:${input.cwd ?? ''}`
  if (input.activeTabId) return `tab:${input.activeTabId}`
  return `__new__:${input.cwd ?? ''}`
}
