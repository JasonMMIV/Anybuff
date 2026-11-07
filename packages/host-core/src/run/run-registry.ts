import type { CodebuffClient } from '@codebuff/sdk'

export interface RunContext {
  /** Unique id for this execution (also the steering mailbox owner). */
  runId: string
  taskId: string
  cwd: string
  /** Canonical key from run/project-key.ts. */
  projectKey: string
  agentId: string
  mode: 'default' | 'plan' | 'chat'
  abort: AbortController
  client: CodebuffClient | null
  steeringOwnerId: string
  startedAt: number
}

const runs = new Map<string, RunContext>()

/** Unique run id, shaped like the old steering owner id. */
export function makeRunId(now = Date.now(), random = Math.random()): string {
  return `run-${now.toString(36)}-${random.toString(36).slice(2, 8)}`
}

/** Register a run. Admission (one run per task) happens before this call. */
export function createRun(input: {
  taskId: string
  cwd: string
  projectKey: string
  agentId: string
  mode: 'default' | 'plan' | 'chat'
}): RunContext {
  const runId = makeRunId()
  const run: RunContext = {
    runId,
    taskId: input.taskId,
    cwd: input.cwd,
    projectKey: input.projectKey,
    agentId: input.agentId,
    mode: input.mode,
    abort: new AbortController(),
    client: null,
    steeringOwnerId: runId,
    startedAt: Date.now(),
  }
  runs.set(runId, run)
  return run
}

export function getRun(runId: string): RunContext | undefined {
  return runs.get(runId)
}

export function getRunByTaskId(taskId: string): RunContext | undefined {
  for (const run of runs.values()) {
    if (run.taskId === taskId) return run
  }
  return undefined
}

export function listRuns(): RunContext[] {
  return Array.from(runs.values())
}

export function countRuns(): number {
  return runs.size
}

/** Remove a run. Multiple runs in one project are allowed. */
export function releaseRun(runId: string): void {
  const run = runs.get(runId)
  if (!run) return
  runs.delete(runId)
  run.client = null
}

/** Test seam. */
export function __resetRunRegistryForTests(): void {
  runs.clear()
}
