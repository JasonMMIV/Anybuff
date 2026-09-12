/**
 * ADR-27 MC-2.1 probe contract tests — the two-round shape and verdict
 * classification, against a mocked fetch (no live endpoint needed):
 *
 * 1. round 1 clean + reasoning + round 2 clean → 'accepted'
 * 2. round 1 clean + NO reasoning → 'not-probed' (replay contract not exercised)
 * 3. round 1 400 → 'rejected' (round 2 never fires)
 * 4. round 1 clean + round 2 400 naming reasoning_content → 'replay-conflict' (ADR-26 class)
 * 5. round 2 400 with an unrelated body → 'rejected'
 * 6. no stored key on a remote provider → early error envelope
 * 7. anthropic-compatible providers → explicit not-supported message
 * 8. the two request shapes themselves: round 1 carries no tools; round 2
 *    replays round 1's assistant turn WITH its reasoning and carries tools.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installHostEnv } from '../env'
import { noEncryptionSecrets } from './helpers'
import { updateProviders } from '../settings/settings'
import { createHost } from '../channels'

const originalFetch = globalThis.fetch

function pinEnv(remote: boolean): string {
  const dataDir = mkdtempSync(join(tmpdir(), remote ? 'host-probe-remote-' : 'host-probe-local-'))
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: remote ? { ...noEncryptionSecrets(), decryptString: () => 'k' } : noEncryptionSecrets(),
    keyOverrides: remote ? { goat: 'sk-test' } : {},
  })
  updateProviders(
    [
      {
        id: 'goat',
        label: 'Goat',
        type: 'openai-compatible' as const,
        baseURL: remote ? 'https://goat.test/v1' : 'http://localhost:9/v1',
        apiKeyEnv: 'GOAT_API_KEY',
        models: ['deepseek/deepseek-v4.1-flash'],
      },
    ],
    'goat/deepseek/deepseek-v4.1-flash',
    'default',
    'balanced'
  )
  return dataDir
}

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

function chatResponse(opts: {
  content?: string
  reasoning?: string
  status?: number
  errorBody?: string
}): Response {
  const status = opts.status ?? 200
  if (status !== 200) {
    return new Response(opts.errorBody ?? '{}', { status })
  }
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: opts.content ?? 'ok',
            ...(opts.reasoning !== undefined ? { reasoning_content: opts.reasoning } : {}),
          },
        },
      ],
    }),
    { status }
  )
}

function installFetchMock(handler: (req: CapturedRequest, round: number) => Response): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  let round = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    round += 1
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const req = { url: String(input), body }
    captured.push(req)
    return handler(req, round)
  }) as typeof fetch
  return captured
}

describe('probeReasoningEffort (MC-2.1: two-round shape + verdicts)', () => {
  const host = createHost()
  let dataDir = ''

  beforeEach(() => {
    dataDir = pinEnv(true)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  test('clean reasoning + clean replay → accepted; round shapes are two-round', async () => {
    const captured = installFetchMock((_req, round) =>
      round === 1
        ? chatResponse({ reasoning: 'thinking…' })
        : chatResponse({ content: 'ok' })
    )
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['high'] },
    ])) as unknown as {
      ok: boolean
      results: Array<{ rung: string; verdict: string; sawReasoning?: boolean }>
      acceptedRungs: string[]
    }
    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ rung: 'high', verdict: 'accepted', sawReasoning: true })
    expect(result.acceptedRungs).toEqual(['high'])
    // Two rounds fired; round 1 has no tools, round 2 carries tools + the
    // replayed assistant turn with its reasoning_content.
    expect(captured.length).toBe(2)
    const round1 = captured[0].body
    const round2 = captured[1].body
    expect(round1.tools).toBeUndefined()
    expect(Array.isArray(round2.tools)).toBe(true)
    const messages2 = round2.messages as Array<Record<string, unknown>>
    expect(messages2[1].role).toBe('assistant')
    expect(messages2[1].reasoning_content).toBe('thinking…')
  })

  test('round-1 clean but model gives no reasoning → not-probed (contract not exercised)', async () => {
    installFetchMock((_req, round) =>
      round === 1 ? chatResponse({ content: 'ok' }) : chatResponse({ content: 'ok' })
    )
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['low'] },
    ])) as unknown as { results: Array<{ verdict: string; sawReasoning?: boolean }> }
    expect(result.results[0]).toMatchObject({ verdict: 'not-probed', sawReasoning: false })
  })

  test('round-1 401 (expired key) → error verdict, never "rejected"', async () => {
    installFetchMock(() =>
      chatResponse({ status: 401, errorBody: '{"error":{"message":"Invalid API key"}}' })
    )
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['high'] },
    ])) as unknown as { results: Array<{ verdict: string; status?: number }> }
    expect(result.results[0].verdict).toBe('error')
    expect(result.results[0].status).toBe(401)
  })

  test('round-1 400 → rejected and round 2 never fires', async () => {
    const captured = installFetchMock(() =>
      chatResponse({ status: 400, errorBody: '{"error":{"message":"Invalid reasoning_effort"}}' })
    )
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['gigantic'] },
    ])) as unknown as {
      results: Array<{ verdict: string; status?: number; bodyExcerpt?: string }>
    }
    expect(result.results[0].verdict).toBe('rejected')
    expect(result.results[0].status).toBe(400)
    expect(result.results[0].bodyExcerpt).toContain('Invalid reasoning_effort')
    expect(captured.length).toBe(1)
  })

  test('round-2 400 naming reasoning_content → replay-conflict (ADR-26 class)', async () => {
    installFetchMock((_req, round) =>
      round === 1
        ? chatResponse({ reasoning: 'thinking…' })
        : chatResponse({
            status: 400,
            errorBody:
              '{"error":{"message":"The reasoning_content in the thinking mode must be passed back to the API"}}',
          })
    )
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['high'] },
    ])) as unknown as { results: Array<{ verdict: string; status?: number }> }
    expect(result.results[0].verdict).toBe('replay-conflict')
    expect(result.results[0].status).toBe(400)
  })

  test('round-2 400 with an unrelated body → rejected (not replay-conflict)', async () => {
    installFetchMock((_req, round) =>
      round === 1
        ? chatResponse({ reasoning: 'thinking…' })
        : chatResponse({ status: 400, errorBody: '{"error":{"message":"bad tool schema"}}' })
    )
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['medium'] },
    ])) as unknown as { results: Array<{ verdict: string }> }
    expect(result.results[0].verdict).toBe('rejected')
  })

  test('transport failure → error verdict, never a 400 classification', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network unreachable')
    }) as unknown as typeof fetch
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['high'] },
    ])) as unknown as { results: Array<{ verdict: string; bodyExcerpt?: string }> }
    expect(result.results[0].verdict).toBe('error')
    expect(result.results[0].bodyExcerpt).toContain('network unreachable')
  })

  test('remote provider with no stored key → early error envelope, no request fired', async () => {
    let fired = 0
    globalThis.fetch = (async () => {
      fired += 1
      return chatResponse({})
    }) as unknown as typeof fetch
    // Re-pin with no key overrides (remote URL).
    const dataDir2 = mkdtempSync(join(tmpdir(), 'host-probe-nokey-'))
    installHostEnv({
      paths: { dataDir: dataDir2, appDataDir: dataDir2, homeDir: dataDir2 },
      secrets: noEncryptionSecrets(),
      keyOverrides: {},
    })
    updateProviders(
      [
        {
          id: 'goat',
          label: 'Goat',
          type: 'openai-compatible' as const,
          baseURL: 'https://goat.test/v1',
          apiKeyEnv: 'GOAT_API_KEY',
          models: ['m'],
        },
      ],
      'goat/m',
      'default',
      'balanced'
    )
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'm', rungs: ['high'] },
    ])) as unknown as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('API key')
    expect(fired).toBe(0)
    rmSync(dataDir2, { recursive: true, force: true })
  })

  test('anthropic-compatible provider → explicit not-supported envelope', async () => {
    const dataDir2 = mkdtempSync(join(tmpdir(), 'host-probe-anthropic-'))
    installHostEnv({
      paths: { dataDir: dataDir2, appDataDir: dataDir2, homeDir: dataDir2 },
      secrets: noEncryptionSecrets(),
      keyOverrides: { p: 'k' },
    })
    updateProviders(
      [
        {
          id: 'p',
          label: 'P',
          type: 'anthropic-compatible' as const,
          baseURL: 'https://p.test',
          apiKeyEnv: 'P_KEY',
          models: ['claude-x'],
        },
      ],
      'p/claude-x',
      'default',
      'balanced'
    )
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'p', model: 'claude-x', rungs: ['high'] },
    ])) as unknown as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Anthropic-compatible')
    rmSync(dataDir2, { recursive: true, force: true })
  })
})
