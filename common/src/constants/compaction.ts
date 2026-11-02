/**
 * Manual `/compact` skip notice (ADR-37).
 *
 * The runtime emits a `context_compaction` event with this action when a
 * `/compact` step produced no usable summary (or carried a recovery/tool
 * error). Hosts persist and render the message; keeping both literals in one
 * place stops the runtime, host, and renderer from drifting.
 */
export const COMPACT_SKIPPED_ACTION = 'compact_skipped'

/** Covers both the "no visible summary" and "the step errored" cases. */
export const COMPACT_SKIPPED_MESSAGE =
  '/compact did not run: the step ended with an error or produced no usable summary. Your conversation history was kept — please try again.'
