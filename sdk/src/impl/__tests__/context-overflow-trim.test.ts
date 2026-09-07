import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createHttpError } from '../../error-utils'
import { reserveTokens } from '@codebuff/common/util/context-trim'
import { clearProviderConfigCacheForTest } from '../../provider-config'
import { decideContextOverflowTrim } from '../context-overflow-trim'
import {
  clearLearnedContextWindowsForTest,
  setLearnedContextWindowSink,
} from '../model-provider'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

function userMsg(text: string, extra: Partial<Message> = {}): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    sentAt: 1,
    ...extra,
  } as Message
}

function overflowError(message: string): Error & { statusCode: number } {
  return createHttpError(message, 400)
}

/** ≈150k tokens of user prose — comfortably above the 128k window's trim
 *  target (~112k) so the trim path has real tokens to drop. */
const bigHistory: Message[] = [
  userMsg('first turn of the conversation with a lot of prose. '.repeat(5_000)),
  userMsg('second turn of the conversation with a lot of prose. '.repeat(5_000)),
  userMsg('third turn of the conversation with a lot of prose. '.repeat(5_000)),
  userMsg('the live prompt for this attempt'),
]

describe('decideContextOverflowTrim', () => {
  it('non-overflow errors are passed through untouched', () => {
    const decision = decideContextOverflowTrim({
      error: createHttpError('invalid request: bad param', 400),
      messages: bigHistory,
      model: 'unknown-provider/unknown-model',
      alreadyTrimmed: false,
    })
    expect(decision).toEqual({ trim: false, reason: 'not-overflow' })
  })

  it('already-trimmed attempts never trim twice', () => {
    const decision = decideContextOverflowTrim({
      error: overflowError("This model's maximum context length is 128000 tokens"),
      messages: bigHistory,
      model: 'unknown-provider/unknown-model',
      alreadyTrimmed: true,
    })
    expect(decision).toEqual({ trim: false, reason: 'already-trimmed' })
  })

  it('trims a big history toward window minus reserve', () => {
    const windowTokens = 128_000
    const decision = decideContextOverflowTrim({
      // The error text carries the real window; request estimate comes from the
      // messages themselves.
      error: overflowError(
        `This model's maximum context length is ${windowTokens} tokens. However, your messages resulted in 999999 tokens`,
      ),
      messages: bigHistory,
      model: 'unknown-provider/unknown-model',
      alreadyTrimmed: false,
      requestTokenEstimate: 999_999,
    })
    if (!decision.trim) {
      throw new Error(`expected a trim decision, got ${decision.reason}`)
    }
    expect(decision.windowTokens).toBe(windowTokens)
    expect(decision.learnedWindowTokens).toBe(windowTokens)
    expect(decision.targetTokens).toBe(windowTokens - reserveTokens(windowTokens))
    expect(decision.messages.length).toBeLessThanOrEqual(bigHistory.length)
  })

  it('no-window: unparseable error text on an unconfigured model', () => {
    const decision = decideContextOverflowTrim({
      // context_length_exceeded carries no numbers and the model has no
      // declared window in the test environment.
      error: overflowError('context_length_exceeded'),
      messages: bigHistory,
      model: 'unknown-provider/unknown-model',
      alreadyTrimmed: false,
    })
    expect(decision).toEqual({ trim: false, reason: 'no-window' })
  })

  it('irreducible: keep-during-truncation core exceeds the target', () => {
    const messages = [
      userMsg('irreducible anchored content. '.repeat(500), {
        keepDuringTruncation: true,
      }),
    ]
    const decision = decideContextOverflowTrim({
      error: overflowError(
        "This model's maximum context length is 4096 tokens",
      ),
      messages,
      model: 'unknown-provider/unknown-model',
      alreadyTrimmed: false,
      requestTokenEstimate: 100_000,
    })
    expect(decision).toMatchObject({ trim: false, reason: 'irreducible' })
  })
})

type LearnedSinkCall = {
  providerId: string
  model: string
  windowTokens: number
}

/**
 * Runs `scenario` against a throwaway anybuff.json, restoring every piece of
 * global state before returning. Deliberately hookless and fully
 * synchronous: bun may interleave other test files' work between tests and
 * hooks, but never inside one — so the temp config (pointed at by
 * ANYBUFF_PROVIDER_CONFIG) is never visible to them. A beforeAll/afterAll
 * window here previously leaked the env var into later files' model
 * resolution and broke their streaming tests.
 */
function runSinkScenario(
  withExplicitCapability: boolean,
  scenario: (sinkCalls: LearnedSinkCall[]) => void,
): void {
  const priorConfigEnv = process.env.ANYBUFF_PROVIDER_CONFIG
  const dataDir = mkdtempSync(join(tmpdir(), 'sdk-learned-sink-'))
  const configPath = join(dataDir, 'anybuff.json')
  const sinkCalls: LearnedSinkCall[] = []
  process.env.ANYBUFF_PROVIDER_CONFIG = configPath
  setLearnedContextWindowSink((entry) => sinkCalls.push(entry))
  try {
    // A keyless openai-compatible gateway — resolvable without env vars.
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultModel: 'test-gw/gateway-model',
        providers: {
          'test-gw': {
            type: 'openai-compatible',
            // No apiKeyEnv: the provider must resolve without any env key so
            // the learning path can run in a hermetic test.
            baseURL: 'http://localhost:9/v1',
            models: ['gateway-model'],
            ...(withExplicitCapability
              ? {
                  modelCapabilities: {
                    'gateway-model': {
                      context: { windowTokens: 262_144, outputTokens: 32_768 },
                    },
                  },
                }
              : {}),
          },
        },
      }),
    )
    clearProviderConfigCacheForTest()
    scenario(sinkCalls)
  } finally {
    setLearnedContextWindowSink(null)
    clearLearnedContextWindowsForTest()
    clearProviderConfigCacheForTest()
    if (priorConfigEnv === undefined) {
      delete process.env.ANYBUFF_PROVIDER_CONFIG
    } else {
      process.env.ANYBUFF_PROVIDER_CONFIG = priorConfigEnv
    }
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      // best-effort — a locked temp dir must never fail the run
    }
  }
}

describe('learned-window durable sink (A2 write-back seam)', () => {
  it('fires the sink when an overflow text teaches a new window', () => {
    runSinkScenario(false, (sinkCalls) => {
      const decision = decideContextOverflowTrim({
        error: overflowError(
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 999999 tokens",
        ),
        messages: bigHistory,
        model: 'test-gw/gateway-model',
        alreadyTrimmed: false,
      })

      // The learned window both drives the trim decision and reaches the
      // durable sink (providerId + the routable model string the host's
      // recordProviderModelCapability accepts).
      expect(decision.trim).toBe(true)
      expect(sinkCalls).toEqual([
        { providerId: 'test-gw', model: 'test-gw/gateway-model', windowTokens: 128_000 },
      ])
    })
  })

  it('never fires when the config already declares windowTokens (explicit wins)', () => {
    runSinkScenario(true, (sinkCalls) => {
      const decision = decideContextOverflowTrim({
        error: overflowError(
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 999999 tokens",
        ),
        messages: bigHistory,
        model: 'test-gw/gateway-model',
        alreadyTrimmed: false,
      })

      // The declared 262k window stays authoritative (the decision still
      // sizes against min(learned 128k, declared 262k) per A2's adoption
      // rule) and there is no capability gap for the sink to fill.
      expect(decision.trim).toBe(true)
      expect(sinkCalls).toEqual([])
    })
  })

  it('re-learning the same window does not re-fire the sink (idempotent)', () => {
    runSinkScenario(false, (sinkCalls) => {
      // First learn: 200k → one sink call; the identical second error teaches
      // the same window → the overlay is unchanged → no second call. (The
      // overlay is wiped after every scenario, so 200k needs no coordination
      // with the 128k test above.)
      const error = overflowError(
        "This model's maximum context length is 200000 tokens. However, your messages resulted in 999999 tokens",
      )
      decideContextOverflowTrim({
        error,
        messages: bigHistory,
        model: 'test-gw/gateway-model',
        alreadyTrimmed: false,
      })
      decideContextOverflowTrim({
        error,
        messages: bigHistory,
        model: 'test-gw/gateway-model',
        alreadyTrimmed: false,
      })

      expect(sinkCalls).toHaveLength(1)
      expect(sinkCalls[0]).toEqual({
        providerId: 'test-gw',
        model: 'test-gw/gateway-model',
        windowTokens: 200_000,
      })
    })
  })
})
