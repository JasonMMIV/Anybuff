import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Task-scoped provider routing defaults for ONE run.
 *
 * The desktop host can run several conversations concurrently. Model and
 * reasoning-effort selection is per task/tab, so it cannot live in the global
 * provider config for the duration of a run. AsyncLocalStorage keeps the
 * override attached to the async call tree that started in `run()`, including
 * subagents and retries, without leaking into another run.
 *
 * These are DEFAULTS only: explicit mode/agent routes still win, matching the
 * existing `defaultModel` / `defaultReasoningEffort` precedence.
 */
export type RunOverrides = {
  defaultModel?: string
  defaultReasoningEffort?: string
}

const storage = new AsyncLocalStorage<RunOverrides>()

/** Run `fn` with task-scoped defaults visible to every nested LLM request. */
export function withRunOverrides<T>(overrides: RunOverrides | undefined, fn: () => T): T {
  if (!overrides?.defaultModel && !overrides?.defaultReasoningEffort) return fn()
  return storage.run(overrides, fn)
}

/** The overrides for the current async run, if any. */
export function getRunOverrides(): RunOverrides | undefined {
  return storage.getStore()
}
