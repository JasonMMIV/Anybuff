/**
 * Named reasoning wire dialects (ADR-32).
 *
 * WHY: the reasoning write used to be implicit and scattered — one shape in
 * `llm.ts` provider options, another in the vendored OpenAI-compatible body
 * assembly, and nothing at all for Anthropic-compatible endpoints. That left
 * dead channels (`thinkingBudget` had no producer), dropped Anthropic effort
 * (`reasoningEffort` is not in the Anthropic schema) and made a budget-only
 * model impossible to configure.
 *
 * The dialect selects the FORMAT; `reasoning.efforts` / the pick select the
 * VALUE. `auto` is the historical behavior and must stay byte-identical.
 *
 * Hard rule (ADR-10 / ADR-26): no dialect ever writes a "reasoning off" value.
 * `*.none` means "write no reasoning key" — never `thinking:{type:'disabled'}`
 * and never `enable_thinking: false`.
 */

import type { ReasoningWireDialect } from '../provider-config'

const COMPAT_LOG_PREFIX = '[anybuff-compat]'

/**
 * The dialect resolver runs on the request hot path. A misconfiguration would
 * otherwise log on every single request; one line per distinct problem is
 * enough to make it visible without flooding the console.
 */
const warnedOnce = new Set<string>()

function logOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return
  warnedOnce.add(key)
  console.info(message)
}

export type ReasoningWireProtocol = 'openai' | 'anthropic'

export type ReasoningWireDescriptor = {
  protocol: ReasoningWireProtocol
  dialect: ReasoningWireDialect
  /** Budget for `*.budget` / `*.thinking_budget` / `*.enable_thinking`. */
  budgetTokens?: number
}

const OPENAI_DIALECTS: ReadonlySet<ReasoningWireDialect> = new Set([
  'auto',
  'chat.effort',
  'chat.thinking_budget',
  'chat.enable_thinking',
  'chat.reasoning_obj',
  'chat.none',
])

const ANTHROPIC_DIALECTS: ReadonlySet<ReasoningWireDialect> = new Set([
  'auto',
  'claude.effort',
  'claude.budget',
  'claude.none',
])

/** Anthropic `output_config.effort` accepts exactly these three values. */
const CLAUDE_EFFORT_VALUES: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
])

/**
 * Resolve the descriptor for one (provider, model). A dialect that belongs to
 * the other protocol, or an unknown one, falls back to `auto` with a loud log
 * — config typos must never silently change the wire.
 */
export function resolveReasoningWire(params: {
  protocol: ReasoningWireProtocol
  wire?: string
  budgetTokens?: number
}): ReasoningWireDescriptor {
  const allowed =
    params.protocol === 'anthropic' ? ANTHROPIC_DIALECTS : OPENAI_DIALECTS
  const wire = params.wire as ReasoningWireDialect | undefined
  if (wire && !allowed.has(wire)) {
    logOnce(
      `cross:${params.protocol}:${wire}`,
      `${COMPAT_LOG_PREFIX} reasoning-wire: '${wire}' is not a ${params.protocol} dialect — falling back to auto`,
    )
    return { protocol: params.protocol, dialect: 'auto' }
  }
  const dialect = wire ?? 'auto'
  const budgetTokens =
    typeof params.budgetTokens === 'number' &&
    Number.isFinite(params.budgetTokens) &&
    params.budgetTokens > 0
      ? Math.floor(params.budgetTokens)
      : undefined
  if (
    (dialect === 'chat.thinking_budget' ||
      dialect === 'chat.enable_thinking' ||
      dialect === 'claude.budget') &&
    budgetTokens === undefined
  ) {
    logOnce(
      `budget:${dialect}`,
      `${COMPAT_LOG_PREFIX} reasoning-wire: '${dialect}' has no budgetTokens — writing no reasoning key`,
    )
  }
  return {
    protocol: params.protocol,
    dialect,
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

/** Reasoning keys the dialect system manages in an OpenAI-compatible body. */
const OPENAI_MANAGED_KEYS = [
  'reasoning_effort',
  'thinking_budget',
  'enable_thinking',
  'reasoning',
] as const

/**
 * Rewrite an OpenAI-compatible request body for a named dialect.
 *
 * Ownership: a named dialect is the SINGLE writer of the reasoning keys — the
 * keys other dialects own are removed so a budget-only endpoint never receives
 * a stray `reasoning_effort` (and vice versa). Non-reasoning keys are
 * untouched, so user `customBody` parameters survive.
 *
 * `auto` returns the body UNCHANGED (identity is a tested invariant).
 * `customBody` is merged AFTER this function by the caller (escape hatch).
 */
export function applyOpenAIReasoningWire(
  body: Record<string, unknown>,
  wire: ReasoningWireDescriptor | undefined,
): Record<string, unknown> {
  if (!wire || wire.dialect === 'auto') return body

  const next: Record<string, unknown> = { ...body }
  const keep = new Set<string>()

  switch (wire.dialect) {
    case 'chat.effort':
      keep.add('reasoning_effort')
      // `enable_thinking` stays: it is a provider-level opt-in (DashScope),
      // not a dialect-owned value.
      keep.add('enable_thinking')
      break
    case 'chat.thinking_budget':
      keep.add('thinking_budget')
      keep.add('enable_thinking')
      break
    case 'chat.enable_thinking':
      keep.add('enable_thinking')
      keep.add('thinking_budget')
      break
    case 'chat.reasoning_obj': {
      const effort = next.reasoning_effort
      keep.add('enable_thinking')
      keep.add('reasoning')
      if (
        typeof effort === 'string' &&
        effort.length > 0 &&
        effort !== 'default'
      ) {
        next.reasoning = { effort }
      }
      break
    }
    case 'chat.none':
      break
    default:
      return body
  }

  for (const key of OPENAI_MANAGED_KEYS) {
    if (!keep.has(key)) delete next[key]
  }

  if (wire.dialect === 'chat.thinking_budget') {
    if (wire.budgetTokens !== undefined) {
      next.thinking_budget = wire.budgetTokens
    } else {
      delete next.thinking_budget
    }
  }
  if (wire.dialect === 'chat.enable_thinking') {
    next.enable_thinking = true
    if (wire.budgetTokens !== undefined) {
      next.thinking_budget = wire.budgetTokens
    } else {
      delete next.thinking_budget
    }
  }
  if (wire.dialect === 'chat.effort') {
    if (
      typeof next.reasoning_effort !== 'string' ||
      next.reasoning_effort.length === 0 ||
      next.reasoning_effort === 'default'
    ) {
      delete next.reasoning_effort
    }
  }
  return next
}

// ---------------------------------------------------------------------------
// Anthropic-compatible
// ---------------------------------------------------------------------------

/**
 * Provider options for `@ai-sdk/anthropic` (namespace `anthropic`).
 *
 * The SDK maps `effort` → wire `output_config.effort` and
 * `thinking:{type:'enabled',budgetTokens}` → `thinking:{type:'enabled',
 * budget_tokens}`. `reasoningEffort` is NOT part of its schema, which is why
 * the old injection was silently stripped.
 */
export function anthropicReasoningProviderOptions(
  wire: ReasoningWireDescriptor | undefined,
  effort: string | undefined,
): Record<string, unknown> | undefined {
  if (!wire) return undefined
  const requested = effort && effort !== 'default' ? effort : undefined

  switch (wire.dialect) {
    case 'claude.none':
      return undefined
    case 'claude.budget':
      if (wire.budgetTokens === undefined) return undefined
      return {
        thinking: { type: 'enabled', budgetTokens: wire.budgetTokens },
      }
    case 'claude.effort':
    case 'auto':
    default: {
      if (!requested) return undefined
      if (!CLAUDE_EFFORT_VALUES.has(requested)) {
        logOnce(
          `effort:${wire.dialect}:${requested}`,
          `${COMPAT_LOG_PREFIX} reasoning-wire: '${wire.dialect}' supports low/medium/high only — '${requested}' not sent`,
        )
        return undefined
      }
      return { effort: requested }
    }
  }
}
