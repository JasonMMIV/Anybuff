/**
 * Mid-turn steering mailbox (ADR-30).
 *
 * The engine hook `RunOptions.drainSteeringMessages` drains this at every
 * step boundary: returned texts are appended to the live turn as user
 * prompts and keep the turn going. The mailbox is keyed by run owner id, so
 * two concurrent runs have independent buffers.
 *
 * The transcript echo is the session-store's job: pushSteeringMessage appends
 * a role-'user' TaskMessage (push-time echo) and records its push id here, so
 * an entry the run never drained can have its bubble retracted when the text
 * is requeued as a fresh turn (which mints its own bubble).
 *
 * Owner-guard: an aborted run resolving late must not drain or clear a newer
 * run's buffer.
 */

export interface SteeringEntry {
  /** Id of the transcript echo (push id) — used to retract it on leftover. */
  pushId: string
  text: string
}

const buffers = new Map<string, SteeringEntry[]>()
/** Legacy single-owner compatibility: tests and old callers omit the owner. */
let lastOwnerId: string | null = null

/**
 * Called by startRun before each attempt with the run's owner id. Idempotent
 * for the same owner: a retry re-activates without wiping entries pushed since
 * the failed attempt's last drain. A fresh owner always starts empty.
 */
export function activateSteering(ownerId: string): void {
  if (!buffers.has(ownerId)) buffers.set(ownerId, [])
  lastOwnerId = ownerId
}

/**
 * Called by startRun when the run settles. Returns entries this owner never
 * drained so the caller can retract their echoes and requeue the texts.
 * Owner-guarded: a stale run's settle never touches another run's buffer.
 */
export function deactivateSteering(ownerId: string): SteeringEntry[] {
  const leftovers = buffers.get(ownerId)
  if (!leftovers) return []
  buffers.delete(ownerId)
  if (lastOwnerId === ownerId) {
    lastOwnerId = buffers.size > 0 ? Array.from(buffers.keys()).at(-1) ?? null : null
  }
  return leftovers
}

/** Push a steering entry for a specific run. */
export function pushSteeringMessageFor(ownerId: string, entry: SteeringEntry): boolean {
  const buffer = buffers.get(ownerId)
  if (!buffer) return false
  buffer.push(entry)
  return true
}

/**
 * Legacy single-owner entry point. New callers (the sendNow channel) use
 * pushSteeringMessageFor so a concurrent run cannot receive the entry.
 */
export function pushSteeringMessage(entry: SteeringEntry): boolean {
  if (!lastOwnerId) return false
  return pushSteeringMessageFor(lastOwnerId, entry)
}

/** True while a run (or the specified run) is accepting steering pushes. */
export function isSteeringActive(ownerId?: string): boolean {
  if (ownerId !== undefined) return buffers.has(ownerId)
  return buffers.size > 0
}

/** Called by startRun's drainSteeringMessages hook at each step boundary. */
export function drainSteeringMessages(ownerId: string): string[] {
  const buffer = buffers.get(ownerId)
  if (!buffer || buffer.length === 0) return []
  buffers.set(ownerId, [])
  return buffer.map((entry) => entry.text)
}

/** Test seam. */
export function __resetSteeringForTests(): void {
  buffers.clear()
  lastOwnerId = null
}
