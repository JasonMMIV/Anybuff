/**
 * models.dev catalog runtime: cache, HTTP and lookup access.
 *
 * Layer order (plan §6.1):
 *   1. memory (an already-built index)
 *   2. `dataDir/model-catalog-cache.json` (written by a previous refresh)
 *   3. the build-time snapshot (`model-catalog-snapshot.ts`)
 *
 * Startup never touches the network. Refreshes are EVENT-DRIVEN (new
 * provider/model, stale cache, manual) — there is no timer (plan §6.3).
 *
 * Everything here is best-effort: a failed fetch, a corrupt cache or an empty
 * snapshot degrades to "no catalog value", never to a failed run. The pure
 * parsing/indexing/lookup lives in `model-catalog.ts`; this module only owns
 * state, I/O and the one-shot hydration bookkeeping left over from B1d.
 */

import { loadProviderConfigSync } from '../provider-config'
import {
  MODEL_CATALOG_SCHEMA_VERSION,
  buildModelCatalogIndex,
  catalogAliasProviderIdsFor,
  catalogContextWindow,
  catalogOutputTokens,
  lookupCatalogModel,
  projectModelsDevCatalog,
  type CatalogLookupResult,
  type CatalogIndexSource,
  type ModelCatalogIndex,
  type ProjectedCatalog,
} from './model-catalog'
import * as snapshotModule from './model-catalog-snapshot'

/** models.dev api.json — the single upstream catalog (MIT). */
const MODELS_DEV_API_URL = 'https://models.dev/api.json'

/** How long a catalog HTTP request may take before we give up. */
const CATALOG_TIMEOUT_MS = 15_000

/** Refuse oversized payloads before parsing them (plan §6.2). */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024

/** Default staleness window for event-driven refreshes. */
const DEFAULT_STALE_DAYS = 30

/** Plausible context-window range — same guard as A2's learned windows. */
const MIN_PLAUSIBLE_WINDOW = 4_000
const MAX_PLAUSIBLE_WINDOW = 32_000_000

const CATALOG_LOG_PREFIX = '[anybuff-catalog]'

/** One model's capability fields the legacy hydration path returns. */
export type HydratedCapabilities = {
  windowTokens?: number
  outputTokens?: number
}

/** Host-injected disk cache seam (plan §6.5). */
export type ModelCatalogCacheSeam = {
  load: () => Promise<string | null> | string | null
  save: (json: string) => Promise<void> | void
}

/** Disk cache payload — the snapshot rows plus HTTP bookkeeping. */
type CatalogCachePayload = ProjectedCatalog & {
  fetchedAt?: string
  etag?: string
}

export type ModelCatalogStatus = {
  source: CatalogIndexSource
  snapshotAt: string
  fetchedAt?: string
  providers: number
  entries: number
  cacheLoaded: boolean
  online: boolean
}

// ---------------------------------------------------------------------------
// Process state
// ---------------------------------------------------------------------------

let memoryIndex: ModelCatalogIndex | null = null
let cacheSeam: ModelCatalogCacheSeam | undefined
let cacheLoadStarted = false
let cacheLoadPromise: Promise<void> | null = null
let refreshPromise: Promise<boolean> | null = null
let etag: string | undefined
let fetchedAt: string | undefined
/** The last payload this process loaded/refreshed (reused by a 304 write). */
let lastPayload: CatalogCachePayload | undefined
let onlineOverride: boolean | undefined
let warnedOffline = false
/**
 * Invalidates in-flight loads/refreshes. A reset (test seam) or a new cache
 * seam must not be overwritten by an older promise that resolves later.
 */
let catalogEpoch = 0
const refreshedForModel = new Set<string>()

// ---------------------------------------------------------------------------
// Built-in snapshot
// ---------------------------------------------------------------------------

function snapshotPayload(): ProjectedCatalog {
  return {
    schemaVersion: snapshotModule.MODEL_CATALOG_SCHEMA_VERSION,
    snapshotAt: snapshotModule.MODEL_CATALOG_SNAPSHOT_AT,
    models: [...snapshotModule.MODEL_CATALOG_MODELS],
    providers: [...snapshotModule.MODEL_CATALOG_PROVIDERS],
  }
}

function buildSnapshotIndex(): ModelCatalogIndex {
  return buildModelCatalogIndex(snapshotPayload(), {
    snapshotAt: snapshotModule.MODEL_CATALOG_SNAPSHOT_AT,
    source: 'snapshot',
  })
}

/**
 * The current catalog index (memory → snapshot). Synchronous by design: the
 * resolver runs inside request routing and must never await I/O.
 */
export function getModelCatalog(): ModelCatalogIndex {
  if (!memoryIndex) memoryIndex = buildSnapshotIndex()
  return memoryIndex
}

export function getModelCatalogStatus(): ModelCatalogStatus {
  const index = getModelCatalog()
  const effectiveFetchedAt = index.fetchedAt ?? fetchedAt
  return {
    source: index.source,
    snapshotAt: index.snapshotAt,
    ...(effectiveFetchedAt ? { fetchedAt: effectiveFetchedAt } : {}),
    providers: index.providers.size,
    entries: index.size,
    cacheLoaded: cacheLoadStarted,
    online: catalogOnline(),
  }
}

// ---------------------------------------------------------------------------
// Online switch (anybuff.json `modelCatalog.online`, default true)
// ---------------------------------------------------------------------------

function catalogOnline(): boolean {
  if (onlineOverride !== undefined) return onlineOverride
  try {
    const configured = loadProviderConfigSync().config.modelCatalog?.online
    return configured !== false
  } catch {
    // A config read failure must never disable the catalog outright.
    return true
  }
}

/** Host/test override of the `modelCatalog.online` config flag. */
export function setModelCatalogOnline(online: boolean | undefined): void {
  onlineOverride = online
}

// ---------------------------------------------------------------------------
// Disk cache (host-injected seam; absent = memory + snapshot only)
// ---------------------------------------------------------------------------

/**
 * Install the host's disk cache seam. Safe to call once per process: the
 * first call also kicks off the asynchronous disk load (startup stays
 * non-blocking — lookups before it finishes read the snapshot).
 */
export function configureModelCatalogCache(seam: ModelCatalogCacheSeam): void {
  // A new seam (e.g. a test host re-installing its env for a different
  // dataDir) must be allowed to load its own cache — the old flags belonged
  // to the previous path.
  catalogEpoch += 1
  cacheSeam = seam
  cacheLoadStarted = false
  cacheLoadPromise = null
  void warmModelCatalogCache()
}

function parseCachePayload(json: string): CatalogCachePayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    console.warn(`${CATALOG_LOG_PREFIX} cache: unreadable JSON — ignoring`)
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const payload = parsed as Record<string, unknown>
  if (payload.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
    console.info(
      `${CATALOG_LOG_PREFIX} cache: schemaVersion ${String(payload.schemaVersion)} != ${MODEL_CATALOG_SCHEMA_VERSION} — ignoring`,
    )
    return null
  }
  if (!Array.isArray(payload.models) || !Array.isArray(payload.providers)) {
    return null
  }
  return {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    snapshotAt:
      typeof payload.snapshotAt === 'string'
        ? payload.snapshotAt
        : snapshotModule.MODEL_CATALOG_SNAPSHOT_AT,
    models: payload.models as ProjectedCatalog['models'],
    providers: payload.providers as ProjectedCatalog['providers'],
    ...(typeof payload.fetchedAt === 'string'
      ? { fetchedAt: payload.fetchedAt }
      : {}),
    ...(typeof payload.etag === 'string' ? { etag: payload.etag } : {}),
  }
}

/**
 * Load the disk cache once, replacing the snapshot index when it is valid.
 * Never throws; a broken cache simply leaves the snapshot in place.
 */
export async function warmModelCatalogCache(): Promise<void> {
  if (cacheLoadPromise) return cacheLoadPromise
  if (cacheLoadStarted || !cacheSeam) return
  cacheLoadStarted = true
  const epoch = catalogEpoch
  const load = (async () => {
    try {
      const raw = await cacheSeam!.load()
      // A reset/new seam happened while the load was in flight — the old
      // payload belongs to a previous generation and must not win.
      if (epoch !== catalogEpoch) return
      if (!raw) return
      const payload = parseCachePayload(raw)
      if (!payload) return
      const index = buildModelCatalogIndex(payload, {
        snapshotAt: payload.snapshotAt,
        ...(payload.fetchedAt ? { fetchedAt: payload.fetchedAt } : {}),
        source: 'cache',
      })
      if (index.size === 0) return
      memoryIndex = index
      fetchedAt = payload.fetchedAt
      etag = payload.etag
      lastPayload = payload
      console.info(
        `${CATALOG_LOG_PREFIX} cache loaded — ${index.providers.size} providers / ${index.size} models (fetched ${payload.fetchedAt ?? 'unknown'})`,
      )
    } catch (error) {
      console.warn(
        `${CATALOG_LOG_PREFIX} cache load failed — keeping the built-in snapshot (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  })().finally(() => {
    // Identity, not epoch: an epoch bump during the load must not clobber the
    // PROMISE HANDLE of a newer generation (that would wedge the loader).
    if (cacheLoadPromise === load) cacheLoadPromise = null
  })
  cacheLoadPromise = load
  return load
}

async function persistCache(payload: CatalogCachePayload): Promise<void> {
  if (!cacheSeam) return
  try {
    await cacheSeam.save(JSON.stringify(payload))
  } catch (error) {
    // Disk persistence is best-effort: the in-memory index is already live.
    console.warn(
      `${CATALOG_LOG_PREFIX} cache write failed (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Refresh the catalog from models.dev.
 *
 * - single-flight: concurrent callers share one request;
 * - ETag: a 304 only bumps `fetchedAt` (the rows are already current);
 * - failures keep the previous index and never surface as run errors.
 */
export function refreshModelCatalog(): Promise<boolean> {
  if (refreshPromise) return refreshPromise
  if (!catalogOnline()) {
    if (!warnedOffline) {
      warnedOffline = true
      console.info(
        `${CATALOG_LOG_PREFIX} online refresh disabled (modelCatalog.online=false) — using the built-in snapshot`,
      )
    }
    return Promise.resolve(false)
  }

  const epoch = catalogEpoch
  // `let` (not const) so a synchronous throw before the first await cannot hit
  // the finally while the binding is still in its temporal dead zone.
  let run: Promise<boolean> | null = null
  run = (async () => {
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (etag) headers['if-none-match'] = etag
      const response = await globalThis.fetch(MODELS_DEV_API_URL, {
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
        headers,
      })
      // A reset/new state superseded this attempt while it was in flight.
      if (epoch !== catalogEpoch) return false
      if (response.status === 304) {
        fetchedAt = new Date().toISOString()
        if (memoryIndex) {
          memoryIndex = { ...memoryIndex, fetchedAt }
        }
        console.info(`${CATALOG_LOG_PREFIX} refresh: 304 not modified`)
        // Only `fetchedAt` moves — the rows are already current. Reuse the
        // last payload instead of re-encoding the live index (there is no
        // reverse projection by design).
        await persistCache({
          ...(lastPayload ?? snapshotPayload()),
          snapshotAt: getModelCatalog().snapshotAt,
          fetchedAt,
          ...(etag ? { etag } : {}),
        })
        return true
      }
      if (!response.ok) {
        console.warn(
          `${CATALOG_LOG_PREFIX} refresh failed: HTTP ${response.status} — keeping the previous catalog`,
        )
        return false
      }
      const text = await response.text()
      if (epoch !== catalogEpoch) return false
      if (text.length > MAX_RESPONSE_BYTES) {
        console.warn(
          `${CATALOG_LOG_PREFIX} refresh rejected: payload ${text.length} bytes > ${MAX_RESPONSE_BYTES} cap`,
        )
        return false
      }
      const raw: unknown = JSON.parse(text)
      const snapshotAt = new Date().toISOString()
      const payload = projectModelsDevCatalog(raw, { snapshotAt })
      if (payload.providers.length === 0) {
        console.warn(
          `${CATALOG_LOG_PREFIX} refresh rejected: projection produced zero providers`,
        )
        return false
      }
      const nextEtag = response.headers.get('etag') ?? undefined
      const index = buildModelCatalogIndex(payload, {
        snapshotAt,
        fetchedAt: snapshotAt,
        source: 'network',
      })
      memoryIndex = index
      fetchedAt = snapshotAt
      etag = nextEtag
      lastPayload = { ...payload, fetchedAt: snapshotAt, ...(nextEtag ? { etag: nextEtag } : {}) }
      console.info(
        `${CATALOG_LOG_PREFIX} refreshed — ${index.providers.size} providers / ${index.size} models`,
      )
      await persistCache({
        ...payload,
        fetchedAt: snapshotAt,
        ...(nextEtag ? { etag: nextEtag } : {}),
      })
      return true
    } catch (error) {
      console.warn(
        `${CATALOG_LOG_PREFIX} refresh failed — keeping the previous catalog (${error instanceof Error ? error.message : String(error)})`,
      )
      return false
    } finally {
      // Identity, not epoch: a settled old run must never clear a newer
      // in-flight refresh's single-flight handle.
      if (refreshPromise === run) refreshPromise = null
    }
  })()
  refreshPromise = run
  return run
}

function latestFreshness(): number | undefined {
  const candidates = [fetchedAt, getModelCatalog().snapshotAt]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
  return candidates.length > 0 ? Math.max(...candidates) : undefined
}

/** Refresh only when the newest known catalog copy is older than N days. */
export function refreshModelCatalogIfStale(
  staleDays: number = DEFAULT_STALE_DAYS,
): Promise<boolean> {
  const latest = latestFreshness()
  if (latest !== undefined) {
    const ageMs = Date.now() - latest
    if (ageMs >= 0 && ageMs < staleDays * 24 * 60 * 60 * 1000) {
      return Promise.resolve(false)
    }
  }
  return refreshModelCatalog()
}

/**
 * Event-driven prefetch for a model the catalog did not know at request time
 * (plan §6.3). Fire-and-forget: the current run keeps whatever the resolver
 * already produced; the next lookup sees the fresh catalog.
 *
 * The pair is attempted once per process — a refreshed catalog covers every
 * pair at once. A FAILED refresh leaves the pair retryable (the marker is
 * written only after a successful refresh). Configuration-time callers bound
 * their own wait (`packages/host-core/src/model-catalog-warm.ts`); runs never
 * await this.
 */
export function prefetchModelCatalogForModel(params: {
  providerId: string
  providerName?: string
  baseURL?: string
  model: string
  catalogProvider?: string
  catalogKeys?: Record<string, string>
}): Promise<boolean> {
  if (lookupCatalogModel(getModelCatalog(), params)) {
    return Promise.resolve(false)
  }
  const key = `${params.providerId}::${params.model}`
  if (refreshedForModel.has(key)) {
    return Promise.resolve(false)
  }
  // Returns the refresh result so callers (and tests) can await the actual
  // attempt; production callers fire-and-forget this.
  return refreshModelCatalog()
    // Never reject: several callers deliberately `void` this promise, and a
    // boot-time network failure must not surface as an unhandled rejection.
    .catch(() => false)
    .then((refreshed) => {
      if (!refreshed) return false
      // Mark the pair only once the catalog is actually current: a failed
      // attempt stays retryable. (Marking before the await let one transient
      // boot-time failure disable the run-path retry until the next restart.)
      refreshedForModel.add(key)
      const hit = lookupCatalogModel(getModelCatalog(), params)
      console.info(
        `${CATALOG_LOG_PREFIX} prefetch ${params.providerId}/${params.model} — ${
          hit
            ? `hit ${hit.model.providerId}/${hit.model.modelId}`
            : 'still unknown'
        }`,
      )
      return true
    })
}

// ---------------------------------------------------------------------------
// Legacy B1d hydration (gateway /models → catalog)
// ---------------------------------------------------------------------------

type ModelsDevProvider = {
  models?: Record<string, { limit?: { context?: number; input?: number; output?: number } }>
}

function isPlausibleWindow(tokens: number | undefined): tokens is number {
  return (
    typeof tokens === 'number' &&
    Number.isFinite(tokens) &&
    tokens >= MIN_PLAUSIBLE_WINDOW &&
    tokens < MAX_PLAUSIBLE_WINDOW
  )
}

/**
 * Map a config provider id onto its models.dev provider id(s), if known.
 * Delegates to the single curated alias table in `model-catalog.ts`.
 */
export function modelsDevProviderIdsFor(providerId: string): string[] {
  return catalogAliasProviderIdsFor(providerId)
}

function stripProviderPrefix(providerId: string, model: string): string {
  const prefix = `${providerId}/`
  return model.startsWith(prefix) ? model.slice(prefix.length) : model
}

function capsFromLimit(
  limit:
    | { context?: number; input?: number; output?: number }
    | undefined,
): HydratedCapabilities | undefined {
  // Plan §5.2/§10: `limit.input ?? limit.context` — the same fill rule the
  // presets use, so preset and hydration can never disagree on a window.
  const windowTokens = isPlausibleWindow(limit?.input)
    ? Math.floor(limit!.input!)
    : isPlausibleWindow(limit?.context)
      ? Math.floor(limit!.context!)
      : undefined
  const outputTokens = isPlausibleWindow(limit?.output)
    ? Math.floor(limit!.output!)
    : undefined
  if (windowTokens === undefined && outputTokens === undefined) return undefined
  return { windowTokens, outputTokens }
}

/**
 * Look up caps for a bare model id in a RAW models.dev catalog (already
 * fetched JSON). Exported for tests — pure, no network.
 */
export function capsFromModelsDevCatalog(
  catalog: unknown,
  providerId: string,
  model: string,
): HydratedCapabilities | undefined {
  if (!catalog || typeof catalog !== 'object') return undefined
  const providers =
    (catalog as Record<string, unknown>).providers ??
    (catalog as Record<string, unknown>)
  for (const devProviderId of modelsDevProviderIdsFor(providerId)) {
    const provider = (providers as Record<string, unknown>)[devProviderId] as
      | ModelsDevProvider
      | undefined
    if (!provider || typeof provider !== 'object') continue
    const models = provider.models
    if (!models || typeof models !== 'object') continue
    const entry =
      models[model] ?? models[stripProviderPrefix(providerId, model)]
    if (!entry) continue
    const caps = capsFromLimit(entry.limit)
    if (caps) return caps
  }
  return undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * Extract caps from a gateway `GET /models` response (OpenAI convention).
 * Most gateways return only ids; window fields are rare — use them when
 * present. Exported for tests — pure, no network.
 */
export function capsFromGatewayModelsResponse(
  payload: unknown,
  model: string,
): HydratedCapabilities | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const data = (payload as Record<string, unknown>).data
  const bare = stripProviderPrefix('', model)
  const list = Array.isArray(data) ? data : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id : undefined
    if (id !== model && id !== bare) continue
    const context = firstNumber(
      entry.context_window_tokens,
      entry.context_window,
      entry.context_length,
      entry.max_context_tokens,
    )
    const output = firstNumber(
      entry.max_output_tokens,
      entry.output_tokens,
      entry.max_tokens,
    )
    const windowTokens = isPlausibleWindow(context) ? context : undefined
    const outputTokens = isPlausibleWindow(output) ? output : undefined
    if (windowTokens === undefined && outputTokens === undefined) return undefined
    return { windowTokens, outputTokens }
  }
  return undefined
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await globalThis.fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

// One-shot bookkeeping. Both positive and negative outcomes are remembered so
// an offline machine never re-fetches on every request (B1d plan §5).
const hydrationAttempts = new Map<string, boolean>()
const hydratedCaps = new Map<string, HydratedCapabilities>()
const gatewayCapsCache = new Map<string, HydratedCapabilities | undefined>()

function hydrationKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

async function tryGateway(
  baseURL: string,
  model: string,
): Promise<HydratedCapabilities | undefined> {
  const cacheKey = `${baseURL}\u0000${model}`
  if (gatewayCapsCache.has(cacheKey)) return gatewayCapsCache.get(cacheKey)
  try {
    const url = new URL(baseURL)
    url.pathname = url.pathname.replace(/\/$/, '') + '/models'
    const payload = await fetchJson(url.toString())
    const caps = capsFromGatewayModelsResponse(payload, model)
    gatewayCapsCache.set(cacheKey, caps)
    return caps
  } catch {
    gatewayCapsCache.set(cacheKey, undefined)
    return undefined
  }
}

/**
 * Hydrate capabilities for a (providerId, model) pair that has no declared
 * capability. Returns the caps when found, undefined otherwise. Fires at most
 * once per pair per process; subsequent calls return the memoized result.
 *
 * Hop 1 is the gateway's own `/models` (endpoint truth); hop 2 is the
 * catalog (snapshot/disk, refreshed once when online and unknown).
 */
/**
 * @deprecated ADR-31: the resolver reads the catalog synchronously, so the
 * app no longer hydrates through this path (no production caller). Kept as a
 * tested SDK helper for embedders; new code should use `lookupCatalog` /
 * `prefetchModelCatalogForModel`.
 */
export async function hydrateModelCapabilities(params: {
  providerId: string
  providerBaseURL?: string
  providerName?: string
  model: string
  catalogProvider?: string
  catalogKeys?: Record<string, string>
}): Promise<HydratedCapabilities | undefined> {
  const { providerId, providerBaseURL, providerName, model } = params
  const key = hydrationKey(providerId, model)
  if (hydrationAttempts.has(key)) {
    return hydratedCaps.get(key)
  }
  hydrationAttempts.set(key, true)

  if (providerBaseURL) {
    const gatewayCaps = await tryGateway(providerBaseURL, model)
    if (gatewayCaps) {
      remember(key, providerId, model, gatewayCaps, 'gateway /models')
      return gatewayCaps
    }
  }

  let hit = lookupCatalogModel(getModelCatalog(), {
    providerId,
    ...(providerName ? { providerName } : {}),
    ...(providerBaseURL ? { baseURL: providerBaseURL } : {}),
    model,
    ...(params.catalogProvider ? { catalogProvider: params.catalogProvider } : {}),
    ...(params.catalogKeys ? { catalogKeys: params.catalogKeys } : {}),
  })
  if (!hit && catalogOnline()) {
    await refreshModelCatalog()
    hit = lookupCatalogModel(getModelCatalog(), {
      providerId,
      ...(providerName ? { providerName } : {}),
      ...(providerBaseURL ? { baseURL: providerBaseURL } : {}),
      model,
      ...(params.catalogProvider
        ? { catalogProvider: params.catalogProvider }
        : {}),
      ...(params.catalogKeys ? { catalogKeys: params.catalogKeys } : {}),
    })
  }
  if (hit) {
    const caps = catalogResultToCaps(hit)
    if (caps) {
      remember(key, providerId, model, caps, `models.dev ${hit.model.providerId}/${hit.model.modelId}`)
      return caps
    }
  }

  console.info(
    `${CATALOG_LOG_PREFIX} hydration: ${providerId}/${model} — unknown to gateway/models.dev; keeping fallback window`,
  )
  return undefined
}

function catalogResultToCaps(
  hit: CatalogLookupResult,
): HydratedCapabilities | undefined {
  const windowTokens = catalogContextWindow(hit.model)
  const outputTokens = catalogOutputTokens(hit.model)
  if (windowTokens === undefined && outputTokens === undefined) return undefined
  return { windowTokens, outputTokens }
}

function remember(
  key: string,
  providerId: string,
  model: string,
  caps: HydratedCapabilities,
  source: string,
): void {
  hydratedCaps.set(key, caps)
  console.info(
    `${CATALOG_LOG_PREFIX} hydrated windowTokens=${caps.windowTokens ?? 'unknown'} for ${providerId}/${model} from ${source}`,
  )
}

/** Test seam: reset the one-shot bookkeeping and memoized caps. */
export function clearModelCatalogHydrationForTest(): void {
  hydrationAttempts.clear()
  hydratedCaps.clear()
  gatewayCapsCache.clear()
  refreshedForModel.clear()
}

/** Test seam: reset the whole catalog runtime (index, cache seam, ETag). */
export function clearModelCatalogCacheForTest(): void {
  clearModelCatalogHydrationForTest()
  // Invalidate any pending cache load / network refresh before clearing state.
  catalogEpoch += 1
  memoryIndex = null
  cacheSeam = undefined
  cacheLoadStarted = false
  cacheLoadPromise = null
  refreshPromise = null
  etag = undefined
  fetchedAt = undefined
  lastPayload = undefined
  onlineOverride = undefined
  warnedOffline = false
}

/** Synchronously read caps learned by a completed hydration round. */
export function getHydratedCapabilities(params: {
  providerId: string
  model: string
}): HydratedCapabilities | undefined {
  return hydratedCaps.get(hydrationKey(params.providerId, params.model))
}

/** Look up a model's catalog facts (sync, no network). */
export function lookupCatalog(params: {
  providerId: string
  providerName?: string
  baseURL?: string
  model: string
  catalogProvider?: string
  catalogKeys?: Record<string, string>
}): CatalogLookupResult | null {
  return lookupCatalogModel(getModelCatalog(), params)
}
