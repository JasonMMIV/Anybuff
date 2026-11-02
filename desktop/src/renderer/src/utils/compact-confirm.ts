/**
 * Whether the manual `/compact` confirmation may submit, and why not when it
 * cannot. Pure so the modal's three states are unit-tested without a DOM.
 */
export function compactConfirmState(params: {
  used: number
  max: number
  running: boolean
}): { canConfirm: boolean; note?: string } {
  if (params.running) {
    return { canConfirm: false, note: 'Wait for the current run to finish.' }
  }
  if (params.used <= 0) {
    return { canConfirm: false, note: 'Nothing to compact yet.' }
  }
  return { canConfirm: true }
}
