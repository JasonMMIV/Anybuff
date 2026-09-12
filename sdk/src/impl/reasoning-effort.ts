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
 *
 * 2026-09-09 migration: the Desktop legacy map
 * (desktop/src/renderer/src/utils/anybuff-models.json) was deleted. The rows
 * below were verified against models.dev (the same MIT catalog the
 * provider presets reconcile against — see maintenance guide 備註 E #6),
 * preferring each model's official provider declaration where one exists
 * (`official:<provider>`); remaining rows reflect the widest shared
 * openai-compatible gateway declaration for that model. All rows carry
 * `verifiedAt: 2026-09-09` + source and fall under non-negotiable #5's
 * freshness regime (re-verify quarterly or when a 400 names an allowed-value
 * set). `defaultEffort` for non-DeepSeek rows is the ladder's high rung (or
 * midpoint when the ladder has no high) — display-oriented only, never used
 * for clamping.
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

  // ── Active model set verified against models.dev (2026-09-09) ─────────────
  // Covers the provider-preset + opencode-go model lists that the Desktop
  // legacy map used to serve. Both spellings of a model (dot vs dash) are
  // seeded because lookup keys are literal bare ids.
  'claude-haiku-4-5': {
    efforts: ['low', 'medium', 'high', 'extra-high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (llmgateway-providers)',
  },
  'claude-opus-4-1': {
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (pioneer)',
  },
  'claude-opus-4-5': {
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:anthropic)',
  },
  'claude-opus-4.1': {
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (pioneer)',
  },
  'claude-sonnet-4-5': {
    efforts: ['low', 'medium', 'high', 'extra-high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (llmgateway-providers)',
  },
  'claude-sonnet-4.5': {
    efforts: ['low', 'medium', 'high', 'extra-high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (llmgateway-providers)',
  },
  'deepseek-v4-flash-vision-exp': {
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:deepseek)',
  },
  'glm-4.5-air': {
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (kilo)',
  },
  'glm-4.6': {
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (nano-gpt)',
  },
  'glm-5': {
    efforts: ['none', 'low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (digitalocean)',
  },
  'glm-5.1': {
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (nano-gpt)',
  },
  'glm-5.2': {
    efforts: ['high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:zai)',
  },
  'glm-5.3': {
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:zai)',
  },
  'glm-5.3-flash': {
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:zai)',
  },
  'gpt-5.1': {
    efforts: ['none', 'low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:openai)',
  },
  'gpt-5.1-codex': {
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (nano-gpt)',
  },
  'gpt-5.1-codex-mini': {
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (nano-gpt)',
  },
  'gpt-5.2': {
    efforts: ['none', 'low', 'medium', 'high', 'extra-high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:openai)',
  },
  'gpt-5.2-chat-latest': {
    efforts: ['medium'],
    defaultEffort: 'medium',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:openai)',
  },
  'gpt-5.2-codex': {
    efforts: ['low', 'medium', 'high', 'extra-high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (nano-gpt)',
  },
  'gpt-5.4': {
    efforts: ['none', 'low', 'medium', 'high', 'extra-high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:openai)',
  },
  'gpt-5.4-mini': {
    efforts: ['none', 'low', 'medium', 'high', 'extra-high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:openai)',
  },
  'gpt-5.4-nano': {
    efforts: ['none', 'low', 'medium', 'high', 'extra-high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:openai)',
  },
  'gpt-5.5': {
    efforts: ['none', 'low', 'medium', 'high', 'extra-high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:openai)',
  },
  'gpt-5.6-luna': {
    efforts: ['none', 'low', 'medium', 'high', 'extra-high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:openai)',
  },
  'grok-4.5': {
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:xai)',
  },
  'grok-4.6': {
    efforts: ['low', 'medium', 'high', 'extra-high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:xai)',
  },
  'hy3': {
    // AnyBuff's actual serving endpoint for hy3 is opencode-go, which
    // declares [none, low, high] — the narrower official tencent-tokenhub
    // row ([none, high]) would clamp a legitimate `low` pick down to `none`.
    efforts: ['none', 'low', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (opencode-go)',
  },
  'hy3-preview': {
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:tencent-tokenhub)',
  },
  'hy4-preview': {
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:tencent-tokenhub)',
  },
  'kimi-k2.5': {
    efforts: ['none', 'low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (digitalocean)',
  },
  'kimi-k2.6': {
    efforts: ['none', 'minimal', 'low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (greenpt)',
  },
  'kimi-k2.7-code': {
    efforts: ['none', 'minimal', 'low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (greenpt)',
  },
  'kimi-k3': {
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:moonshotai)',
  },
  'longcat-2.0': {
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (kilo)',
  },
  'mimo-v2.5': {
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (nano-gpt)',
  },
  'mimo-v2.5-pro': {
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (nano-gpt)',
  },
  'minimax-m2.5': {
    efforts: ['none', 'minimal', 'low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (greenpt)',
  },
  'minimax-m2.7': {
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (scx-ai)',
  },
  'minimax-m3': {
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (ollama-cloud)',
  },
  'muse-spark-1.2-contributor': {
    efforts: ['minimal', 'low', 'medium', 'high', 'extra-high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:meta)',
  },
  'muse-spark-1.3-contributor': {
    efforts: ['minimal', 'low', 'medium', 'high', 'extra-high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:meta)',
  },
  'omen-alpha': {
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (opencode-go)',
  },
  'qwen3.5-plus': {
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (zenmux)',
  },
  'qwen3.6-plus': {
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'extra-high', 'max'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (llmgateway-providers)',
  },
  'qwen3.7-max': {
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (nano-gpt)',
  },
  'qwen3.7-plus': {
    efforts: ['none', 'high'],
    defaultEffort: 'high',
    verifiedAt: '2026-09-09',
    source: 'models.dev (nano-gpt)',
  },
  'qwen3.8-flash': {
    efforts: ['low', 'medium', 'extra-high'],
    defaultEffort: 'medium',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:alibaba)',
  },
  'qwen3.8-max': {
    efforts: ['low', 'medium', 'extra-high'],
    defaultEffort: 'medium',
    verifiedAt: '2026-09-09',
    source: 'models.dev (official:alibaba)',
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
 * Prefix candidates are resolved by LONGEST seed key: with a dense seed set
 * (`gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`) a suffixed variant such
 * as `gpt-5.1-codex-spark` must land on `gpt-5.1-codex`, not the shorter
 * `gpt-5.1` prefix that also matches.
 */
export function findVerifiedReasoningLadder(
  model: string | undefined,
): VerifiedReasoningLadder | undefined {
  if (!model) return undefined
  const key = normalizeSeedModelKey(model)
  const exact = VERIFIED_REASONING_EFFORTS[key]
  if (exact) return exact
  let bestKey: string | undefined
  for (const seedKey of Object.keys(VERIFIED_REASONING_EFFORTS)) {
    if (key.startsWith(`${seedKey}:`) || key.startsWith(`${seedKey}-`)) {
      if (bestKey === undefined || seedKey.length > bestKey.length) {
        bestKey = seedKey
      }
    }
  }
  return bestKey ? VERIFIED_REASONING_EFFORTS[bestKey] : undefined
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

/**
 * The full seed rows (efforts/defaultEffort/requestMap plus provenance:
 * verifiedAt/source), keyed by bare model id. ADR-27 (MC-0.3): provenance
 * must leave the SDK so hosts can badge every menu value with "who says
 * so, and when" — the user-facing side of non-negotiable #5's freshness
 * regime. Returns the same readonly table as VERIFIED_REASONING_EFFORTS;
 * the named accessor exists so hosts don't reach into the raw export.
 */
export function getVerifiedReasoningLadderRows(): Readonly<
  Record<string, VerifiedReasoningLadder>
> {
  return VERIFIED_REASONING_EFFORTS
}

/**
 * Whether a value falls inside the shared effort vocabulary (the common
 * constants list plus the SDK-config alias/none spellings). Values outside
 * it are still legal (ADR-27 open domain) — this only lets a UI badge an
 * unrecognized spelling as "possibly a new rung or a typo; sent verbatim".
 */
const KNOWN_EFFORT_SPELLINGS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'extra-high',
  'max',
  'ultra',
  'none',
])

export function isKnownReasoningSpelling(value: string): boolean {
  return KNOWN_EFFORT_SPELLINGS.has(value)
}
