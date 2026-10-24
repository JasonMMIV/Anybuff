/**
 * ADR-31: the catalog refresh is event-driven and gated by a 30-day staleness
 * check. `force` and its cooldown were removed when the trigger table was
 * narrowed to configuration changes — this file now pins the surviving
 * semantics (once-per-process pair, snapshot hits, failed-refresh retry,
 * offline mode) plus the staleness gate itself.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  clearModelCatalogCacheForTest,
  prefetchModelCatalogForModel,
  refreshModelCatalogIfStale,
  setModelCatalogOnline,
} from '../model-catalog-hydration'

const CATALOG = {
  acmelab: {
    api: 'https://api.acmelab.test/v1',
    models: {
      'acme-one': { limit: { context: 128_000, output: 8_000 } },
    },
  },
}

const originalFetch = globalThis.fetch
let requests = 0

beforeEach(() => {
  clearModelCatalogCacheForTest()
  requests = 0
  globalThis.fetch = (async () => {
    requests += 1
    return new Response(JSON.stringify(CATALOG), { status: 200 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearModelCatalogCacheForTest()
})

const unknownPair = {
  providerId: 'acmelab',
  baseURL: 'https://api.acmelab.test/v1',
  model: 'acme-unknown',
}

describe('prefetchModelCatalogForModel', () => {
  test('a pair is attempted once per process', async () => {
    expect(await prefetchModelCatalogForModel(unknownPair)).toBe(true)
    expect(requests).toBe(1)
    expect(await prefetchModelCatalogForModel(unknownPair)).toBe(false)
    expect(requests).toBe(1)
  })

  test('a catalog hit short-circuits', async () => {
    expect(await prefetchModelCatalogForModel(unknownPair)).toBe(true)
    expect(requests).toBe(1)
    expect(
      await prefetchModelCatalogForModel({
        providerId: 'acmelab',
        baseURL: unknownPair.baseURL,
        model: 'acme-one',
      })
    ).toBe(false)
    expect(requests).toBe(1)
  })

  test('a failed refresh leaves the pair retryable', async () => {
    globalThis.fetch = (async () => {
      requests += 1
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await prefetchModelCatalogForModel(unknownPair)).toBe(false)
    expect(requests).toBe(1)
    // Back online: the pair was never marked as attempted, so it retries.
    globalThis.fetch = (async () => {
      requests += 1
      return new Response(JSON.stringify(CATALOG), { status: 200 })
    }) as unknown as typeof fetch
    expect(await prefetchModelCatalogForModel(unknownPair)).toBe(true)
    expect(requests).toBe(2)
  })

  test('online=false performs no request', async () => {
    setModelCatalogOnline(false)
    expect(await prefetchModelCatalogForModel(unknownPair)).toBe(false)
    expect(requests).toBe(0)
  })
})

describe('refreshModelCatalogIfStale', () => {
  test('skips the request while the newest copy is inside the window', async () => {
    expect(await refreshModelCatalogIfStale(0)).toBe(true)
    expect(requests).toBe(1)
    // `fetchedAt` is now — a 30-day window must not fetch again.
    expect(await refreshModelCatalogIfStale(30)).toBe(false)
    expect(requests).toBe(1)
  })

  test('a zero-day window treats the current catalog as stale', async () => {
    expect(await refreshModelCatalogIfStale(0)).toBe(true)
    expect(requests).toBe(1)
    expect(await refreshModelCatalogIfStale(0)).toBe(true)
    expect(requests).toBe(2)
  })

  test('online=false makes the stale check a no-op', async () => {
    setModelCatalogOnline(false)
    expect(await refreshModelCatalogIfStale(0)).toBe(false)
    expect(requests).toBe(0)
  })
})
