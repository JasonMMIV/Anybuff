import { describe, expect, it } from 'bun:test'

import {
  CONTEXT_OVERFLOW_PATTERNS,
  createHttpError,
  isContextOverflowError,
  isContextOverflowMessage,
  overflowErrorText,
  parseLearnedContextWindow,
} from '../error-utils'

function overflowError(
  message: string,
  statusCode = 400,
): Error & Record<string, unknown> {
  const error = createHttpError(message, statusCode)
  return error as unknown as Error & Record<string, unknown>
}

describe('isContextOverflowMessage', () => {
  it('matches the canonical provider phrasings', () => {
    expect(isContextOverflowMessage("This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens")).toBe(true)
    expect(isContextOverflowMessage('prompt is too long: 123456 tokens > 100000 maximum')).toBe(true)
    expect(isContextOverflowMessage('context_length_exceeded')).toBe(true)
    expect(isContextOverflowMessage('input is too long — please reduce the length of the messages')).toBe(true)
    expect(isContextOverflowMessage('Request exceeds the context window')).toBe(true)
    expect(isContextOverflowMessage('too many input tokens')).toBe(true)
  })

  it('does not match unrelated failures', () => {
    expect(isContextOverflowMessage('invalid request: bad param value')).toBe(false)
    expect(isContextOverflowMessage('rate limit exceeded, try again later')).toBe(false)
    expect(isContextOverflowMessage('unauthorized: invalid api key')).toBe(false)
    expect(isContextOverflowMessage('')).toBe(false)
  })
})

describe('isContextOverflowError', () => {
  it('status 400 + overflow text → true', () => {
    expect(isContextOverflowError(overflowError("This model's maximum context length is 128000 tokens"))).toBe(true)
    expect(isContextOverflowError(overflowError('prompt is too long: 123456 tokens > 100000 maximum'))).toBe(true)
    expect(isContextOverflowError(overflowError('context_length_exceeded'))).toBe(true)
    expect(isContextOverflowError(overflowError('Please reduce the length of the messages.'))).toBe(true)
  })

  it('non-400 statuses never classify as overflow', () => {
    expect(isContextOverflowError(overflowError('rate limit — maximum requests per minute exceeded', 429))).toBe(false)
    expect(isContextOverflowError(overflowError('maximum context length is 128000', 500))).toBe(false)
  })

  it('400 without overflow wording stays a plain 400', () => {
    expect(isContextOverflowError(overflowError('invalid request: bad param'))).toBe(false)
  })

  it('generic Error with no statusCode never classifies as overflow', () => {
    expect(isContextOverflowError(new Error("This model's maximum context length is 128000 tokens"))).toBe(false)
  })

  it('extracts overflow text from responseBody when message is silent', () => {
    const error = overflowError('Bad Request')
    error.responseBody = '{"error":{"message":"This model\'s maximum context length is 128000 tokens"}}'
    expect(isContextOverflowError(error)).toBe(true)
  })

  it('non-object inputs return false', () => {
    expect(isContextOverflowError(undefined)).toBe(false)
    expect(isContextOverflowError('maximum context length')).toBe(false)
    expect(isContextOverflowError(null)).toBe(false)
  })
})

describe('overflowErrorText', () => {
  it('joins message, responseBody and data', () => {
    const error = {
      message: 'maximum context length',
      responseBody: 'prompt is too long',
      data: undefined,
    }
    expect(overflowErrorText(error)).toBe('maximum context length\nprompt is too long')
  })

  it('falls back to Error.message and plain strings', () => {
    expect(overflowErrorText(new Error('oops'))).toBe('oops')
    expect(overflowErrorText('plain string')).toBe('plain string')
    expect(overflowErrorText(42)).toBe('')
  })
})

describe('parseLearnedContextWindow', () => {
  it('parses the window from "maximum context length" phrasings', () => {
    expect(
      parseLearnedContextWindow(
        "This model's maximum context length is 524287 tokens. However your messages resulted in 1000000 tokens",
        600_000,
      ),
    ).toBe(524_287)
  })

  it('prefers the smaller side of "X > Y maximum"', () => {
    expect(
      parseLearnedContextWindow('prompt is too long: 123456 tokens > 100000 maximum', 200_000),
    ).toBe(100_000)
  })

  it('rejects a parsed window far above the local estimate (1.2x guard)', () => {
    // 100000 would be 1.67x of the 60k estimate — tokenizer variance never reaches that.
    expect(
      parseLearnedContextWindow('prompt is too long: 123456 tokens > 100000 maximum', 60_000),
    ).toBeUndefined()
  })

  it('returns undefined with no parseable number', () => {
    expect(parseLearnedContextWindow('context_length_exceeded', 100_000)).toBeUndefined()
  })

  it('rejects gigantic numbers (32M ceiling guard)', () => {
    expect(
      parseLearnedContextWindow('request id 1735689600000 exceeds the maximum context length', 1_000_000),
    ).toBeUndefined()
  })

  it('rejects tiny numbers (4k floor guard)', () => {
    expect(
      parseLearnedContextWindow('maximum context length is 512 tokens', 100_000),
    ).toBeUndefined()
  })

  it('ignores numbers without context keywords nearby', () => {
    expect(
      parseLearnedContextWindow('billing period 128000 usd; your request failed', 200_000),
    ).toBeUndefined()
  })

  it('degenerate inputs return undefined', () => {
    expect(parseLearnedContextWindow('', 100_000)).toBeUndefined()
    expect(parseLearnedContextWindow('maximum context length is 128000', 0)).toBeUndefined()
    expect(parseLearnedContextWindow('maximum context length is 128000', -5)).toBeUndefined()
  })
})

describe('CONTEXT_OVERFLOW_PATTERNS', () => {
  it('is a non-empty exported pattern list (single source of truth)', () => {
    expect(CONTEXT_OVERFLOW_PATTERNS.length).toBeGreaterThan(0)
    expect(CONTEXT_OVERFLOW_PATTERNS.every((p) => p instanceof RegExp)).toBe(true)
  })
})
