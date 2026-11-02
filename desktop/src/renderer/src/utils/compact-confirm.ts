/**
 * Whether the manual `/compact` confirmation may submit, and why not when it
 * cannot. Pure so the modal's three states are unit-tested without a DOM.
 */
export function compactConfirmState(params: {
  used: number
  max: number
  running: boolean
  /** False when no measurement exists yet (e.g. a reopened task). */
  usageKnown?: boolean
  /** False for a brand-new conversation with no user/assistant turns. */
  hasConversation?: boolean
}): { canConfirm: boolean; note?: string } {
  const { used, running, usageKnown = true, hasConversation = true } = params
  if (running) {
    return { canConfirm: false, note: 'Wait for the current run to finish.' }
  }
  if (!hasConversation) {
    return { canConfirm: false, note: 'Nothing to compact yet.' }
  }
  // `used === 0` only means "empty" when a measurement exists. A reopened
  // task has no measurement until its next run; blocking there is a false
  // negative (the transcript may be huge).
  if (usageKnown && used <= 0) {
    return { canConfirm: false, note: 'Nothing to compact yet.' }
  }
  return { canConfirm: true }
}
