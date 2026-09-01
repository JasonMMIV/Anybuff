import {
  WEBSEARCH_TIMEOUT_MS,
  fetchPublicWebUrl,
  parseDuckDuckGoHtml,
  readResponseTextWithLimit,
} from './web-search-utils'

import type { WebSearchResult } from './web-search-utils'
import type { WebSearchProviderId } from '@codebuff/common/types/contracts/agent-runtime'

export type WebSearchOutcome =
  | { results: WebSearchResult[]; notice?: string }
  | { error: string; status?: number }

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (compatible; AnyBuff/1.0; +https://github.com/anybuff)',
} as const

function resultLimit(depth: 'standard' | 'deep'): number {
  return depth === 'deep' ? 10 : 5
}

/** DuckDuckGo HTML search (the original AnyBuff port). */
async function searchDuckDuckGo(
  query: string,
  depth: 'standard' | 'deep',
  signal: AbortSignal,
): Promise<WebSearchOutcome> {
  const limit = resultLimit(depth)
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const { response } = await fetchPublicWebUrl({
      url: searchUrl,
      headers: REQUEST_HEADERS,
      signal,
    })
    if (!response.ok) {
      return {
        error: `DuckDuckGo search failed: HTTP ${response.status} ${response.statusText}`,
        status: response.status,
      }
    }
    const { text } = await readResponseTextWithLimit({ response })
    return { results: parseDuckDuckGoHtml(text).slice(0, limit) }
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : `Unknown web search error: ${String(error)}`,
    }
  }
}

/**
 * Firecrawl v2 Search. The hosted `/v2/search` endpoint accepts keyless
 * requests (free, per-IP daily caps); a Bearer API key is optional and only
 * used for higher rate limits (reference: kelivo's FirecrawlSearchService).
 */
async function searchFirecrawl(
  query: string,
  depth: 'standard' | 'deep',
  signal: AbortSignal,
  apiKey: string | undefined,
): Promise<WebSearchOutcome> {
  const limit = resultLimit(depth)
  try {
    const { response } = await fetchPublicWebUrl({
      url: 'https://api.firecrawl.dev/v2/search',
      method: 'POST',
      body: JSON.stringify({
        query,
        limit,
        sources: [{ type: 'web' }],
      }),
      headers: {
        ...REQUEST_HEADERS,
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal,
    })
    if (!response.ok) {
      return {
        error: `Firecrawl search failed: HTTP ${response.status} ${response.statusText}`,
        status: response.status,
      }
    }
    const { text } = await readResponseTextWithLimit({ response })
    const payload = JSON.parse(text) as Record<string, unknown>
    const data =
      (payload.data as Record<string, unknown> | undefined) ?? payload
    const items: WebSearchResult[] = []
    const append = (list: unknown): void => {
      if (!Array.isArray(list)) return
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue
        const m = raw as Record<string, unknown>
        const title = String(m.title ?? '')
        const url = String(m.url ?? '')
        if (!title.trim() && !url.trim()) continue
        items.push({
          title,
          url,
          description: String(m.description ?? m.snippet ?? m.markdown ?? ''),
        })
        if (items.length >= limit) return
      }
    }
    // web results first; news only top up the remainder (kelivo semantics).
    append(data.web)
    if (items.length < limit) append(data.news)
    return { results: items.slice(0, limit) }
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Firecrawl search failed: ${error.message}`
          : `Firecrawl search failed: ${String(error)}`,
    }
  }
}

/** Tinyfish Search (free, 30 req/min; key via agent.tinyfish.ai/api-keys). */
async function searchTinyfish(
  query: string,
  depth: 'standard' | 'deep',
  signal: AbortSignal,
  apiKey: string | undefined,
): Promise<WebSearchOutcome> {
  if (!apiKey) {
    return {
      error:
        'Tinyfish search requires an API key. Get one at https://agent.tinyfish.ai/api-keys, then add it in Settings → Web Search.',
    }
  }
  const limit = resultLimit(depth)
  try {
    const searchUrl = `https://api.search.tinyfish.ai/?query=${encodeURIComponent(query)}`
    const { response } = await fetchPublicWebUrl({
      url: searchUrl,
      headers: {
        ...REQUEST_HEADERS,
        'X-API-Key': apiKey,
      },
      signal,
    })
    if (!response.ok) {
      // Surface provider error codes (e.g. RATE_LIMIT_EXCEEDED) when present.
      const { text } = await readResponseTextWithLimit({ response })
      let detail = ''
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        const err = parsed.error as Record<string, unknown> | undefined
        const code = typeof err?.code === 'string' ? err.code : ''
        const message = typeof err?.message === 'string' ? err.message : ''
        detail = [code, message].filter(Boolean).join(' — ')
      } catch {
        // non-JSON error body — fall back to the HTTP status line
      }
      return {
        error: `Tinyfish search failed: ${detail || `HTTP ${response.status} ${response.statusText}`}`,
        status: response.status,
      }
    }
    const { text } = await readResponseTextWithLimit({ response })
    const payload = JSON.parse(text) as Record<string, unknown>
    const results: WebSearchResult[] = []
    if (Array.isArray(payload.results)) {
      for (const raw of payload.results) {
        if (!raw || typeof raw !== 'object') continue
        const m = raw as Record<string, unknown>
        const title = String(m.title ?? '')
        const url = String(m.url ?? '')
        if (!title.trim() && !url.trim()) continue
        results.push({
          title,
          url,
          description: String(m.snippet ?? m.description ?? ''),
        })
        if (results.length >= limit) break
      }
    }
    return { results }
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Tinyfish search failed: ${error.message}`
          : `Tinyfish search failed: ${String(error)}`,
    }
  }
}

/** Fallback priority when the primary provider fails. */
const FALLBACK_ORDER: WebSearchProviderId[] = [
  'duckduckgo',
  'firecrawl',
  'tinyfish',
]

/** Whether a provider can serve a request right now (Tinyfish needs a key). */
function isProviderAvailable(
  id: WebSearchProviderId,
  opts: { tinyfishApiKey?: string },
): boolean {
  if (id === 'tinyfish') return Boolean(opts.tinyfishApiKey)
  // duckduckgo is free; firecrawl works keyless (lower limits).
  return true
}

const PROVIDER_LABEL: Record<WebSearchProviderId, string> = {
  duckduckgo: 'DuckDuckGo',
  firecrawl: 'Firecrawl',
  tinyfish: 'Tinyfish',
}

/**
 * Build the ordered attempt chain: primary first, then usable fallbacks.
 * A provider that is not usable right now (e.g. Tinyfish without a key) is
 * excluded from the chain entirely — including when it is the primary — so
 * the request skips straight to the next usable provider.
 */
function buildAttemptChain(
  primary: WebSearchProviderId,
  opts: { tinyfishApiKey?: string },
): WebSearchProviderId[] {
  const usable = FALLBACK_ORDER.filter((id) =>
    isProviderAvailable(id, opts),
  )
  return usable.sort((a, b) => {
    // Primary always first; the rest follow FALLBACK_ORDER.
    if (a === primary) return -1
    if (b === primary) return 1
    return FALLBACK_ORDER.indexOf(a) - FALLBACK_ORDER.indexOf(b)
  })
}

/**
 * Execute a bounded, abortable web search through the configured provider.
 * Backwards compatible: no opts → DuckDuckGo (the original behavior).
 *
 * When the primary provider fails (rate-limited HTTP 403/429, Tinyfish without
 * a key, network error, empty results), we automatically try the next usable
 * provider in priority order (DuckDuckGo → Firecrawl → Tinyfish). Tinyfish is
 * only ever attempted when a key is configured — it is skipped from the chain
 * when keyless. The first successful provider wins, and a `[anybuff-websearch]`
 * notice explains the switch. If every usable provider fails, the error
 * aggregates the attempts.
 */
export async function executeWebSearch(
  query: string,
  depth: 'standard' | 'deep' = 'standard',
  signal: AbortSignal = new AbortController().signal,
  opts: {
    provider?: WebSearchProviderId
    tinyfishApiKey?: string
    firecrawlApiKey?: string
  } = {},
): Promise<WebSearchOutcome> {
  const primary = opts.provider ?? 'duckduckgo'

  // If the primary provider is unusable right now (Tinyfish without a key),
  // skip it entirely and remember why for the notice.
  const primarySkippedReason = isProviderAvailable(primary, opts)
    ? null
    : `Tinyfish needs an API key (add one in Settings → Web Search)`
  const chain = buildAttemptChain(primary, opts)

  // Each searchXxx already prefixes its errors with the provider label, so
  // aggregation stays readable (no "Tinyfish: Tinyfish …" doubling).
  const failures: string[] = []
  for (const id of chain) {
    // Each attempt gets its own fresh timeout budget combined with the
    // caller's abort signal — a slow primary must not starve the fallbacks.
    const attemptSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(WEBSEARCH_TIMEOUT_MS),
    ])
    const outcome =
      id === 'duckduckgo'
        ? await searchDuckDuckGo(query, depth, attemptSignal)
        : id === 'firecrawl'
          ? await searchFirecrawl(
              query,
              depth,
              attemptSignal,
              opts.firecrawlApiKey,
            )
          : await searchTinyfish(
              query,
              depth,
              attemptSignal,
              opts.tinyfishApiKey,
            )

    if ('error' in outcome) {
      failures.push(outcome.error)
      continue
    }

    if (outcome.results.length === 0) {
      failures.push(
        `${PROVIDER_LABEL[id]} returned no results for "${query}"`,
      )
      continue
    }

    // Success on the primary provider — return as-is (backwards compatible).
    if (id === primary) return outcome

    // Success via a fallback — explain the switch. Prefer the "primary was
    // skipped" reason (Tinyfish keyless); otherwise list every failure so the
    // user sees why the earlier providers were passed over.
    const failureSummary =
      primarySkippedReason ??
      (failures.length > 0
        ? failures.join('; ')
        : `${PROVIDER_LABEL[primary]} failed`)
    const mode =
      id === 'firecrawl' && !opts.firecrawlApiKey ? ' (keyless)' : ''
    return {
      results: outcome.results,
      notice: `[anybuff-websearch] ${failureSummary}; automatically switched to ${PROVIDER_LABEL[id]}${mode}. Consider changing the default provider in Settings → Web Search.`,
    }
  }

  // Every usable provider failed.
  const allErrors = [
    ...(primarySkippedReason ? [primarySkippedReason] : []),
    ...failures,
  ]
  return {
    error: `Web search failed on all providers: ${allErrors.join(' | ')}`,
  }
}
