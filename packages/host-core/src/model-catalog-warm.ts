/**
 * ADR-31 (trigger = configuration change, OmniChat §6.3): the models.dev
 * catalog is warmed ONLY from explicit configuration events — never on startup,
 * never on an unchanged Settings save, and never inside a run.
 *
 *   - a model added by `saveSettings` → bounded warm of just those pairs;
 *   - first open of the capabilities panel in a process → bounded warm of the
 *     pairs that still have no ladder anywhere;
 *   - everything else (getState, unchanged saves, later panel opens) reads the
 *     already-loaded in-memory catalog — zero network.
 *
 * Snapshot hits return synchronously (no HTTP). The wait is capped so a
 * Settings surface can never hang on models.dev; catalog values are still never
 * written back to settings (ADR-31 §6). Run paths keep their own fire-and-forget
 * prefetch (`hydrateUnknownModelCaps`) and must never await this.
 */

import { prefetchModelCatalogForModel } from '@codebuff/sdk'
import { buildReasoningLadders, type ProviderConfig } from './settings/settings'

/** Upper bound for a configuration surface (the capabilities panel). */
export const DEFAULT_CATALOG_WARM_TIMEOUT_MS = 5000

/** One `(provider, model)` pair to look up in the catalog. */
export interface CatalogWarmTarget {
  providerId: string
  providerName?: string
  baseURL?: string
  model: string
  catalogProvider?: string
  catalogKeys?: Record<string, string>
}

/** Diagnostics for the bounded warm (asserted by the trigger tests; the
 *  production paths ignore them — rows are complete either way). */
export interface CatalogWarmResult {
  /** Pairs that were worth looking up (no declared/seed/catalog rung). */
  checked: number
  /** True when the lookup outlived the budget — the refresh keeps running. */
  pending: boolean
}

/** Build a lookup target from a configured provider entry. */
export function catalogWarmTarget(provider: ProviderConfig, model: string): CatalogWarmTarget {
  return {
    providerId: provider.id,
    ...(provider.label ? { providerName: provider.label } : {}),
    ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
    model,
    ...(provider.catalogProvider ? { catalogProvider: provider.catalogProvider } : {}),
    ...(provider.catalogKeys ? { catalogKeys: provider.catalogKeys } : {}),
  }
}

/**
 * Bounded warm of an explicit pair list (the `saveSettings` trigger).
 *
 * Pairs are deduped; a catalog hit resolves without a request. The budget only
 * caps how long the CONFIG surface waits — a timed-out refresh keeps running in
 * the background and the next lookup sees it.
 */
export async function warmModelCatalogForModels(
  targets: CatalogWarmTarget[],
  opts: { timeoutMs?: number } = {}
): Promise<CatalogWarmResult> {
  const seen = new Set<string>()
  const attempts: Array<Promise<boolean>> = []
  for (const target of targets) {
    const key = `${target.providerId}::${target.model}`
    if (seen.has(key)) continue
    seen.add(key)
    attempts.push(prefetchModelCatalogForModel(target))
  }
  if (attempts.length === 0) return { checked: 0, pending: false }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CATALOG_WARM_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    // Never reject: a failed lookup simply leaves the rows as they are.
    const settled = Promise.all(attempts).then(
      () => 'done' as const,
      () => 'done' as const
    )
    const outcome = await Promise.race([settled, budget])
    return { checked: attempts.length, pending: outcome === 'timeout' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Bounded warm of every configured pair that has no ladder anywhere (declared,
 * seed or catalog). Used by the capabilities panel's first open in a process.
 */
export function warmModelCatalogForProviders(
  providers: ProviderConfig[],
  opts: { timeoutMs?: number } = {}
): Promise<CatalogWarmResult> {
  const ladders = buildReasoningLadders(providers)
  const targets: CatalogWarmTarget[] = []
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      if ((ladders[`${provider.id}/${model}`] ?? []).length > 0) continue
      targets.push(catalogWarmTarget(provider, model))
    }
  }
  return warmModelCatalogForModels(targets, opts)
}
