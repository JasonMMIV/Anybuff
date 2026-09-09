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
 * Values are persisted verbatim; `xhigh` is normalized to the SDK-canonical
 * `extra-high` spelling (same rung, per the SDK alias table).
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
    const normalizedOpts = opts.map((o) => (o === 'xhigh' ? 'extra-high' : o))
    if (!normalizedOpts.includes('default')) {
      normalizedOpts.unshift('default')
    }
    return normalizedOpts
  }

  // Conservative fallback for unknown models: the two rungs nearly every
  // ladder shares. Deliberately no `medium`.
  return ['default', 'low', 'high']
}
