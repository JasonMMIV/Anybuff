import { describe, expect, it } from 'bun:test'

import { createHttpError } from '../../error-utils'
import {
  canTrimAtRequestLayer,
  isFailoverEligibleError,
  resolveModelsToTry,
} from '../failover'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

function userMsg(text: string, extra: Partial<Message> = {}): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    sentAt: 1,
    ...extra,
  } as Message
}

describe('isFailoverEligibleError', () => {
  it('context-overflow 400 is the 4th failover class (P0 A3)', () => {
    const error = createHttpError(
      "This model's maximum context length is 128000 tokens",
      400,
    )
    expect(isFailoverEligibleError(error)).toBe(true)
  })

  it('plain 400 stays non-failover-eligible', () => {
    expect(isFailoverEligibleError(createHttpError('invalid request: bad param', 400))).toBe(false)
  })

  it('429 rate limit stays retry-only', () => {
    expect(isFailoverEligibleError(createHttpError('rate limit exceeded', 429))).toBe(false)
  })

  it('existing classes keep their behavior', () => {
    expect(isFailoverEligibleError(createHttpError('unauthorized', 401))).toBe(true)
    expect(isFailoverEligibleError(createHttpError('forbidden', 403))).toBe(true)
    expect(isFailoverEligibleError(createHttpError('server error', 503))).toBe(true)
    expect(isFailoverEligibleError(new Error('plain error'))).toBe(false)
  })
})

describe('canTrimAtRequestLayer', () => {
  it('true when removable tokens exist above the target', () => {
    const messages = [
      userMsg('old message one'.repeat(200)),
      userMsg('old message two'.repeat(200)),
      userMsg('recent live prompt'),
    ]
    expect(canTrimAtRequestLayer({ messages, targetTokens: 500 })).toBe(true)
  })

  it('false when the history already fits the target', () => {
    const messages = [userMsg('short history')]
    expect(canTrimAtRequestLayer({ messages, targetTokens: 10_000 })).toBe(false)
  })

  it('false when keep-during-truncation core alone exceeds the target', () => {
    const messages = [
      userMsg('irreducible system-anchored content'.repeat(200), {
        keepDuringTruncation: true,
      }),
    ]
    expect(canTrimAtRequestLayer({ messages, targetTokens: 500 })).toBe(false)
  })

  it('empty history is never trimmable', () => {
    expect(canTrimAtRequestLayer({ messages: [], targetTokens: 1_000 })).toBe(false)
  })
})

describe('resolveModelsToTry (regression)', () => {
  it('primary only when no failover models are configured', () => {
    expect(resolveModelsToTry('provider/model', undefined)).toEqual(['provider/model'])
  })
})
