/**
 * ADR-27 MC-2.2 contract tests — probe-sample retention:
 *  - rejected / replay-conflict bodies are retained (full body, capped)
 *  - error verdicts (auth/transport) are NEVER retained (parser corpus noise)
 *  - accepted / not-probed → nothing retained
 *  - dedup: identical evidence does not grow the corpus
 *  - FIFO cap at 200 entries
 *  - corrupt samples file → self-healing empty read, probe still functions
 *  - list / clear channels round-trip
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installHostEnv } from '../env'
import { noEncryptionSecrets } from './helpers'
import { updateProviders } from '../settings/settings'
import { createHost } from '../channels'

let dataDir: string

function pinEnv(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'probe-samples-'))
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: { ...noEncryptionSecrets(), decryptString: () => 'k' },
    keyOverrides: { goat: 'sk-test' },
  })
  updateProviders(
    [
      {
        id: 'goat',
        label: 'Goat',
        type: 'openai-compatible' as const,
        baseURL: 'https://goat.test/v1',
        apiKeyEnv: 'GOAT_API_KEY',
        models: ['deepseek/deepseek-v4.1-flash'],
      },
    ],
    'goat/deepseek/deepseek-v4.1-flash',
    'default',
    'balanced',
  )
}

afterAll(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // Windows AV locks on tmp dirs — the OS will reap them.
  }
})

/** Minimal 400/422 chat-completions Response mock. */
function chat400(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** A clean 200 with reasoning_content (round 1 pass + reasoning seen). */
function okWithReasoning(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'ok',
            reasoning_content: 'thinking about it',
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** Install a fetch mock cycling odd=round1, even=round2. */
function mockTwoRounds(round1: Response, round2: () => Response): void {
  let call = 0
  globalThis.fetch = (async () => {
    call += 1
    return call % 2 === 1 ? round1 : round2()
  }) as unknown as typeof fetch
}

/** Round-1 400 rejection with the given body (round 2 never fires). */
function mockRound1Rejected(body: string): void {
  mockTwoRounds(chat400(400, body), () => { throw new Error('round 2 must not fire') })
}

describe('MC-2.2 probe-sample retention', () => {
  beforeEach(() => {
    pinEnv()
  })

  test('rejected (round-1 400) → sample retained with full body; probe still ok', async () => {
    const body =
      '{"error":{"message":"reasoning_effort must be one of: low, medium, high"}}'
    mockRound1Rejected(body)
    const host = createHost()
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['xhigh'] },
    ])) as unknown as { ok: boolean; retainedCount: number; results: Array<{ verdict: string }> }
    expect(result.ok).toBe(true)
    expect(result.results[0].verdict).toBe('rejected')
    expect(result.retainedCount).toBe(1)

    const list = (await host.dispatch('listProbeSamples', [])) as unknown as {
      ok: boolean
      samples: Array<{ key: string; rung: string; verdict: string; body: string; status: number }>
    }
    expect(list.ok).toBe(true)
    expect(list.samples.length).toBe(1)
    expect(list.samples[0].key).toBe('goat/deepseek/deepseek-v4.1-flash')
    expect(list.samples[0].rung).toBe('xhigh')
    expect(list.samples[0].verdict).toBe('rejected')
    expect(list.samples[0].status).toBe(400)
    expect(list.samples[0].body).toContain('must be one of')
  })

  test('replay-conflict (round-2 400 on reasoning_content) → retained with that verdict', async () => {
    mockTwoRounds(
      okWithReasoning(),
      () =>
        chat400(
          400,
          JSON.stringify({
            error: {
              message:
                'The reasoning_content in the thinking mode must be passed back to the API in the last round of messages',
            },
          }),
        ),
    )
    const host = createHost()
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['high'] },
    ])) as unknown as { ok: boolean; retainedCount: number; results: Array<{ verdict: string }> }
    expect(result.results[0].verdict).toBe('replay-conflict')
    expect(result.retainedCount).toBe(1)
    const list = (await host.dispatch('listProbeSamples', [])) as unknown as {
      samples: Array<{ verdict: string }>
    }
    expect(list.samples[0].verdict).toBe('replay-conflict')
  })

  test('auth failure (401) → error verdict, NEVER retained as a sample', async () => {
    globalThis.fetch = (async () =>
      chat400(401, '{"error":{"message":"Invalid API key"}}')) as unknown as typeof fetch
    const host = createHost()
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['high'] },
    ])) as unknown as { ok: boolean; retainedCount: number; results: Array<{ verdict: string }> }
    expect(result.results[0].verdict).toBe('error')
    expect(result.retainedCount).toBe(0)
    const list = (await host.dispatch('listProbeSamples', [])) as unknown as {
      samples: unknown[]
    }
    expect(list.samples.length).toBe(0)
  })

  test('accepted verdict → nothing retained', async () => {
    globalThis.fetch = (async () => okWithReasoning()) as unknown as typeof fetch
    const host = createHost()
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['high'] },
    ])) as unknown as { ok: boolean; retainedCount: number }
    expect(result.ok).toBe(true)
    expect(result.retainedCount).toBe(0)
    const list = (await host.dispatch('listProbeSamples', [])) as unknown as {
      samples: unknown[]
    }
    expect(list.samples.length).toBe(0)
  })

  test('dedup: identical evidence does not grow the corpus', async () => {
    const body = '{"error":{"message":"reasoning_effort must be one of: low, high"}}'
    const probeOnce = async () => {
      mockRound1Rejected(body)
      const host = createHost()
      return (await host.dispatch('probeReasoningEffort', [
        { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['xhigh'] },
      ])) as unknown as { retainedCount: number }
    }
    expect((await probeOnce()).retainedCount).toBe(1)
    expect((await probeOnce()).retainedCount).toBe(0)
    const list = (await createHost().dispatch('listProbeSamples', [])) as unknown as {
      samples: unknown[]
    }
    expect(list.samples.length).toBe(1)
  })

  test('corrupt samples file → self-healing empty read, probe still functions', async () => {
    writeFileSync(join(dataDir, 'probe-samples.json'), 'not json at all')
    mockRound1Rejected('{"error":{"message":"must be one of: low"}}')
    const host = createHost()
    const result = (await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['ultra'] },
    ])) as unknown as { ok: boolean; retainedCount: number }
    expect(result.ok).toBe(true)
    expect(result.retainedCount).toBe(1)
    const list = (await host.dispatch('listProbeSamples', [])) as unknown as {
      samples: unknown[]
    }
    expect(list.samples.length).toBe(1)
  })

  test('clearProbeSamples wipes the corpus', async () => {
    mockRound1Rejected('{"error":{"message":"must be one of: low"}}')
    const host = createHost()
    await host.dispatch('probeReasoningEffort', [
      { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: ['ultra'] },
    ])
    const cleared = (await host.dispatch('clearProbeSamples', [])) as unknown as { ok: boolean }
    expect(cleared.ok).toBe(true)
    const list = (await host.dispatch('listProbeSamples', [])) as unknown as {
      samples: unknown[]
    }
    expect(list.samples.length).toBe(0)
  })

  test('FIFO cap: corpus never exceeds 200 entries', async () => {
    let call = 0
    // 210 distinct rejected rungs, each with a distinct body.
    globalThis.fetch = (async () => {
      call += 1
      return call % 2 === 1
        ? chat400(400, `{"error":{"message":"must be one of: v${call}"}}`)
        : okWithReasoning()
    }) as unknown as typeof fetch
    const host = createHost()
    for (let i = 0; i < 210; i++) {
      await host.dispatch('probeReasoningEffort', [
        { providerId: 'goat', model: 'deepseek/deepseek-v4.1-flash', rungs: [`rung-${i}`] },
      ])
    }
    const list = (await host.dispatch('listProbeSamples', [])) as unknown as {
      samples: Array<{ rung: string }>
    }
    expect(list.samples.length).toBe(200)
    // FIFO: the OLDEST ten were dropped, the newest kept.
    expect(list.samples[0].rung).toBe('rung-10')
    expect(list.samples[199].rung).toBe('rung-209')
  })
})
