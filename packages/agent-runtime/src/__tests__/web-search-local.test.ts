import { describe, expect, test } from 'bun:test'

import { handleWebSearch } from '../tools/handlers/tool/web-search'
import { extractSubagentContextParams } from '../tools/handlers/tool/spawn-agent-utils'
import { parseDuckDuckGoHtml } from '../tools/handlers/tool/web-search-utils'

/** Mock fetch that routes by URL and captures request info. */
function mockFetchByUrl(
  routes: Array<{
    match: (url: string) => boolean
    respond: () => Response | Promise<Response>
  }>,
): { captured: { url: string; init?: RequestInit }[]; restore: () => void } {
  const originalFetch = globalThis.fetch
  const captured: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    captured.push({ url, init })
    for (const route of routes) {
      if (route.match(url)) return route.respond()
    }
    throw new Error(`No mock route for ${url}`)
  }) as unknown as typeof fetch
  return {
    captured,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const makeParams = (
  input: Record<string, unknown>,
  overrides: Partial<Parameters<typeof handleWebSearch>[0]> = {},
) => ({
  previousToolCallFinished: Promise.resolve(),
  toolCall: {
    toolCallId: 't1',
    toolName: 'web_search' as const,
    input,
  } as any,
  logger: logger as any,
  signal: new AbortController().signal,
  agentStepId: 'step-1',
  clientSessionId: 'session-1',
  fingerprintId: 'fp-1',
  repoId: undefined,
  userInputId: 'input-1',
  userId: undefined,
  ...overrides,
})

const DDG_HTML = `
<div class="result">
  <a class="result__a" href="https://example.com/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide">Best Guide Ever</a>
  <div class="result__snippet">A very useful guide about testing.</div>
</div>
<div class="result">
  <a class="result__a" href="https://another.example.org/page">Second Result</a>
  <a class="result__snippet" href="#">snippet anchor variant</a>
</div>
`

describe('web_search (local DuckDuckGo port)', () => {
  test('parseDuckDuckGoHtml extracts title/url/description and unwraps uddg', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML)
    expect(results.length).toBe(2)
    expect(results[0].title).toBe('Best Guide Ever')
    expect(results[0].url).toBe('https://docs.example.com/guide')
    expect(results[0].description).toContain('testing')
  })

  test('search branch returns formatted results with links (mocked fetch)', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(DDG_HTML, {
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch
    try {
      const { output } = await handleWebSearch(makeParams({ query: 'test' }))
      const value = (output[0] as any).value
      expect(value.result).toContain('1. Best Guide Ever')
      expect(value.result).toContain('Source: https://docs.example.com/guide')
      expect(Array.isArray(value.links)).toBe(true)
      expect(value.links[0].href).toBe('https://docs.example.com/guide')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('url branch refuses private/loopback targets (SSRF guard)', async () => {
    const { output } = await handleWebSearch(
      makeParams({ url: 'http://127.0.0.1:8080/secret' }),
    )
    const value = (output[0] as any).value
    expect(String(value.errorMessage)).toMatch(/non-public/i)
  })

  test('requires query or url', async () => {
    const { output } = await handleWebSearch(makeParams({}))
    const value = (output[0] as any).value
    expect(String(value.errorMessage)).toMatch(/query or url/i)
  })
})

describe('web_search providers', () => {
  test('firecrawl provider sends keyless POST without Authorization header', async () => {
    const m = mockFetchByUrl([
      {
        match: (url) => url.includes('api.firecrawl.dev'),
        respond: () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                web: [
                  { url: 'https://example.com/a', title: 'A', description: 'desc a' },
                ],
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      },
    ])
    try {
      const { output } = await handleWebSearch(
        makeParams({ query: 'test' }, { webSearch: { provider: 'firecrawl' } }),
      )
      const value = (output[0] as any).value
      expect(value.result).toContain('1. A')
      expect(value.result).toContain('Source: https://example.com/a')
      const call = m.captured[0]
      expect(call.init?.method).toBe('POST')
      expect(call.init?.headers).not.toHaveProperty('Authorization')
      const body = JSON.parse(String(call.init?.body))
      expect(body).toEqual({ query: 'test', limit: 5, sources: [{ type: 'web' }] })
    } finally {
      m.restore()
    }
  })

  test('firecrawl provider sends Bearer header when a key is configured', async () => {
    const m = mockFetchByUrl([
      {
        match: (url) => url.includes('api.firecrawl.dev'),
        respond: () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                web: [{ url: 'https://example.com/a', title: 'A', description: 'desc a' }],
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      },
    ])
    try {
      const { output } = await handleWebSearch(
        makeParams(
          { query: 'test' },
          { webSearch: { provider: 'firecrawl', firecrawlApiKey: 'fc-test' } },
        ),
      )
      expect((output[0] as any).value.result).toContain('1. A')
      expect((m.captured[0].init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer fc-test',
      )
    } finally {
      m.restore()
    }
  })

  test('firecrawl parses web results first, then news as top-up with snippet fallback', async () => {
    const m = mockFetchByUrl([
      {
        match: (url) => url.includes('api.firecrawl.dev'),
        respond: () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                web: [{ url: 'https://example.com/w1', title: 'W1', description: 'web one' }],
                news: [{ url: 'https://example.com/n1', title: 'N1', snippet: 'news one' }],
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      },
    ])
    try {
      const { output } = await handleWebSearch(
        makeParams({ query: 'test', depth: 'deep' }, { webSearch: { provider: 'firecrawl' } }),
      )
      const value = (output[0] as any).value
      expect(value.result).toContain('1. W1')
      expect(value.result).toContain('2. N1')
      expect(value.result).toContain('news one')
      // deep → limit 10
      expect(JSON.parse(String(m.captured[0].init?.body)).limit).toBe(10)
    } finally {
      m.restore()
    }
  })

  test('tinyfish provider sends X-API-Key and parses results', async () => {
    const m = mockFetchByUrl([
      {
        match: (url) => url.includes('api.search.tinyfish.ai'),
        respond: () =>
          new Response(
            JSON.stringify({
              results: [{ url: 'https://example.com/t1', title: 'T1', snippet: 'tiny one' }],
              total_results: 1,
              page: 0,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      },
    ])
    try {
      const { output } = await handleWebSearch(
        makeParams(
          { query: 'test' },
          { webSearch: { provider: 'tinyfish', tinyfishApiKey: 'tf-key' } },
        ),
      )
      const value = (output[0] as any).value
      expect(value.result).toContain('1. T1')
      expect(m.captured[0].url).toContain('api.search.tinyfish.ai')
      expect((m.captured[0].init?.headers as Record<string, string>)['X-API-Key']).toBe('tf-key')
    } finally {
      m.restore()
    }
  })

  test('tinyfish without a key falls back to other providers with a notice', async () => {
    const m = mockFetchByUrl([
      {
        match: (url) => url.includes('html.duckduckgo.com'),
        respond: () =>
          new Response(DDG_HTML, { headers: { 'content-type': 'text/html' } }),
      },
      {
        match: (url) => url.includes('api.firecrawl.dev'),
        respond: () =>
          new Response(
            JSON.stringify({
              success: true,
              data: { web: [{ url: 'https://example.com/fc', title: 'FC Result', description: 'from firecrawl' }] },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      },
    ])
    try {
      // Tinyfish selected but no key → skipped from the chain entirely; the
      // next usable provider (DuckDuckGo) serves the request with a notice.
      const { output } = await handleWebSearch(
        makeParams({ query: 'test' }, { webSearch: { provider: 'tinyfish' } }),
      )
      const value = (output[0] as any).value
      expect(value.result).toContain('[anybuff-websearch]')
      expect(value.result).toContain('Tinyfish needs an API key')
      expect(value.result).toContain('automatically switched to')
      expect(value.result).toContain('1. Best Guide Ever')
      // Tinyfish should never be called (no key)
      expect(m.captured.some((c) => c.url.includes('api.search.tinyfish.ai'))).toBe(false)
    } finally {
      m.restore()
    }
  })

  test('duckduckgo 403 falls back to keyless firecrawl with a notice', async () => {
    const m = mockFetchByUrl([
      {
        match: (url) => url.includes('html.duckduckgo.com'),
        respond: () => new Response('', { status: 403, statusText: 'Forbidden' }),
      },
      {
        match: (url) => url.includes('api.firecrawl.dev'),
        respond: () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                web: [
                  { url: 'https://example.com/fc', title: 'FC Result', description: 'from firecrawl' },
                ],
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      },
    ])
    try {
      // No webSearch option → provider defaults to duckduckgo → fallback fires.
      const { output } = await handleWebSearch(makeParams({ query: 'test' }))
      const value = (output[0] as any).value
      expect(value.result).toContain('[anybuff-websearch]')
      expect(value.result).toContain('DuckDuckGo search failed: HTTP 403')
      expect(value.result).toContain('automatically switched to Firecrawl')
      expect(value.result).toContain('1. FC Result')
      expect(value.links[0].href).toBe('https://example.com/fc')
    } finally {
      m.restore()
    }
  })

  test('all providers failing aggregates the errors', async () => {
    const m = mockFetchByUrl([
      {
        match: (url) => url.includes('html.duckduckgo.com'),
        respond: () => new Response('', { status: 429, statusText: 'Too Many Requests' }),
      },
      {
        match: (url) => url.includes('api.firecrawl.dev'),
        respond: () => new Response('', { status: 500, statusText: 'Server Error' }),
      },
    ])
    try {
      // No webSearch option → provider defaults to duckduckgo. Chain is
      // [duckduckgo, firecrawl] (tinyfish skipped — no key). Both fail.
      const { output } = await handleWebSearch(makeParams({ query: 'test' }))
      const value = (output[0] as any).value
      expect(String(value.errorMessage)).toMatch(/failed on all providers/)
      expect(String(value.errorMessage)).toMatch(/DuckDuckGo search failed/)
      expect(String(value.errorMessage)).toMatch(/Firecrawl search failed/)
    } finally {
      m.restore()
    }
  })

  test('firecrawl rate-limited falls back to duckduckgo with a notice', async () => {
    const m = mockFetchByUrl([
      {
        match: (url) => url.includes('api.firecrawl.dev'),
        respond: () => new Response('', { status: 429, statusText: 'Too Many Requests' }),
      },
      {
        match: (url) => url.includes('html.duckduckgo.com'),
        respond: () =>
          new Response(DDG_HTML, { headers: { 'content-type': 'text/html' } }),
      },
    ])
    try {
      const { output } = await handleWebSearch(
        makeParams({ query: 'test' }, { webSearch: { provider: 'firecrawl' } }),
      )
      const value = (output[0] as any).value
      expect(value.result).toContain('[anybuff-websearch]')
      expect(value.result).toContain('Firecrawl search failed: HTTP 429')
      expect(value.result).toContain('automatically switched to DuckDuckGo')
      expect(value.result).toContain('1. Best Guide Ever')
    } finally {
      m.restore()
    }
  })
})

describe('web_search subagent context', () => {
  test('extractSubagentContextParams forwards webSearch to subagents', () => {
    const webSearch = { provider: 'tinyfish' as const, tinyfishApiKey: 'k' }
    const out = extractSubagentContextParams({
      clientEnv: {},
      ciEnv: {},
      getUserInfoFromApiKey: async () => null,
      fetchAgentFromDatabase: async () => null,
      startAgentRun: async () => ({}),
      finishAgentRun: async () => {},
      addAgentStep: async () => {},
      consumeCreditsWithFallback: async () => ({}),
      promptAiSdkStream: async () => {},
      promptAiSdk: async () => {},
      promptAiSdkStructured: async () => {},
      databaseAgentCache: new Map(),
      trackEvent: () => {},
      logger,
      fetch: globalThis.fetch,
      webSearch,
      handleStepsLogChunk: () => {},
      requestToolCall: async () => ({ output: [] }),
      requestMcpToolData: async () => [],
      requestFiles: async () => ({}),
      requestOptionalFile: async () => null,
      sendAction: async () => {},
      sendSubagentChunk: () => {},
      apiKey: 'k',
      clientSessionId: 's',
      costMode: 'normal',
      extraCodebuffMetadata: {},
      fileContext: {} as any,
      localAgentTemplates: {},
      repoId: undefined,
      repoUrl: undefined,
      signal: new AbortController().signal,
      userId: undefined,
    } as any)
    expect(out.webSearch).toEqual(webSearch)
  })
})
