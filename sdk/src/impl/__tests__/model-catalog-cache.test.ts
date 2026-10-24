/**
 * ADR-31 (batch 1): catalog cache + HTTP behaviour.
 *
 * Pins the operational contract from plan §6/§10:
 *   - startup never touches the network (snapshot / disk cache only);
 *   - one HTTP request per process under concurrency (single-flight);
 *   - ETag 304 only bumps `fetchedAt`;
 *   - a corrupt cache degrades to the snapshot, never throws;
 *   - `refreshForModel` short-circuits on a cache hit;
 *   - `modelCatalog.online = false` makes zero requests;
 *   - oversized payloads are rejected before parsing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  buildModelCatalogIndex,
  lookupCatalogModel,
  projectModelsDevCatalog,
} from '../model-catalog'
import {
  capsFromModelsDevCatalog,
  clearModelCatalogCacheForTest,
  configureModelCatalogCache,
  getModelCatalog,
  getModelCatalogStatus,
  hydrateModelCapabilities,
  lookupCatalog,
  prefetchModelCatalogForModel,
  refreshModelCatalog,
  setModelCatalogOnline,
  warmModelCatalogCache,
} from '../model-catalog-hydration'

const RAW_CATALOG = {
  deepseek: {
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-v4-flash': {
        limit: { context: 1_048_576, output: 393_216 },
        modalities: { input: ['text', 'image'], output: ['text'] },
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        cost: { input: 0.15, output: 0.6 },
      },
    },
  },
  cachedlab: {
    api: 'https://cached.example.com/v1',
    models: {
      'cached-model': {
        limit: { context: 32_000, output: 4_000 },
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
}

function catalogPayload(snapshotAt = '2026-10-22T00:00:00.000Z') {
  return projectModelsDevCatalog(RAW_CATALOG, { snapshotAt })
}

type FetchCall = { url: string; headers: Record<string, string> }

const originalFetch = globalThis.fetch

function stubFetch(
  handler: (call: FetchCall) => {
    status?: number
    ok?: boolean
    body?: string
    etag?: string | null
  },
): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      for (const [key, value] of Object.entries(
        rawHeaders as Record<string, string>,
      )) {
        headers[key.toLowerCase()] = String(value)
      }
    }
    calls.push({ url, headers })
    const result = handler({ url, headers })
    const status = result.status ?? 200
    return {
      ok: result.ok ?? (status >= 200 && status < 300),
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'etag' ? (result.etag ?? null) : null,
      },
      text: async () => result.body ?? '',
      json: async () => JSON.parse(result.body ?? '{}'),
    } as unknown as Response
  }) as typeof globalThis.fetch
  return calls
}

beforeEach(() => {
  clearModelCatalogCacheForTest()
})

afterEach(() => {
  clearModelCatalogCacheForTest()
  globalThis.fetch = originalFetch
})

describe('startup load order (snapshot → cache)', () => {
  test('without a seam the built-in snapshot answers synchronously', () => {
    const index = getModelCatalog()
    expect(index.source).toBe('snapshot')
    expect(index.providers.size).toBeGreaterThan(0)
  })

  test('a valid disk cache replaces the snapshot without any network', async () => {
    const calls = stubFetch(() => ({ status: 500 }))
    const cached = {
      ...catalogPayload('2026-10-20T00:00:00.000Z'),
      fetchedAt: '2026-10-20T00:00:00.000Z',
      etag: '"v1"',
    }
    configureModelCatalogCache({
      load: () => JSON.stringify(cached),
      save: () => {},
    })
    await warmModelCatalogCache()
    const index = getModelCatalog()
    expect(index.source).toBe('cache')
    expect(index.fetchedAt).toBe('2026-10-20T00:00:00.000Z')
    expect(
      lookupCatalogModel(index, { providerId: 'cachedlab', model: 'cached-model' })
        ?.model.contextWindow,
    ).toBe(32_000)
    expect(calls).toHaveLength(0)
  })

  test('a corrupt cache degrades to the snapshot', async () => {
    configureModelCatalogCache({ load: () => '{not json', save: () => {} })
    await warmModelCatalogCache()
    const index = getModelCatalog()
    expect(index.source).toBe('snapshot')
    expect(index.providers.size).toBeGreaterThan(0)
  })

  test('a schema-version mismatch is ignored', async () => {
    const stale = { ...catalogPayload(), schemaVersion: 999 }
    configureModelCatalogCache({
      load: () => JSON.stringify(stale),
      save: () => {},
    })
    await warmModelCatalogCache()
    expect(getModelCatalog().source).toBe('snapshot')
  })
})

describe('refresh (plan §6.2)', () => {
  test('single-flight: concurrent refreshes share one request', async () => {
    const calls = stubFetch(() => ({ body: JSON.stringify(RAW_CATALOG) }))
    const [a, b, c] = await Promise.all([
      refreshModelCatalog(),
      refreshModelCatalog(),
      refreshModelCatalog(),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(c).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://models.dev/api.json')
  })

  test('200 projects, indexes and persists the payload', async () => {
    const saved: string[] = []
    configureModelCatalogCache({
      load: () => null,
      save: (json) => {
        saved.push(json)
      },
    })
    stubFetch(() => ({
      body: JSON.stringify(RAW_CATALOG),
      etag: '"abc"',
    }))
    await refreshModelCatalog()
    const index = getModelCatalog()
    expect(index.source).toBe('network')
    expect(index.fetchedAt).toBeDefined()
    expect(
      lookupCatalogModel(index, { providerId: 'deepseek', model: 'deepseek-v4-flash' })
        ?.model.outputTokens,
    ).toBe(393_216)
    expect(saved).toHaveLength(1)
    const persisted = JSON.parse(saved[0]!)
    expect(persisted.fetchedAt).toBeDefined()
    expect(persisted.etag).toBe('"abc"')
  })

  test('304 only bumps fetchedAt and keeps the rows', async () => {
    stubFetch(() => ({ body: JSON.stringify(RAW_CATALOG), etag: '"abc"' }))
    await refreshModelCatalog()
    const firstSnapshotAt = getModelCatalog().snapshotAt
    stubFetch(() => ({ status: 304 }))
    const refreshed = await refreshModelCatalog()
    expect(refreshed).toBe(true)
    const index = getModelCatalog()
    expect(index.snapshotAt).toBe(firstSnapshotAt)
    expect(index.size).toBeGreaterThan(0)
    expect(index.fetchedAt).toBeDefined()
  })

  test('a failed refresh keeps the previous catalog', async () => {
    stubFetch(() => ({ body: JSON.stringify(RAW_CATALOG) }))
    await refreshModelCatalog()
    const before = getModelCatalog()
    stubFetch(() => ({ status: 503 }))
    expect(await refreshModelCatalog()).toBe(false)
    expect(getModelCatalog()).toBe(before)
  })

  test('an oversized payload is rejected before parsing', async () => {
    stubFetch(() => ({ body: 'x'.repeat(20 * 1024 * 1024 + 1) }))
    expect(await refreshModelCatalog()).toBe(false)
    expect(getModelCatalog().source).toBe('snapshot')
  })

  test('modelCatalog.online=false performs no request', async () => {
    const calls = stubFetch(() => ({ body: JSON.stringify(RAW_CATALOG) }))
    setModelCatalogOnline(false)
    expect(await refreshModelCatalog()).toBe(false)
    expect(calls).toHaveLength(0)
    expect(getModelCatalogStatus().online).toBe(false)
  })
})

describe('event-driven prefetch (plan §6.3)', () => {
  test('a cache hit short-circuits — no request', async () => {
    stubFetch(() => ({ body: JSON.stringify(RAW_CATALOG) }))
    await refreshModelCatalog()
    const calls = stubFetch(() => ({ body: JSON.stringify(RAW_CATALOG) }))
    prefetchModelCatalogForModel({
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    // Give the (non-existent) microtask a chance to run.
    await Promise.resolve()
    expect(calls).toHaveLength(0)
  })

  test('a miss triggers exactly one refresh (awaitable)', async () => {
    const calls = stubFetch(() => ({ body: JSON.stringify(RAW_CATALOG) }))
    // `brand-new-lab` is not in the built-in snapshot either.
    const refreshed = await prefetchModelCatalogForModel({
      providerId: 'brand-new-lab',
      model: 'brand-new-model',
    })
    expect(refreshed).toBe(true)
    expect(calls).toHaveLength(1)

    // The same pair is one-shot: a second prefetch does not fetch again.
    const second = await prefetchModelCatalogForModel({
      providerId: 'brand-new-lab',
      model: 'brand-new-model',
    })
    expect(second).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe('legacy hydration (B1d) now reads the catalog', () => {
  test('limit.input wins over limit.context (raw catalog projection)', () => {
    const caps = capsFromModelsDevCatalog(
      {
        lab: {
          models: {
            both: { limit: { context: 200_000, input: 128_000, output: 8_000 } },
            onlyContext: { limit: { context: 200_000, output: 8_000 } },
          },
        },
      },
      'lab',
      'both',
    )
    expect(caps).toEqual({ windowTokens: 128_000, outputTokens: 8_000 })
    expect(
      capsFromModelsDevCatalog(
        { lab: { models: { onlyContext: { limit: { context: 200_000, output: 8_000 } } } } },
        'lab',
        'onlyContext',
      ),
    ).toEqual({ windowTokens: 200_000, outputTokens: 8_000 })
  })

  test('a snapshot hit resolves through the catalog runtime', async () => {
    setModelCatalogOnline(false)
    const caps = await hydrateModelCapabilities({
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    expect(caps?.windowTokens).toBeGreaterThan(0)
    expect(caps?.outputTokens).toBeGreaterThan(0)

    const index = buildModelCatalogIndex(catalogPayload())
    const hit = lookupCatalogModel(index, {
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    expect(hit).toBeTruthy()
  })

  test('an unknown pair resolves to undefined without throwing', async () => {
    setModelCatalogOnline(false)
    const caps = await hydrateModelCapabilities({
      providerId: 'nowhere',
      model: 'nothing',
    })
    expect(caps).toBeUndefined()
  })
})
