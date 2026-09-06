/**
 * Context-window budget helpers (AnyBuff P0 A0 — shared by SDK, agent-runtime
 * and host-core).
 *
 * Pure and dependency-free so every package can import them. Formula source:
 * AnyBuff 上下文管理改善計畫.md §3.3 (v2):
 *
 *   W               = limit.input ?? limit.context
 *   reserve(W, out) = clamp(max(0.12*W, out ? min(out, 64_000) : 0), 8_000, 0.5*W)
 *   trigger(W)      = min(0.7*W, W - reserve(W, out))
 *   W unknown       → UNKNOWN_MODEL_CONTEXT_FALLBACK (1M, v3 decision)
 *
 * Every returned value is an integer token count.
 */

/** Window assumed for a model with no declared capability (plan §3.3 v3). */
export const UNKNOWN_MODEL_CONTEXT_FALLBACK = 1_000_000

/** Lower clamp of the headroom reserve (plan: 8k). */
export const CONTEXT_RESERVE_MIN_TOKENS = 8_000

/** Output-token reservation is capped at 64k (kimi-k2.6's 262k output would
 *  otherwise swallow the whole trigger). */
const OUTPUT_RESERVE_CAP = 64_000
const RESERVE_FRACTION = 0.12
const RESERVE_CAP_FRACTION = 0.5
const TRIGGER_FRACTION = 0.7

function clampTokenValue(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/**
 * Headroom reserved inside a context window before compaction/trim triggers,
 * so in-flight output (and tokenizer variance) never push a request over the
 * provider's real limit. `outputTokens` is the model's declared max output;
 * when unknown only the flat 12% reserve applies.
 */
export function reserveTokens(
  contextWindowTokens: number,
  outputTokens?: number,
): number {
  const window = Math.max(1, Math.floor(contextWindowTokens))
  const outputReserve =
    outputTokens === undefined
      ? 0
      : Math.min(Math.max(0, Math.floor(outputTokens)), OUTPUT_RESERVE_CAP)
  const lo = Math.min(CONTEXT_RESERVE_MIN_TOKENS, RESERVE_CAP_FRACTION * window)
  const hi = RESERVE_CAP_FRACTION * window
  return Math.floor(
    clampTokenValue(Math.max(RESERVE_FRACTION * window, outputReserve), lo, hi),
  )
}

/**
 * Token count at which a conversation should be compacted/trimmed for a model
 * with the given window. Deliberately conservative: the minimum of 70% of the
 * window and the window minus the output reserve (plan §3.3 v2).
 */
export function toCompactionTriggerTokens(
  contextWindowTokens: number,
  outputTokens?: number,
): number {
  const window = Math.max(1, Math.floor(contextWindowTokens))
  const reserve = reserveTokens(window, outputTokens)
  return Math.max(1, Math.floor(Math.min(TRIGGER_FRACTION * window, window - reserve)))
}
