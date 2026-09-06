/**
 * Lazy catalog hydration for unknown models (AnyBuff P1 B1d).
 *
 * BYOK means the user can type any model id — the built-in preset tables
 * (B1a/B1c) can never cover "the next id the user pastes". When a
 * (provider, model) pair resolves with NO declared capability, this module
 * fetches its window/output caps once, on demand, and remembers it for the
 * process. Sources, in priority order:
 *
 *   1. `GET {baseURL}/models` (OpenAI-convention gateway endpoint) — reflects
 *      the endpoint's truth if the gateway downgrades windows. Most gateways
 *      only return an id list without window fields, in which case we fall
 *      through to source 2.
 *   2. `https://models.dev/api.json` — single MIT-licensed JSON with lab
 *      native limits for every provider, matched via an alias table
 *      (e.g. `z-ai` → `zhipuai`).
 *
 * Design constraints from the plan (§5 B1d):
 * - One-shot per (providerId, model): a negative result is also remembered,
 *   so an offline machine does not re-fetch on every request.
 * - Best-effort only: fetch failure, timeout (~5s) or parse failure silently
 *   degrade to the pre-existing 1M fallback behavior. No new failure modes.
 * - Values are static once learned (same lifetime as B1a hand-fills); drift
 *   detection belongs to the B1b snapshot script, not runtime re-fetching.
 * - Learned windows do not override explicit config (the caller checks that)
 *   nor a previously learned overflow window (A2 stays authoritative there).
 */

/** How long each catalog fetch may take before we give up. */
const HYDRATION_TIMEOUT_MS = 5_000

/** Plausible context-window range — same guard as A2's learned windows. */
const MIN_PLAUSIBLE_WINDOW = 4_000
const MAX_PLAUSIBLE_WINDOW = 32_000_000

const COMPAT_LOG_PREFIX = '[anybuff-compat]'

/** models.dev api.json — the single upstream catalog (MIT). */
const MODELS_DEV_API_URL = 'https://models.dev/api.json'

/**
 * models.dev provider ids are the labs' own names, while BYOK configs use
 * gateway or brand aliases. Keys are lowercase provider ids as they appear in
 * anybuff.json / preset definitions; values are models.dev provider ids.
 * First match wins for multi-valued aliases (arrays are fallback chains).
 */
const PROVIDER_ALIAS_TO_MODELS_DEV: Record<string, string[]> = {
  'z-ai': ['zhipuai'],
  glm: ['zhipuai'],
  openai: ['openai'],
  anthropic: ['anthropic'],
  'anthropic-compatible': ['anthropic'],
  openrouter: ['openrouter'],
  deepseek: ['deepseek'],
  'moonshot-ai': ['moonshotai'],
  moonshot: ['moonshotai'],
  minimax: ['minimax'],
  qwen: ['qwen', 'dashscope', 'alibaba'],
  dashscope: ['dashscope', 'alibaba'],
  alibaba: ['alibaba', 'dashscope'],
  xai: ['xai'],
  grok: ['xai'],
  ollama: ['ollama'],
  google: ['google'],
  'google-vertex': ['google-vertex'],
  bedrock: ['amazon-bedrock', 'bedrock'],
  'amazon-bedrock': ['amazon-bedrock'],
}

/** One model's capability fields we hydrate. */
export type HydratedCapabilities = {
  windowTokens?: number
  outputTokens?: number
}

/** Fetchable subset of the models.dev api.json shape we consume. */
type ModelsDevProvider = {
  models?: Record<
    string,
    {
      limit?: { context?: number; output?: number }
    }
  >
}

/** Result of the models.dev lookup for one model id. */
function capsFromModelsDevEntry(entry: {
  limit?: { context?: number; output?: number }
}): HydratedCapabilities | undefined {
  const context = entry.limit?.context
  const output = entry.limit?.output
  const windowTokens =
    typeof context === 'number' && isPlausibleWindow(context)
      ? Math.floor(context)
      : undefined
  const outputTokens =
    typeof output === 'number' && isPlausibleWindow(output)
      ? Math.floor(output)
      : undefined
  if (windowTokens === undefined && outputTokens === undefined) return undefined
  return { windowTokens, outputTokens }
}

function isPlausibleWindow(tokens: number | undefined): tokens is number {
  return (
    typeof tokens === 'number' &&
    Number.isFinite(tokens) &&
    tokens >= MIN_PLAUSIBLE_WINDOW &&
    tokens < MAX_PLAUSIBLE_WINDOW
  )
}

/** Map a config provider id onto its models.dev provider id(s), if known. */
export function modelsDevProviderIdsFor(providerId: string): string[] {
  const aliases = PROVIDER_ALIAS_TO_MODELS_DEV[providerId.toLowerCase()]
  if (aliases) return aliases
  // Heuristic: the id itself often IS a models.dev id (openai, deepseek, …).
  return [providerId.toLowerCase()]
}

/**
 * Look up caps for a bare model id in the models.dev catalog (already
 * fetched JSON). Exported for tests — pure, no network.
 */
export function capsFromModelsDevCatalog(
  catalog: unknown,
  providerId: string,
  model: string,
): HydratedCapabilities | undefined {
  if (!catalog || typeof catalog !== 'object') return undefined
  const providers = (catalog as Record<string, unknown>).providers ??
    (catalog as Record<string, unknown>)
  for (const devProviderId of modelsDevProviderIdsFor(providerId)) {
    const provider = (providers as Record<string, unknown>)[devProviderId] as
      | ModelsDevProvider
      | undefined
    if (!provider || typeof provider !== 'object') continue
    const models = provider.models
    if (!models || typeof models !== 'object') continue
    const entry = models[model] ?? models[stripProviderPrefix(providerId, model)]
    if (!entry) continue
    const caps = capsFromModelsDevEntry(entry)
    if (caps) return caps
  }
  return undefined
}

/** Strip a `providerId/` prefix from a routable model string. */
function stripProviderPrefix(providerId: string, model: string): string {
  const prefix = `${providerId}/`
  return model.startsWith(prefix) ? model.slice(prefix.length) : model
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

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** Fetch JSON with the hydration timeout; any failure returns null. */
async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await globalThis.fetch(url, {
      signal: AbortSignal.timeout(HYDRATION_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

// ----------------------------------------------------------------------------
// One-shot bookkeeping. Both positive and negative outcomes are remembered so
// an offline machine never re-fetches on every request (plan §5 B1d #1/#5).
// ----------------------------------------------------------------------------
const hydrationAttempts = new Map<string, boolean>()

function hydrationKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

/**
 * In-memory cache of hydrated caps so repeated lookups skip the map walk.
 * Process-scoped, same lifetime as the learned-window overlay.
 */
const hydratedCaps = new Map<string, HydratedCapabilities>()

/**
 * Hydrate capabilities for a (providerId, model) pair that has no declared
 * capability. Returns the caps when found, undefined otherwise. Fires at most
 * once per pair per process; subsequent calls return the memoized result.
 */
export async function hydrateModelCapabilities(params: {
  providerId: string
  providerBaseURL?: string
  model: string
}): Promise<HydratedCapabilities | undefined> {
  const { providerId, providerBaseURL, model } = params
  const key = hydrationKey(providerId, model)
  if (hydrationAttempts.has(key)) {
    return hydratedCaps.get(key)
  }
  hydrationAttempts.set(key, true)

  // Hop 1: the gateway's own /models endpoint (endpoint truth wins).
  if (providerBaseURL) {
    const gatewayCaps = await tryGateway(providerBaseURL, model)
    if (gatewayCaps) {
      remember(key, providerId, model, gatewayCaps, 'gateway /models')
      return gatewayCaps
    }
  }

  // Hop 2: the models.dev catalog (lab native values, MIT).
  const catalog = await fetchJson(MODELS_DEV_API_URL)
  const catalogCaps = capsFromModelsDevCatalog(catalog, providerId, model)
  if (catalogCaps) {
    remember(key, providerId, model, catalogCaps, 'models.dev')
    return catalogCaps
  }

  console.info(
    `${COMPAT_LOG_PREFIX} hydration: ${providerId}/${model} — unknown to gateway/models.dev; keeping fallback window`,
  )
  return undefined
}

async function tryGateway(
  baseURL: string,
  model: string,
): Promise<HydratedCapabilities | undefined> {
  try {
    const url = new URL(baseURL)
    url.pathname = url.pathname.replace(/\/$/, '') + '/models'
    const payload = await fetchJson(url.toString())
    return capsFromGatewayModelsResponse(payload, model)
  } catch {
    return undefined
  }
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
    `${COMPAT_LOG_PREFIX} hydrated windowTokens=${caps.windowTokens ?? 'unknown'} for ${providerId}/${model} from ${source}`,
  )
}

/**
 * Test seam: reset the one-shot bookkeeping and memoized caps.
 * Production callers never need this — a process handles many models, and
 * each pair resolves exactly once.
 */
export function clearModelCatalogHydrationForTest(): void {
  hydrationAttempts.clear()
  hydratedCaps.clear()
}

/**
 * Synchronously read caps learned by a completed hydration round. Returns
 * undefined before the background fetch finishes or when it found nothing.
 */
export function getHydratedCapabilities(params: {
  providerId: string
  model: string
}): HydratedCapabilities | undefined {
  return hydratedCaps.get(hydrationKey(params.providerId, params.model))
}
