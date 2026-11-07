/**
 * Interactive prompt FIFO (approval / ask_user).
 *
 * The renderer has one modal slot, so only the queue head is emitted. The head
 * must settle before the next prompt is shown; otherwise a second run's
 * prompt would overwrite the first and leave that run waiting forever.
 *
 * Known trade-off: a background run's prompt can appear before a foreground
 * run's prompt (head-of-line). That is deliberate for v1 — correctness over
 * foreground priority. Reordering would need an explicit preemption model.
 */

export type InteractiveKind = 'approval' | 'ask_user'

export interface InteractivePrompt {
  promptId: string
  runId: string
  taskId: string
  title: string
  kind: InteractiveKind
  payload: unknown
  resolve: (value: unknown) => void
}

export interface PromptTarget {
  promptId?: string
  taskId?: string
  runId?: string
}

type EmitHead = (prompt: InteractivePrompt) => void

const queue: InteractivePrompt[] = []
let emitHead: EmitHead | null = null

/** start-run installs the sink-side emitter once (events carry run/task ids). */
export function setInteractivePromptEmitter(emitter: EmitHead | null): void {
  emitHead = emitter
}

function makePromptId(now = Date.now(), random = Math.random()): string {
  return `prompt-${now.toString(36)}-${random.toString(36).slice(2, 8)}`
}

/**
 * Append a prompt and resolve when it is settled. The promise stays pending
 * behind earlier prompts; only the queue head is emitted.
 */
export function enqueuePrompt(
  input: Omit<InteractivePrompt, 'promptId' | 'resolve'>
): Promise<unknown> {
  return new Promise((resolve) => {
    const prompt: InteractivePrompt = {
      ...input,
      promptId: makePromptId(),
      resolve,
    }
    queue.push(prompt)
    if (queue.length === 1) emitHead?.(prompt)
  })
}

export function headPrompt(): InteractivePrompt | undefined {
  return queue[0]
}

export function pendingPromptCount(): number {
  return queue.length
}

/** Only the head can settle; an unseen queued prompt must stay pending. */
export function resolvePrompt(promptId: string, value: unknown): boolean {
  const head = queue[0]
  if (!head || head.promptId !== promptId) return false
  queue.shift()
  head.resolve(value)
  const next = queue[0]
  if (next) emitHead?.(next)
  return true
}

/** Legacy channels (no promptId) settle the head of the requested kind. */
export function resolveHeadPrompt(kind: InteractiveKind, value: unknown): boolean {
  const head = queue[0]
  if (!head || head.kind !== kind) return false
  return resolvePrompt(head.promptId, value)
}

/**
 * Targeted settle. `promptId` is exact; taskId/runId are accepted for
 * backwards-compatible callers but only match when the prompt is the head.
 */
export function resolvePromptFor(
  kind: InteractiveKind,
  target: PromptTarget,
  value: unknown
): boolean {
  const head = queue[0]
  if (!head || head.kind !== kind) return false
  if (target.promptId !== undefined && head.promptId !== target.promptId) return false
  if (target.taskId !== undefined && head.taskId !== target.taskId) return false
  if (target.runId !== undefined && head.runId !== target.runId) return false
  return resolvePrompt(head.promptId, value)
}

/** Settle every prompt owned by a run (abort/settle) without leaving waiters. */
export function dropPromptsForRun(runId: string): void {
  let removedHead = false
  let index = 0
  while (index < queue.length) {
    const prompt = queue[index]
    if (prompt.runId !== runId) {
      index += 1
      continue
    }
    if (index === 0) removedHead = true
    queue.splice(index, 1)
    prompt.resolve(prompt.kind === 'approval' ? false : { skipped: true })
  }
  if (removedHead) {
    const next = queue[0]
    if (next) emitHead?.(next)
  }
}

/** Test seam. Settles waiters so tests never leave dangling promises. */
export function __resetInteractiveQueueForTests(): void {
  for (const prompt of queue.splice(0)) {
    prompt.resolve(prompt.kind === 'approval' ? false : { skipped: true })
  }
  emitHead = null
}
