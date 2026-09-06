import { describe, expect, it } from 'bun:test'

import { createHttpError } from '../../error-utils'
import { reserveTokens } from '@codebuff/common/util/context-trim'
import { decideContextOverflowTrim } from '../context-overflow-trim'

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
