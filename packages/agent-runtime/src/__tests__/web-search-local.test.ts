import { describe, expect, test } from 'bun:test'

import { handleWebSearch } from '../tools/handlers/tool/web-search'
import { parseDuckDuckGoHtml } from '../tools/handlers/tool/web-search-utils'

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
