/**
 * Verified per-model reasoning-effort ladders + the request-time clamp
 * (ADR-25).
 *
 * WHY THIS EXISTS (2026-09-09): AnyBuff is BYOK — there is no hosted
 * completions layer to clamp a user's reasoning-effort pick against the
 * model's native levels, so the client must own that knowledge. A custom
 * gateway proxying `deepseek-v4-flash` strictly validates the
 * `reasoning_effort` value set and 400s on anything outside `low`/`high`/`max`
 * — while the Desktop menu (fed by a stale hand-maintained map) offered
 * `minimal`/`medium`/`extra-high`. Every non-default pick failed.
 *
 * Layering (see the maintenance guide, ADR-25):
 * 1. Explicit `modelCapabilities.reasoning.efforts` declarations in
 *    anybuff.json always win.
 * 2. VERIFIED_REASONING_EFFORTS below fills the gap for models whose native
 *    ladders are vendor-documented. Each row carries `verifiedAt` + `source` —
 *    this table has an expiry date (non-negotiable #5): re-verify against the
 *    vendor's docs quarterly or whenever a 400 names an allowed-value set.
 * 3. Models with NEITHER are sent verbatim — no guessing. A loud 400 is the
 *    correct outcome there (and the future self-healing layer's input);
 *    silently stripping or "clamping" without knowledge would be
 *    suppression's close cousin (ADR-10).
 *
 * The DeepSeek rows mirror `DEEPSEEK_V4_REASONING_EFFORTS` in
 * common/src/constants/freebuff-models.ts (the two are locked by a parity
 * test). DeepSeek accepts any `reasoning_effort` string without complaint —
 * `"gigantic"` returns a normal 200 (verified 2026-08-12) — so acceptance
 * proves nothing about a rung being distinct; only the vendor's documented
 * table is truth, and it can never be derived by probing.
 */

import type { AnybuffReasoningEffort } from '../provider-config'

export interface VerifiedReasoningLadder {
  /** Native rungs the endpoint accepts, ascending. */
  readonly efforts: readonly AnybuffReasoningEffort[]
  /** The vendor's documented default. */
  readonly defaultEffort: AnybuffReasoningEffort
  /**
   * Vendor-documented requested→actual mapping, in canonical SDK spelling.
   * Takes precedence over generic clamp-DOWN because the two can disagree:
   * DeepSeek maps `medium`→`high` (a naive clamp-down would send `low` — the
   * opposite end of the ladder).
   */
  readonly requestMap?: Readonly<
    Partial<Record<AnybuffReasoningEffort, AnybuffReasoningEffort>>
  >
  /** When the row was last verified against `source`. */
  readonly verifiedAt: string
  /** Where the ladder was verified. */
  readonly source: string
}

/**
 * Ordered rank ladder in canonical SDK spelling. `xhigh` (the shared/common
 * vocabulary's spelling) is an alias of `extra-high` — same rung. Values
 * outside the vocabulary rank -1 and are passed through untouched.
 */
const EFFORT_RANK: readonly string[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'extra-high',
  'max',
  'ultra',
]

function canonicalEffort(value: string): string {
  return value === 'xhigh' ? 'extra-high' : value
}

function effortRank(value: string): number {
  return EFFORT_RANK.indexOf(canonicalEffort(value))
}

/**
 * Vendor-verified ladders, keyed by bare model id (lowercase). Lookup is
 * variant-tolerant: a dated/suffixed build of a documented model cannot dodge
 * its ladder (`deepseek-v4-flash-max`, `deepseek-v4-pro:free`,
 * `DeepSeek-V4-Flash` all resolve to their base row).
 */
export const VERIFIED_REASONING_EFFORTS: Readonly<
  Record<string, VerifiedReasoningLadder>
> = {
  // DeepSeek publishes one requested→actual table for the whole V4 family
  // (api-docs.deepseek.com/guides/thinking_mode, verified 2026-08-12):
  // low→low, medium→high, high→high, xhigh→high, max→max. `medium` is not a
  // distinct template — deliberately absent from the ladder.
  'deepseek-v4-flash': {
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    requestMap: {
      low: 'low',
      medium: 'high',
      high: 'high',
      'extra-high': 'high',
      max: 'max',
    },
    verifiedAt: '2026-08-12',
    source: 'api-docs.deepseek.com/guides/thinking_mode',
  },
  'deepseek-v4-pro': {
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    requestMap: {
      low: 'low',
      medium: 'high',
      high: 'high',
      'extra-high': 'high',
      max: 'max',
    },
    verifiedAt: '2026-08-12',
    source: 'api-docs.deepseek.com/guides/thinking_mode',
  },
}

/** Normalize a (possibly provider-qualified) model id for seed lookup. */
function normalizeSeedModelKey(model: string): string {
  const withoutVersion = model.split('@')[0] ?? model
  const bare = withoutVersion.includes('/')
    ? withoutVersion.split('/').at(-1)!
    : withoutVersion
  return bare.trim().toLowerCase()
}

/**
 * The verified ladder for a model, if one is seeded. Exact (normalized) match
 * first; then variant suffixes (`:free`, `-max`, dated builds) fall back to
 * their base row — same underlying model, same native reasoning templates.
 */
export function findVerifiedReasoningLadder(
  model: string | undefined,
): VerifiedReasoningLadder | undefined {
  if (!model) return undefined
  const key = normalizeSeedModelKey(model)
  const exact = VERIFIED_REASONING_EFFORTS[key]
  if (exact) return exact
  for (const seedKey of Object.keys(VERIFIED_REASONING_EFFORTS)) {
    if (key.startsWith(`${seedKey}:`) || key.startsWith(`${seedKey}-`)) {
      return VERIFIED_REASONING_EFFORTS[seedKey]
    }
  }
  return undefined
}

/**
 * Clamp a requested effort onto a declared ladder:
 * 1. alias-normalize (`xhigh` → `extra-high`);
 * 2. the vendor requestMap wins (documented requested→actual, e.g. DeepSeek
 *    `medium`→`high` — NOT the clamp-down result `low`);
 * 3. an exact rung passes through;
 * 4. otherwise clamp DOWN to the highest rung not above the request; a request
 *    below every rung lands on the lowest rung (closest to what was asked);
 * 5. values outside the shared vocabulary pass through unchanged — never
 *    silently rewritten (fail loud; ADR-10).
 */
export function clampReasoningEffortToLadder(
  requested: string,
  ladder: readonly string[],
  requestMap?: Readonly<Partial<Record<string, string>>>,
): string {
  if (ladder.length === 0) return requested
  const canonical = canonicalEffort(requested)
  const mapped = requestMap?.[canonical]
  if (mapped !== undefined && ladder.includes(mapped)) return mapped
  if (ladder.includes(canonical)) return canonical
  const wanted = effortRank(canonical)
  if (wanted < 0) return requested
  let best: string | undefined
  let lowest: string | undefined
  for (const rung of ladder) {
    const rank = effortRank(rung)
    if (rank < 0) continue
    if (lowest === undefined || rank < effortRank(lowest)) lowest = rung
    if (rank > wanted) continue
    if (best === undefined || rank > effortRank(best)) best = rung
  }
  return best ?? lowest ?? requested
}

/**
 * The seed table as a bare-id → efforts map, for hosts to fold into their
 * settings views (Desktop's reasoning menu; ADR-25).
 */
export function getVerifiedReasoningLadders(): Record<
  string,
  readonly AnybuffReasoningEffort[]
> {
  return Object.fromEntries(
    Object.entries(VERIFIED_REASONING_EFFORTS).map(([key, row]) => [
      key,
      row.efforts,
    ]),
  )
}
