/**
 * Per-model reasoning-effort options for the Composer and agent-routing menus.
 *
 * ADR-25: ladders resolved by the host (`getAppSettings().reasoningLadders` —
 * explicit anybuff.json `modelCapabilities` declarations first, then the
 * SDK-verified seed table `VERIFIED_REASONING_EFFORTS`) are authoritative:
 * they describe what the endpoint actually accepts. The former deprecated
 * static map (`anybuff-models.json`) was deleted 2026-09-09 — the active
 * model set now lives in the SDK seed table (verified against models.dev),
 * and anything with no ladder anywhere gets the conservative fallback below.
 * The fallback offers only `low`/`high` — `medium` was dropped because
 * DeepSeek-family endpoints have no distinct medium template and strict
 * gateways reject it with a 400.
 *
 * Values are persisted verbatim (ADR-27 MC-0.2b): `xhigh` and `extra-high`
 * are DIFFERENT wire literals sharing a rung — no layer may rewrite one into
 * the other; the equivalence is a display-only hint (§2.1).
 */
export function getReasoningOptionsForModel(
  modelId: string | undefined,
  ladders: Record<string, string[]> = {}
): string[] {
  if (!modelId) return ['default']
  const bareModel = modelId.split('/').pop() || ''

  // Provider-qualified key (`${providerId}/${model}`) wins — a provider that
  // declares its own ladder for a model overrides the bare-id truth for that
  // route; bare id (SDK seed ladders) second.
  const resolved =
    ladders[modelId] ?? ladders[bareModel] ?? ladders[bareModel.toLowerCase()]

  let opts: string[] = []
  if (resolved?.length) {
    opts = resolved
  }

  if (opts.length > 1 || (opts.length === 1 && opts[0] !== 'default')) {
    // ADR-27 MC-0.2b: literals pass through VERBATIM — `xhigh` and
    // `extra-high` are different wire strings on the same rung, so no
    // display layer may rewrite one into the other (§2.1).
    // Copy even when 'default' is already present — never hand back the
    // caller's (React state) array reference.
    return opts.includes('default') ? [...opts] : ['default', ...opts]
  }

  // Conservative fallback for unknown models: the two rungs nearly every
  // ladder shares. Deliberately no `medium`.
  return ['default', 'low', 'high']
}
