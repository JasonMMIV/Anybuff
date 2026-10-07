/**
 * Mid-turn steering mailbox (ADR-30).
 *
 * The engine hook `RunOptions.drainSteeringMessages` drains this at every
 * step boundary: returned texts are appended to the live turn as user
 * prompts (tags USER_PROMPT, keepDuringTruncation) and keep the turn going.
 * This module is the host-side mailbox between the AnyBuff:sendNow channel
 * and the active run, mirroring the claim/accept shape upstream uses in
 * `cli/src/utils/steering-buffer.ts` (owner-guarded like active-run.ts).
 *
 * The transcript echo is the session-store's job: pushSteeringMessage
 * appends a role-'user' TaskMessage (push-time echo) and records its index
 * here, so an entry the run never drained can have its bubble retracted
 * when the text is requeued as a fresh turn (which mints its own bubble).
 *
 * Owner-guard: an aborted run resolving late must not drain or clear a
 * newer run's buffer.
 */

export interface SteeringEntry {
  /** Id of the transcript echo (push id) — used to retract it on leftover. */
  pushId: string
  text: string
}

let activeOwnerId: string | null = null
let buffer: SteeringEntry[] = []

/**
 * Called by startRun right before client.run() with the run's owner id.
 * Idempotent for the SAME owner: startRun re-activates before each auto-retry
 * attempt with the same id (ADR-30), and that re-open must preserve entries
 * pushed since the previous attempt (e.g. during a failed attempt's tail)
 * instead of wiping them. A NEW owner (fresh run) always starts empty.
 */
export function activateSteering(ownerId: string): void {
  if (activeOwnerId === ownerId) return
  activeOwnerId = ownerId
  buffer = []
}

/**
 * Called by startRun when the run settles. Returns any entries the run
 * never drained (submitted after its last step boundary) so the caller can
 * retract their transcript echoes and requeue the texts instead of dropping
 * them. Owner-guarded: a stale run's settle must not clear a newer buffer.
 */
export function deactivateSteering(ownerId: string): SteeringEntry[] {
  if (activeOwnerId !== ownerId) return []
  activeOwnerId = null
  const leftovers = buffer
  buffer = []
  return leftovers
}

/**
 * Called by the sendNow handler on a mid-turn submit. The gate (run active
 * + pure text) lives in the handler/hook; this only refuses when no run is
 * accepting steering (caller falls back to the queue).
 */
export function pushSteeringMessage(entry: SteeringEntry): boolean {
  if (activeOwnerId === null) return false
  buffer.push(entry)
  return true
}

/** True while a run is accepting steering pushes. */
export function isSteeringActive(): boolean {
  return activeOwnerId !== null
}

/** Called by startRun's drainSteeringMessages hook at each step boundary. */
export function drainSteeringMessages(ownerId: string): string[] {
  if (activeOwnerId !== ownerId || buffer.length === 0) return []
  const drained = buffer
  buffer = []
  return drained.map((entry) => entry.text)
}

/** Test seam. */
export function __resetSteeringForTests(): void {
  activeOwnerId = null
  buffer = []
}
