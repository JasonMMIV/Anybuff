/**
 * models.dev catalog — PURE parsing, indexing and lookup (no network, no fs).
 *
 * The catalog is AnyBuff's default data layer for model facts (context limits,
 * modalities, tool support, reasoning options, lifecycle, pricing). It is never
 * written back to `anybuff.json`: `modelCapabilities` stays the only user
 * declaration surface (plan D1/D3/D9, ADR-27 provenance).
 *
 * Sources:
 *   - `GET https://models.dev/api.json` (MIT, Copyright (c) 2025 models.dev)
 *   - build-time snapshot (`model-catalog-snapshot.ts`)
 *   - runtime disk cache (`model-catalog-cache.json`, written by hydration)
 *
 * Everything here is deterministic and side-effect free so the resolver can
 * import it without dragging a network dependency into the synchronous path.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One `reasoning_options` entry from models.dev (v1 shape). */
export type CatalogReasoningOption =
  | { type: 'toggle' }
  | { type: 'effort'; values: string[] }
  | { type: 'budget_tokens'; min?: number; max?: number }

/** One `cost.tiers` entry (`tier: { type: 'context', size }`). */
export type CatalogCostTier = {
  minContextTokens: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

/** Pricing facts (USD per 1M tokens, matching models.dev's unit). */
export type CatalogCost = {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  inputAudio?: number
  outputAudio?: number
  /** Legacy long-context pricing (deprecated upstream, still emitted). */
  contextOver200k?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
  /** Newer tiered pricing. `minContextTokens` is the tier's threshold. */
  tiers?: CatalogCostTier[]
}

/** One catalog model entry (facts only — no display metadata). */
export type CatalogModel = {
  providerId: string
  modelId: string
  /** `limit.context` — the model's total window. */
  contextWindow?: number
  /** `limit.input` — the real prompt ceiling when the vendor publishes one. */
  inputTokens?: number
  /** `limit.output`. */
  outputTokens?: number
  modalitiesInput: readonly string[]
  modalitiesOutput: readonly string[]
  toolCall?: boolean
  structuredOutput?: boolean
  attachment?: boolean
  reasoning?: boolean
  reasoningOptions: readonly CatalogReasoningOption[]
  temperature?: boolean
  /** `interleaved: true` (field unknown) or `{ field }` (known). */
  interleaved?: true | { field: string }
  canonicalModelId?: string
  /** `alpha` / `beta` / `deprecated` — advisory only (never blocks routing). */
  status?: string
  cost?: CatalogCost
}

export type CatalogProvider = {
  id: string
  /** models.dev `api` URL (used for host matching). */
  apiUrl?: string
  /** Normalized host derived from `apiUrl`. */
  apiHost?: string
  models: Map<string, CatalogModel>
}

/** How a provider entry was matched (plan §4.3). */
export type CatalogProviderMatch = 'provider-id' | 'host'

/** How a model entry was matched (plan §4.3). */
export type CatalogModelMatch =
  | 'provider-id'
  | 'host'
  | 'global-id'
  | 'canonical'
  | 'normalized'

export type CatalogLookupResult = {
  model: CatalogModel
  matchedBy: CatalogModelMatch
  /** 1.0 provider-exact, 0.9 host, 0.8 canonical, 0.6 global unique, 0.5 normalized. */
  confidence: number
}

/** Provenance of the catalog the lookup ran against. */
export type CatalogIndexSource = 'snapshot' | 'cache' | 'network'

export type ModelCatalogIndex = {
  schemaVersion: number
  snapshotAt: string
  fetchedAt?: string
  source: CatalogIndexSource
  providers: Map<string, CatalogProvider>
  /** normalized host → provider ids */
  byApiHost: Map<string, string[]>
  /** lowercase bare model id → entries (may span providers) */
  byModelId: Map<string, CatalogModel[]>
  /** lowercase canonical id (`lab/model`) → entries */
  byCanonicalId: Map<string, CatalogModel[]>
  /** date/suffix-normalized model id → entries (low-confidence fallback) */
  byNormalizedModelId: Map<string, CatalogModel[]>
  /** Number of provider-model entries (for logs / stats). */
  size: number
}

// ---------------------------------------------------------------------------
// Compact snapshot encoding (versioned, positional tuples)
//
// The raw models.dev payload is ~5.9 MB; a naive whitelist projection is
// ~3.3 MB — over the 3 MB hard cap. The compact form is a tuple per model plus
// a deduplicated row table (providers reference rows by index), which lands
// around 1.1 MB while keeping every behavioural field (plan §3.3).
//
// Tuple layout is APPEND-ONLY. Bump MODEL_CATALOG_SCHEMA_VERSION when an index
// changes meaning; unknown trailing fields are ignored by older readers.
// ---------------------------------------------------------------------------

export const MODEL_CATALOG_SCHEMA_VERSION = 1

/** Positional slot names for a compact model tuple. */
export const CATALOG_MODEL_TUPLE = {
  CONTEXT_WINDOW: 0,
  INPUT_TOKENS: 1,
  OUTPUT_TOKENS: 2,
  MODALITIES_INPUT: 3,
  MODALITIES_OUTPUT: 4,
  TOOL_CALL: 5,
  STRUCTURED_OUTPUT: 6,
  ATTACHMENT: 7,
  REASONING: 8,
  REASONING_OPTIONS: 9,
  TEMPERATURE: 10,
  INTERLEAVED: 11,
  CANONICAL_ID: 12,
  STATUS: 13,
  COST: 14,
  COST_TIERS: 15,
  COST_OVER_200K: 16,
} as const

export type CompactCatalogModelTuple = Array<unknown>
/** `[providerId, apiUrl | null, [[modelId, rowIndex], …]]` */
export type CompactCatalogProvider = [
  string,
  string | null,
  Array<[string, number]>,
]

export type CompactCatalogPayload = {
  schemaVersion: number
  snapshotAt: string
  models: CompactCatalogModelTuple[]
  providers: CompactCatalogProvider[]
}

const MODALITY_CODE: Readonly<Record<string, string>> = {
  text: 't',
  image: 'i',
  audio: 'a',
  video: 'v',
  pdf: 'p',
}
const MODALITY_FROM_CODE: Readonly<Record<string, string>> = {
  t: 'text',
  i: 'image',
  a: 'audio',
  v: 'video',
  p: 'pdf',
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalNumber(value: unknown): number | null {
  return finiteNumber(value) ?? null
}

/** Strip trailing nulls / empty strings so the common case stays short. */
function trimTuple(tuple: unknown[]): unknown[] {
  let end = tuple.length
  while (
    end > 0 &&
    (tuple[end - 1] === null ||
      tuple[end - 1] === '' ||
      tuple[end - 1] === undefined)
  ) {
    end--
  }
  return tuple.slice(0, end)
}

function encodeModalities(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const codes: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) continue
    const code = MODALITY_CODE[item]
    codes.push(code ?? item)
  }
  return [...new Set(codes)].sort().join(',')
}

function decodeModalities(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  return value
    .split(',')
    .filter((code) => code.length > 0)
    .map((code) => MODALITY_FROM_CODE[code] ?? code)
}

function encodeBoolean(value: unknown): number | null {
  return typeof value === 'boolean' ? (value ? 1 : 0) : null
}

function decodeBoolean(value: unknown): boolean | undefined {
  if (value === 1 || value === true) return true
  if (value === 0 || value === false) return false
  return undefined
}

function encodeReasoningOptions(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const option of value) {
    if (!option || typeof option !== 'object') continue
    const entry = option as Record<string, unknown>
    if (entry.type === 'toggle') {
      parts.push('t')
    } else if (entry.type === 'effort') {
      const values = Array.isArray(entry.values)
        ? entry.values.filter(
            (item): item is string =>
              typeof item === 'string' && item.length > 0,
          )
        : []
      parts.push(`e:${values.join(',')}`)
    } else if (entry.type === 'budget_tokens') {
      const min = finiteNumber(entry.min)
      const max = finiteNumber(entry.max)
      parts.push(`b:${min ?? ''},${max ?? ''}`)
    }
  }
  return parts.join('|')
}

function decodeReasoningOptions(value: unknown): CatalogReasoningOption[] {
  if (typeof value !== 'string' || value.length === 0) return []
  const options: CatalogReasoningOption[] = []
  for (const part of value.split('|')) {
    if (part === 't') {
      options.push({ type: 'toggle' })
      continue
    }
    if (part.startsWith('e:')) {
      const values = part
        .slice(2)
        .split(',')
        .filter((item) => item.length > 0)
      options.push({ type: 'effort', values })
      continue
    }
    if (part.startsWith('b:')) {
      const [rawMin, rawMax] = part.slice(2).split(',')
      const min = rawMin ? Number(rawMin) : undefined
      const max = rawMax ? Number(rawMax) : undefined
      options.push({
        type: 'budget_tokens',
        ...(Number.isFinite(min) ? { min } : {}),
        ...(Number.isFinite(max) ? { max } : {}),
      })
    }
  }
  return options
}

function encodeInterleaved(value: unknown): string {
  if (value === true) return '1'
  if (!value || typeof value !== 'object') return ''
  const field = (value as Record<string, unknown>).field
  return typeof field === 'string' ? field : '1'
}

function decodeInterleaved(value: unknown): true | { field: string } | undefined {
  if (value === '1') return true
  if (typeof value === 'string' && value.length > 0) return { field: value }
  return undefined
}

function encodeCost(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return []
  const cost = value as Record<string, unknown>
  return trimTuple([
    optionalNumber(cost.input),
    optionalNumber(cost.output),
    optionalNumber(cost.reasoning),
    optionalNumber(cost.cache_read),
    optionalNumber(cost.cache_write),
    optionalNumber(cost.input_audio),
    optionalNumber(cost.output_audio),
  ])
}

function decodeCost(value: unknown): CatalogCost | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const [
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    inputAudio,
    outputAudio,
  ] = value
  const cost: CatalogCost = {
    ...(finiteNumber(input) !== undefined ? { input: finiteNumber(input) } : {}),
    ...(finiteNumber(output) !== undefined
      ? { output: finiteNumber(output) }
      : {}),
    ...(finiteNumber(reasoning) !== undefined
      ? { reasoning: finiteNumber(reasoning) }
      : {}),
    ...(finiteNumber(cacheRead) !== undefined
      ? { cacheRead: finiteNumber(cacheRead) }
      : {}),
    ...(finiteNumber(cacheWrite) !== undefined
      ? { cacheWrite: finiteNumber(cacheWrite) }
      : {}),
    ...(finiteNumber(inputAudio) !== undefined
      ? { inputAudio: finiteNumber(inputAudio) }
      : {}),
    ...(finiteNumber(outputAudio) !== undefined
      ? { outputAudio: finiteNumber(outputAudio) }
      : {}),
  }
  return Object.keys(cost).length > 0 ? cost : undefined
}

function encodeCostTiers(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return []
  const tiers = (value as Record<string, unknown>).tiers
  if (!Array.isArray(tiers)) return []
  return tiers
    .map((tier) => {
      if (!tier || typeof tier !== 'object') return null
      const entry = tier as Record<string, unknown>
      const tierInfo = entry.tier
      const size =
        tierInfo && typeof tierInfo === 'object'
          ? finiteNumber((tierInfo as Record<string, unknown>).size)
          : undefined
      if (size === undefined) return null
      return trimTuple([
        size,
        optionalNumber(entry.input),
        optionalNumber(entry.output),
        optionalNumber(entry.cache_read),
        optionalNumber(entry.cache_write),
      ])
    })
    .filter((tier): tier is unknown[] => tier !== null)
}

function decodeCostTiers(value: unknown): CatalogCostTier[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const tiers: CatalogCostTier[] = []
  for (const tier of value) {
    if (!Array.isArray(tier)) continue
    const [size, input, output, cacheRead, cacheWrite] = tier
    const minContextTokens = finiteNumber(size)
    if (minContextTokens === undefined) continue
    tiers.push({
      minContextTokens,
      ...(finiteNumber(input) !== undefined ? { input: finiteNumber(input) } : {}),
      ...(finiteNumber(output) !== undefined
        ? { output: finiteNumber(output) }
        : {}),
      ...(finiteNumber(cacheRead) !== undefined
        ? { cacheRead: finiteNumber(cacheRead) }
        : {}),
      ...(finiteNumber(cacheWrite) !== undefined
        ? { cacheWrite: finiteNumber(cacheWrite) }
        : {}),
    })
  }
  return tiers.length > 0 ? tiers : undefined
}

function encodeCostOver200k(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return []
  const over = (value as Record<string, unknown>).context_over_200k
  if (!over || typeof over !== 'object') return []
  const entry = over as Record<string, unknown>
  return trimTuple([
    optionalNumber(entry.input),
    optionalNumber(entry.output),
    optionalNumber(entry.cache_read),
    optionalNumber(entry.cache_write),
  ])
}

function decodeCostOver200k(
  value: unknown,
): CatalogCost['contextOver200k'] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const [input, output, cacheRead, cacheWrite] = value
  const over = {
    ...(finiteNumber(input) !== undefined ? { input: finiteNumber(input) } : {}),
    ...(finiteNumber(output) !== undefined
      ? { output: finiteNumber(output) }
      : {}),
    ...(finiteNumber(cacheRead) !== undefined
      ? { cacheRead: finiteNumber(cacheRead) }
      : {}),
    ...(finiteNumber(cacheWrite) !== undefined
      ? { cacheWrite: finiteNumber(cacheWrite) }
      : {}),
  }
  return Object.keys(over).length > 0 ? over : undefined
}

/**
 * Project one raw models.dev model entry into the compact tuple.
 * Unknown fields are ignored; `type` is handled by the caller.
 */
export function encodeCatalogModel(model: Record<string, unknown>): CompactCatalogModelTuple {
  const limit =
    model.limit && typeof model.limit === 'object'
      ? (model.limit as Record<string, unknown>)
      : undefined
  const modalities =
    model.modalities && typeof model.modalities === 'object'
      ? (model.modalities as Record<string, unknown>)
      : undefined
  const cost = model.cost

  const tuple: unknown[] = []
  tuple[CATALOG_MODEL_TUPLE.CONTEXT_WINDOW] = optionalNumber(limit?.context)
  tuple[CATALOG_MODEL_TUPLE.INPUT_TOKENS] = optionalNumber(limit?.input)
  tuple[CATALOG_MODEL_TUPLE.OUTPUT_TOKENS] = optionalNumber(limit?.output)
  tuple[CATALOG_MODEL_TUPLE.MODALITIES_INPUT] = encodeModalities(
    modalities?.input,
  )
  tuple[CATALOG_MODEL_TUPLE.MODALITIES_OUTPUT] = encodeModalities(
    modalities?.output,
  )
  tuple[CATALOG_MODEL_TUPLE.TOOL_CALL] = encodeBoolean(model.tool_call)
  tuple[CATALOG_MODEL_TUPLE.STRUCTURED_OUTPUT] = encodeBoolean(
    model.structured_output,
  )
  tuple[CATALOG_MODEL_TUPLE.ATTACHMENT] = encodeBoolean(model.attachment)
  tuple[CATALOG_MODEL_TUPLE.REASONING] = encodeBoolean(model.reasoning)
  tuple[CATALOG_MODEL_TUPLE.REASONING_OPTIONS] = encodeReasoningOptions(
    model.reasoning_options,
  )
  tuple[CATALOG_MODEL_TUPLE.TEMPERATURE] = encodeBoolean(model.temperature)
  tuple[CATALOG_MODEL_TUPLE.INTERLEAVED] = encodeInterleaved(model.interleaved)
  tuple[CATALOG_MODEL_TUPLE.CANONICAL_ID] =
    typeof model.canonical_model_id === 'string'
      ? model.canonical_model_id
      : ''
  tuple[CATALOG_MODEL_TUPLE.STATUS] =
    typeof model.status === 'string' ? model.status : ''
  tuple[CATALOG_MODEL_TUPLE.COST] = encodeCost(cost)
  tuple[CATALOG_MODEL_TUPLE.COST_TIERS] = encodeCostTiers(cost)
  tuple[CATALOG_MODEL_TUPLE.COST_OVER_200K] = encodeCostOver200k(cost)
  return trimTuple(tuple)
}

/** Decode a compact tuple back into model facts (no provider/model ids). */
export function decodeCatalogModelTuple(
  tuple: CompactCatalogModelTuple,
): Omit<CatalogModel, 'providerId' | 'modelId'> {
  const at = (index: number): unknown => tuple[index]
  const cost: CatalogCost | undefined = (() => {
    const base = decodeCost(at(CATALOG_MODEL_TUPLE.COST))
    const tiers = decodeCostTiers(at(CATALOG_MODEL_TUPLE.COST_TIERS))
    const over200k = decodeCostOver200k(at(CATALOG_MODEL_TUPLE.COST_OVER_200K))
    if (!base && !tiers && !over200k) return undefined
    return {
      ...(base ?? {}),
      ...(tiers ? { tiers } : {}),
      ...(over200k ? { contextOver200k: over200k } : {}),
    }
  })()

  return {
    ...(finiteNumber(at(CATALOG_MODEL_TUPLE.CONTEXT_WINDOW)) !== undefined
      ? { contextWindow: finiteNumber(at(CATALOG_MODEL_TUPLE.CONTEXT_WINDOW)) }
      : {}),
    ...(finiteNumber(at(CATALOG_MODEL_TUPLE.INPUT_TOKENS)) !== undefined
      ? { inputTokens: finiteNumber(at(CATALOG_MODEL_TUPLE.INPUT_TOKENS)) }
      : {}),
    ...(finiteNumber(at(CATALOG_MODEL_TUPLE.OUTPUT_TOKENS)) !== undefined
      ? { outputTokens: finiteNumber(at(CATALOG_MODEL_TUPLE.OUTPUT_TOKENS)) }
      : {}),
    modalitiesInput: decodeModalities(at(CATALOG_MODEL_TUPLE.MODALITIES_INPUT)),
    modalitiesOutput: decodeModalities(
      at(CATALOG_MODEL_TUPLE.MODALITIES_OUTPUT),
    ),
    ...(decodeBoolean(at(CATALOG_MODEL_TUPLE.TOOL_CALL)) !== undefined
      ? { toolCall: decodeBoolean(at(CATALOG_MODEL_TUPLE.TOOL_CALL)) }
      : {}),
    ...(decodeBoolean(at(CATALOG_MODEL_TUPLE.STRUCTURED_OUTPUT)) !== undefined
      ? {
          structuredOutput: decodeBoolean(
            at(CATALOG_MODEL_TUPLE.STRUCTURED_OUTPUT),
          ),
        }
      : {}),
    ...(decodeBoolean(at(CATALOG_MODEL_TUPLE.ATTACHMENT)) !== undefined
      ? { attachment: decodeBoolean(at(CATALOG_MODEL_TUPLE.ATTACHMENT)) }
      : {}),
    ...(decodeBoolean(at(CATALOG_MODEL_TUPLE.REASONING)) !== undefined
      ? { reasoning: decodeBoolean(at(CATALOG_MODEL_TUPLE.REASONING)) }
      : {}),
    reasoningOptions: decodeReasoningOptions(
      at(CATALOG_MODEL_TUPLE.REASONING_OPTIONS),
    ),
    ...(decodeBoolean(at(CATALOG_MODEL_TUPLE.TEMPERATURE)) !== undefined
      ? { temperature: decodeBoolean(at(CATALOG_MODEL_TUPLE.TEMPERATURE)) }
      : {}),
    ...(decodeInterleaved(at(CATALOG_MODEL_TUPLE.INTERLEAVED)) !== undefined
      ? { interleaved: decodeInterleaved(at(CATALOG_MODEL_TUPLE.INTERLEAVED)) }
      : {}),
    ...(typeof at(CATALOG_MODEL_TUPLE.CANONICAL_ID) === 'string' &&
    (at(CATALOG_MODEL_TUPLE.CANONICAL_ID) as string).length > 0
      ? { canonicalModelId: at(CATALOG_MODEL_TUPLE.CANONICAL_ID) as string }
      : {}),
    ...(typeof at(CATALOG_MODEL_TUPLE.STATUS) === 'string' &&
    (at(CATALOG_MODEL_TUPLE.STATUS) as string).length > 0
      ? { status: at(CATALOG_MODEL_TUPLE.STATUS) as string }
      : {}),
    ...(cost ? { cost } : {}),
  }
}

// ---------------------------------------------------------------------------
// Projection from the raw models.dev payload
// ---------------------------------------------------------------------------

export type ProjectedCatalog = CompactCatalogPayload

type RawProvider = {
  api?: unknown
  models?: Record<string, unknown>
}

/**
 * Project a raw `/api.json` payload into the compact snapshot payload:
 * whitelist fields, drop non-chat entries, dedupe identical rows, sort for a
 * readable diff. `snapshotAt` is injected by the caller (build script / cache).
 */
export function projectModelsDevCatalog(
  rawCatalog: unknown,
  options: { snapshotAt: string },
): ProjectedCatalog {
  const root =
    rawCatalog && typeof rawCatalog === 'object'
      ? ((rawCatalog as Record<string, unknown>).providers ?? rawCatalog)
      : {}
  const providers: CompactCatalogProvider[] = []
  const models: CompactCatalogModelTuple[] = []
  const rowIndexByKey = new Map<string, number>()

  for (const providerId of Object.keys(root as Record<string, unknown>).sort()) {
    const provider = (root as Record<string, unknown>)[providerId]
    if (!provider || typeof provider !== 'object') continue
    const entry = provider as RawProvider
    if (!entry.models || typeof entry.models !== 'object') continue

    const modelEntries: Array<[string, number]> = []
    for (const modelId of Object.keys(entry.models).sort()) {
      const model = entry.models[modelId]
      if (!model || typeof model !== 'object') continue
      const record = model as Record<string, unknown>
      // `type` defaults to "chat"; decision/embedding entries are not models
      // AnyBuff can route to (plan §3.1).
      if (record.type !== undefined && record.type !== 'chat') continue
      const tuple = encodeCatalogModel(record)
      if (tuple.length === 0) continue
      const key = JSON.stringify(tuple)
      let rowIndex = rowIndexByKey.get(key)
      if (rowIndex === undefined) {
        rowIndex = models.length
        models.push(tuple)
        rowIndexByKey.set(key, rowIndex)
      }
      modelEntries.push([modelId, rowIndex])
    }

    if (modelEntries.length === 0) continue
    providers.push([
      providerId,
      typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : null,
      modelEntries,
    ])
  }

  return {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    snapshotAt: options.snapshotAt,
    models,
    providers,
  }
}

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

/**
 * Normalize a URL to the host signal used for provider identification:
 * lowercase hostname, no port, leading `api.` / `www.` stripped. Paths are
 * irrelevant (a gateway's `/v1` says nothing about the lab).
 */
export function normalizeApiHost(value: string | undefined): string | undefined {
  if (!value || typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    let host = url.hostname.toLowerCase()
    host = host.replace(/^(api|www)\./, '')
    return host.length > 0 ? host : undefined
  } catch {
    return undefined
  }
}

function pushToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

function isCompactPayload(value: unknown): value is CompactCatalogPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Record<string, unknown>
  return Array.isArray(payload.models) && Array.isArray(payload.providers)
}

/**
 * Build the four-layer index (plan §4.2) from a compact payload.
 * Tolerates malformed rows: one bad entry is skipped, never thrown.
 */
export function buildModelCatalogIndex(
  payload: unknown,
  options: {
    snapshotAt?: string
    fetchedAt?: string
    source?: CatalogIndexSource
  } = {},
): ModelCatalogIndex {
  const empty: ModelCatalogIndex = {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    snapshotAt: options.snapshotAt ?? new Date(0).toISOString(),
    ...(options.fetchedAt ? { fetchedAt: options.fetchedAt } : {}),
    source: options.source ?? 'snapshot',
    providers: new Map(),
    byApiHost: new Map(),
    byModelId: new Map(),
    byCanonicalId: new Map(),
    byNormalizedModelId: new Map(),
    size: 0,
  }
  if (!isCompactPayload(payload)) return empty

  const decodedRows: Array<Omit<CatalogModel, 'providerId' | 'modelId'>> = []
  payload.models.forEach((tuple, index) => {
    if (!Array.isArray(tuple)) return
    decodedRows[index] = decodeCatalogModelTuple(tuple)
  })

  const index: ModelCatalogIndex = {
    ...empty,
    schemaVersion:
      typeof payload.schemaVersion === 'number'
        ? payload.schemaVersion
        : MODEL_CATALOG_SCHEMA_VERSION,
    snapshotAt:
      typeof payload.snapshotAt === 'string' && payload.snapshotAt.length > 0
        ? payload.snapshotAt
        : empty.snapshotAt,
  }

  for (const providerRow of payload.providers) {
    if (!Array.isArray(providerRow)) continue
    const [providerId, apiUrl, entries] = providerRow
    if (typeof providerId !== 'string' || providerId.length === 0) continue
    if (!Array.isArray(entries)) continue
    const provider: CatalogProvider = {
      id: providerId.toLowerCase(),
      ...(typeof apiUrl === 'string' && apiUrl.length > 0 ? { apiUrl } : {}),
      models: new Map(),
    }
    const apiHost = normalizeApiHost(apiUrl ?? undefined)
    if (apiHost) {
      provider.apiHost = apiHost
      pushToMap(index.byApiHost, apiHost, provider.id)
    }
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue
      const [modelId, rowIndex] = entry
      if (typeof modelId !== 'string' || modelId.length === 0) continue
      if (typeof rowIndex !== 'number') continue
      const facts = decodedRows[rowIndex]
      if (!facts) continue
      const model: CatalogModel = {
        providerId: provider.id,
        modelId,
        ...facts,
      }
      provider.models.set(modelId, model)
      index.size++
      const bare = modelId.toLowerCase()
      pushToMap(index.byModelId, bare, model)
      if (model.canonicalModelId) {
        pushToMap(
          index.byCanonicalId,
          model.canonicalModelId.toLowerCase(),
          model,
        )
      }
      pushToMap(index.byNormalizedModelId, normalizeModelIdKey(bare), model)
    }
    index.providers.set(provider.id, provider)
  }

  return index
}

// ---------------------------------------------------------------------------
// Model-id normalization (exact-only; no fuzzy matching)
// ---------------------------------------------------------------------------

const TRAILING_DATE_RE = /[-_](?:19|20)\d{2}[-_]?\d{2}[-_]?\d{2}$/

/**
 * Canonical key for a model id: lowercase, provider prefix removed, `:variant`
 * suffix removed, and a trailing ISO date removed **only in a separate
 * candidate** (see `normalizedModelIdCandidates`). Never used to make a
 * shorter id match a longer one: `gpt-5` must not match `gpt-5.6` (plan D6).
 */
export function normalizeModelIdKey(model: string): string {
  let key = model.trim().toLowerCase()
  const slash = key.indexOf('/')
  if (slash >= 0) key = key.slice(slash + 1)
  // `:free` / `:variant` suffixes are gateway routing tags, not different
  // models. Note the trade-off: a free tier normalized onto the paid row
  // inherits its (higher) price in the cost fallback — the endpoint's own
  // usage cost, when reported, always wins over this fallback.
  const colon = key.indexOf(':')
  if (colon >= 0) key = key.slice(0, colon)
  return key
}

/** Candidate keys for the lowest-confidence lookup rung (dated builds only). */
export function normalizedModelIdCandidates(model: string): string[] {
  const key = normalizeModelIdKey(model)
  const candidates = new Set<string>([key])
  const withoutDate = key.replace(TRAILING_DATE_RE, '')
  if (withoutDate !== key && withoutDate.length > 0) candidates.add(withoutDate)
  return [...candidates]
}

// ---------------------------------------------------------------------------
// Provider identification (plan §4.4)
// ---------------------------------------------------------------------------

/**
 * Curated brand/gateway alias → models.dev provider ids. These are config ids
 * whose baseURL host does NOT match models.dev (e.g. `z-ai` → `zhipuai`,
 * `glm` → `zhipuai`). Values are fallback chains; first hit wins.
 *
 * Deliberately NOT derived from the protocol `type`: every OpenAI-compatible
 * gateway would collapse onto `openai` (the single most likely bad match).
 */
export const CATALOG_PROVIDER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'z-ai': ['zhipuai'],
  glm: ['zhipuai'],
  openai: ['openai'],
  anthropic: ['anthropic'],
  // NOTE: the protocol name `anthropic-compatible` is deliberately NOT an
  // alias — a provider that merely SPEAKS the protocol is not necessarily
  // Anthropic (plan §4.4 #5: never map a type onto a lab).
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

/** Candidate models.dev provider ids for a config provider id (alias or id). */
export function catalogAliasProviderIdsFor(providerId: string): string[] {
  const key = providerId.trim().toLowerCase()
  const aliases = CATALOG_PROVIDER_ALIASES[key]
  return aliases ? [...aliases] : [key]
}

/**
 * Resolve which models.dev provider a config provider refers to.
 * Order: explicit `catalogProvider` → id/label exact → baseURL host.
 * `type` is deliberately NOT mapped to a lab (all OpenAI-compatible gateways
 * would become `openai` — the single most likely mis-match).
 */
export function resolveCatalogProviderId(
  index: ModelCatalogIndex,
  params: {
    providerId: string
    providerName?: string
    baseURL?: string
    catalogProvider?: string
  },
): { providerId: string; matchedBy: CatalogProviderMatch } | undefined {
  const explicit = params.catalogProvider?.trim().toLowerCase()
  if (explicit && index.providers.has(explicit)) {
    return { providerId: explicit, matchedBy: 'provider-id' }
  }

  const ids = [params.providerId, params.providerName]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
  for (const id of ids) {
    if (index.providers.has(id)) {
      return { providerId: id, matchedBy: 'provider-id' }
    }
  }

  // Curated aliases (z-ai → zhipuai, …) come before the host rung: an alias
  // is an explicit maintenance decision, the host is only a signal.
  for (const id of ids) {
    for (const alias of catalogAliasProviderIdsFor(id)) {
      if (alias === id) continue
      if (index.providers.has(alias)) {
        return { providerId: alias, matchedBy: 'provider-id' }
      }
    }
  }

  const host = normalizeApiHost(params.baseURL)
  if (host) {
    const matches = index.byApiHost.get(host)
    // Ambiguous hosts (many gateways share a cloud host) must not guess: the
    // caller still has the global model-id rung.
    if (matches && matches.length === 1) {
      return { providerId: matches[0]!, matchedBy: 'host' }
    }
    if (matches && matches.length > 1) {
      const exact = ids.find((id) => matches.includes(id))
      if (exact) return { providerId: exact, matchedBy: 'host' }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Model lookup (plan §4.3)
// ---------------------------------------------------------------------------

/** Behaviour-relevant signature used to reject ambiguous multi-provider hits. */
function capabilitySignature(model: CatalogModel): string {
  const efforts = model.reasoningOptions
    .filter(
      (option): option is { type: 'effort'; values: string[] } =>
        option.type === 'effort',
    )
    .map((option) => option.values.join(','))
    .join('|')
  return JSON.stringify([
    model.contextWindow ?? null,
    model.inputTokens ?? null,
    model.outputTokens ?? null,
    [...model.modalitiesInput].sort().join(','),
    model.toolCall ?? null,
    model.structuredOutput ?? null,
    model.attachment ?? null,
    model.reasoning ?? null,
    efforts,
    model.cost?.input ?? null,
    model.cost?.output ?? null,
  ])
}

/**
 * Collapse a multi-entry hit set: all entries must agree on the fields AnyBuff
 * consumes, otherwise the lookup fails loud (`null`) rather than guessing
 * (plan §4.3). Returns the first entry when consistent.
 */
function pickConsistent(candidates: readonly CatalogModel[]): CatalogModel | undefined {
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  const signature = capabilitySignature(candidates[0]!)
  for (const candidate of candidates.slice(1)) {
    if (capabilitySignature(candidate) !== signature) return undefined
  }
  return candidates[0]
}

function modelKeyVariants(params: {
  providerId: string
  model: string
  catalogKeys?: Record<string, string>
}): string[] {
  const { providerId, model, catalogKeys } = params
  const variants: string[] = []
  const mapped = catalogKeys?.[model]
  if (mapped) variants.push(mapped)
  variants.push(model)
  const prefix = `${providerId}/`
  if (model.startsWith(prefix)) variants.push(model.slice(prefix.length))
  return [...new Set(variants.filter((value) => value.length > 0))]
}

function findInProvider(
  provider: CatalogProvider | undefined,
  models: readonly string[],
): CatalogModel | undefined {
  if (!provider) return undefined
  for (const candidate of models) {
    const exact = provider.models.get(candidate)
    if (exact) return exact
    const lower = candidate.toLowerCase()
    for (const [id, model] of provider.models) {
      if (id.toLowerCase() === lower) return model
    }
  }
  return undefined
}

/**
 * Look up one model's catalog facts.
 *
 * Ladder (plan §4.3): provider-exact → host-matched → global model id →
 * canonical id → date-normalized id. Any ambiguity at a rung yields `null`
 * (fail-loud) — catalog values may change compression budgets and pricing, so
 * a wrong guess is worse than no value.
 */
export function lookupCatalogModel(
  index: ModelCatalogIndex,
  params: {
    providerId: string
    providerName?: string
    baseURL?: string
    model: string
    catalogProvider?: string
    catalogKeys?: Record<string, string>
  },
): CatalogLookupResult | null {
  const variants = modelKeyVariants(params)

  const direct = resolveCatalogProviderId(index, params)
  if (direct) {
    const model = findInProvider(index.providers.get(direct.providerId), variants)
    if (model) {
      return {
        model,
        matchedBy: direct.matchedBy,
        confidence: direct.matchedBy === 'provider-id' ? 1 : 0.9,
      }
    }
    // A `catalogKeys` entry may name a different lab (`lab/model`) — honour it.
    const mapped = params.catalogKeys?.[params.model]
    if (mapped && mapped.includes('/')) {
      const [lab, ...rest] = mapped.split('/')
      const crossProvider = index.providers.get(lab!.toLowerCase())
      const crossModel = findInProvider(crossProvider, [rest.join('/')])
      if (crossModel) {
        return { model: crossModel, matchedBy: 'provider-id', confidence: 1 }
      }
    }
  }

  // Global rung: try every id variant VERBATIM (a lab-qualified catalog id
  // such as `anthropic/claude-3.5` must survive). Normalization is the last
  // rung, never mixed in here — otherwise a `lab/model` canonical id would
  // resolve through its bare id and the canonical rung could never be hit.
  const globalKeys = new Set(
    variants.map((variant) => variant.trim().toLowerCase()),
  )
  for (const globalKey of globalKeys) {
    const globalMatches = index.byModelId.get(globalKey)
    if (!globalMatches?.length) continue
    const consistent = pickConsistent(globalMatches)
    if (consistent) {
      return { model: consistent, matchedBy: 'global-id', confidence: 0.6 }
    }
    return null
  }

  const canonicalKeys = new Set<string>([
    normalizeModelIdKey(params.model),
    ...globalKeys,
  ])
  for (const canonicalKey of canonicalKeys) {
    const canonicalMatches = index.byCanonicalId.get(canonicalKey)
    if (!canonicalMatches?.length) continue
    const consistent = pickConsistent(canonicalMatches)
    if (consistent) {
      return { model: consistent, matchedBy: 'canonical', confidence: 0.8 }
    }
    return null
  }

  const normalizedKey = normalizeModelIdKey(params.model)
  for (const candidate of normalizedModelIdCandidates(params.model)) {
    if (candidate === normalizedKey) continue
    const matches = index.byNormalizedModelId.get(candidate)
    if (!matches?.length) continue
    const consistent = pickConsistent(matches)
    if (consistent) {
      return { model: consistent, matchedBy: 'normalized', confidence: 0.5 }
    }
    return null
  }

  return null
}

// ---------------------------------------------------------------------------
// Convenience accessors used by the resolver
// ---------------------------------------------------------------------------

/** Catalog `limit.input ?? limit.context` — the same rule the presets use. */
export function catalogContextWindow(model: CatalogModel | undefined): number | undefined {
  if (!model) return undefined
  if (typeof model.inputTokens === 'number' && model.inputTokens > 0) {
    return model.inputTokens
  }
  if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
    return model.contextWindow
  }
  return undefined
}

export function catalogOutputTokens(model: CatalogModel | undefined): number | undefined {
  if (!model) return undefined
  return typeof model.outputTokens === 'number' && model.outputTokens > 0
    ? model.outputTokens
    : undefined
}

/** Effort rungs declared by the catalog, if any. `[]` means unknown. */
export function catalogEfforts(model: CatalogModel | undefined): string[] {
  if (!model) return []
  const option = model.reasoningOptions.find(
    (entry): entry is { type: 'effort'; values: string[] } =>
      entry.type === 'effort',
  )
  return option ? [...option.values] : []
}

export function catalogSupportsImageInput(model: CatalogModel | undefined): boolean | undefined {
  if (!model || model.modalitiesInput.length === 0) return undefined
  return model.modalitiesInput.includes('image')
}

export function catalogSupportsFileInput(model: CatalogModel | undefined): boolean | undefined {
  if (!model) return undefined
  return (
    model.attachment === true ||
    model.modalitiesInput.includes('pdf')
  )
}

export function catalogBudgetTokensRange(
  model: CatalogModel | undefined,
): { min?: number; max?: number } | undefined {
  if (!model) return undefined
  const option = model.reasoningOptions.find(
    (entry): entry is { type: 'budget_tokens'; min?: number; max?: number } =>
      entry.type === 'budget_tokens',
  )
  return option ? { ...option } : undefined
}

export function catalogHasToggle(model: CatalogModel | undefined): boolean | undefined {
  if (!model) return undefined
  return model.reasoningOptions.some((entry) => entry.type === 'toggle')
}

export function catalogReplayField(
  model: CatalogModel | undefined,
): string | undefined {
  if (!model || !model.interleaved) return undefined
  return model.interleaved === true ? undefined : model.interleaved.field
}

/** Human-readable tier scope for a cost tier's `minContextTokens`. */
export function catalogCostTierFor(
  model: CatalogModel | undefined,
  inputTokens: number,
): { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined {
  if (!model?.cost) return undefined
  const tiers = model.cost.tiers
  if (!tiers?.length) return undefined
  let match: CatalogCostTier | undefined
  for (const tier of tiers) {
    if (inputTokens >= tier.minContextTokens) {
      if (!match || tier.minContextTokens > match.minContextTokens) match = tier
    }
  }
  if (!match) return undefined
  return {
    ...(match.input !== undefined ? { input: match.input } : {}),
    ...(match.output !== undefined ? { output: match.output } : {}),
    ...(match.cacheRead !== undefined ? { cacheRead: match.cacheRead } : {}),
    ...(match.cacheWrite !== undefined ? { cacheWrite: match.cacheWrite } : {}),
  }
}
