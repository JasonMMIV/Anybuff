/**
 * ADR-30 send-routing gate — the pure decision core of App.send()'s
 * `if (running)` branch, extracted so the steer-vs-queue routing and the
 * leftover requeue order can be unit-tested without a DOM harness.
 *
 * Queue-first: while a run is in flight, a plain Enter / primary-button submit
 * QUEUES the message exactly as it always did (#2 execution queue). Steering
 * happens only on an EXPLICIT "Send now" (Ctrl/Cmd+Enter or the composer's
 * Send now button) — `sendNowIntent` below.
 *
 * Even with the intent, the upstream router.ts fallback list still applies:
 * plain text only. A non-empty queue does NOT block the entry: pressing Send
 * now is the user asking for this text to be answered in the live turn, so it
 * deliberately jumps ahead of messages already parked for AFTER the turn
 * (those keep their order — the drain effect only dispatches when no run is
 * in flight, and leftovers still prepend). Hiding the entry whenever anything
 * is queued (the upstream rule) made the feature unusable.
 */

export interface SteerGateInput {
  /** The user explicitly asked for "Send now" (Ctrl/Cmd+Enter / the button). */
  sendNowIntent: boolean
  /** What the user typed (trimmed by the caller). */
  text: string
  /** A prebuilt prompt (slash command like /init, /review …) — queued, never steered. */
  prebuiltPrompt?: string
  /** The interview wrapper wraps the text — that bake must go through runPrompt. */
  interviewWrap?: boolean
  /** Pending `!command` output baked into the prompt (empty string = none). */
  bashContext?: string
  /** Attachments (images / @file) cannot ride the steering text channel. */
  attachmentCount: number
  /** Whether the shell API exposes the sendNow channel (browser preview: false). */
  hasSendNowApi: boolean
}

/** True when the running turn can take this submit as a mid-turn steer. */
export function canSteerRunningTurn(input: SteerGateInput): boolean {
  if (!input.sendNowIntent) return false
  const text = input.text.trim()
  if (!text) return false
  if (input.prebuiltPrompt) return false
  if (input.interviewWrap) return false
  if (input.bashContext && input.bashContext.length > 0) return false
  if (input.attachmentCount > 0) return false
  if (text.startsWith('!')) return false
  if (text.startsWith('/')) return false
  return input.hasSendNowApi
}

/** A steering leftover requeued as a fresh queued message (id minted from the push id). */
export interface LeftoverQueueItem {
  id: string
  text: string
  finalPrompt: string
}

/**
 * Requeue steering leftovers at the FRONT of the queue, preserving FIFO order.
 * The caller prepends the returned block atomically (`[...items, ...prev]`),
 * so the items stay in arrival order — oldest leftover lands at the head and
 * dispatches first. (Upstream reaches the same order by unshifting each entry
 * individually while iterating in reverse; the block-prepend is equivalent.)
 */
export function leftoverRequeueItems(
  leftovers: { pushId: string; text: string }[]
): LeftoverQueueItem[] {
  return leftovers.map((l) => ({
    id: `lq-${l.pushId}`,
    text: l.text,
    finalPrompt: l.text
  }))
}
