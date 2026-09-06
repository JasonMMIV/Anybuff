/**
 * SDK Error Utilities
 *
 * Simple utilities for error handling based on HTTP status codes.
 * Uses the AI SDK's error types which include statusCode property.
 */

/**
 * Error type with statusCode property
 */
export type HttpError = Error & { statusCode: number }

export const PROVIDER_CONTENT_POLICY_ERROR_CODE = 'provider_content_policy'

export type ProviderContentPolicyError = Error & {
  code: typeof PROVIDER_CONTENT_POLICY_ERROR_CODE
  finishReason?: 'content-filter'
  statusCode?: number
}

/**
 * HTTP status codes that should trigger automatic retry
 */
export const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

// ============================================================================
// Error Factory Functions
// ============================================================================

/**
 * Creates an Error with a statusCode property
 */
export function createHttpError(message: string, statusCode: number): HttpError {
  const error = new Error(message) as HttpError
  error.statusCode = statusCode
  return error
}

export function createProviderContentPolicyError(
  params: {
    message?: string
    finishReason?: 'content-filter'
    statusCode?: number
    cause?: unknown
  } = {},
): ProviderContentPolicyError {
  const error = new Error(
    params.message ?? 'Provider blocked this request under its content policy',
    params.cause !== undefined ? { cause: params.cause } : undefined,
  ) as ProviderContentPolicyError
  error.name = 'ProviderContentPolicyError'
  error.code = PROVIDER_CONTENT_POLICY_ERROR_CODE
  if (params.finishReason !== undefined) {
    error.finishReason = params.finishReason
  }
  if (params.statusCode !== undefined) {
    error.statusCode = params.statusCode
  }
  return error
}

export function getProviderContentPolicyFinishError(params: {
  finishReason: string | undefined
  model: string
  responseLabel?: string
}): ProviderContentPolicyError | undefined {
  if (params.finishReason !== 'content-filter') return undefined

  return createProviderContentPolicyError({
    finishReason: 'content-filter',
    message: `Provider blocked the ${params.responseLabel ?? 'response'} for model '${params.model}' under its content policy`,
  })
}

export function isProviderContentPolicyError(
  error: unknown,
): error is ProviderContentPolicyError {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === PROVIDER_CONTENT_POLICY_ERROR_CODE
  )
}

// ============================================================================
// Context-overflow classification (AnyBuff context-management P0 A1)
// ============================================================================

/**
 * Conservative context-overflow markers (plan §4 A1). Case-insensitive; kept
 * as exported patterns so the sdk barrel can expose the single source of
 * truth that host-core's string-only `classifyFailure` reuses.
 */
export const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /context_length_exceeded/i,
  /maximum context length/i,
  /prompt is too long|input is too long|too many (input )?tokens/i,
  /reduce[^\n]*the length|exceeds (the )?(context|maximum)/i,
]

/**
 * Pure text matcher (no status-code gate) — shared by the error classifier
 * below and host-core's `classifyFailure`, which only sees the message text.
 */
export function isContextOverflowMessage(text: string): boolean {
  if (!text) return false
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Join the message-bearing fields of an unknown error into one text blob the
 * overflow matcher (and the window parser) can scan.
 */
export function overflowErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  }
  const value = error as {
    message?: unknown
    responseBody?: unknown
    data?: unknown
  }
  return [value.message, value.responseBody, value.data]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
}

/**
 * True when the error is an HTTP 400 whose message/body carries a
 * context-overflow marker (AnyBuff P0 A1). Overflow is its own failure class:
 * it is not retryable (same request would fail identically) and only becomes
 * failover-eligible when trimming the request cannot fix it.
 */
export function isContextOverflowError(error: unknown): boolean {
  if (getErrorStatusCode(error) !== 400) return false
  return isContextOverflowMessage(overflowErrorText(error))
}

/**
 * Best-effort floor/ceiling guards for a learned context window parsed from
 * an overflow message. Real model windows live in the 4k–32M band; anything
 * outside it is noise (timestamps, request ids, pricing figures).
 */
const LEARNED_WINDOW_MIN_TOKENS = 4_000
const LEARNED_WINDOW_MAX_TOKENS = 32_000_000
/** A parsed window can only be trusted up to 20% above the local estimate —
 *  tokenizer variance never reaches that high. */
const LEARNED_WINDOW_ESTIMATE_TOLERANCE = 1.2

/**
 * Parse the provider's real context-window token count out of an overflow
 * message (plan §4 A2 step 1). Providers word these wildly differently
 * (`maximum context length is 128000 tokens`, `prompt is too long: 123456
 * tokens > 100000 maximum`, …), so we scan for integers near context-related
 * keywords and deliberately take the SMALLER plausible side: the window is
 * the number the request must fit under, and request-token counts (the larger
 * number in "X > Y" phrasings) must never be mistaken for it.
 *
 * Returns undefined when nothing in-range can be trusted.
 */
export function parseLearnedContextWindow(
  message: string,
  requestLocalTokenEstimate: number,
): number | undefined {
  if (!message || requestLocalTokenEstimate <= 0) return undefined
  const lower = message.toLowerCase()

  const candidates: number[] = []
  // Numeric runs of at least 4 digits (optionally comma-separated) — shorter
  // numbers are overwhelmingly ids/versions, not token counts.
  const numberPattern = /(\d[\d,]{3,})/g
  let match: RegExpExecArray | null
  while ((match = numberPattern.exec(lower)) !== null) {
    const raw = match[1].replace(/,/g, '')
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    // Only trust integers near context-related keywords (window of ±60
    // chars) — ids, versions and pricing figures must never leak in.
    const start = Math.max(0, match.index - 60)
    const end = Math.min(lower.length, match.index + raw.length + 60)
    const context = lower.slice(start, end)
    if (!/(context|maximum|limit|tokens?|length|window)/.test(context)) {
      continue
    }
    candidates.push(value)
  }

  // Prefer the smaller plausible side per the "X > Y maximum" phrasing, where
  // Y (the window) is the ceiling the request must fit under.
  const plausible = candidates.filter(
    (value) =>
      value >= LEARNED_WINDOW_MIN_TOKENS &&
      value < LEARNED_WINDOW_MAX_TOKENS &&
      value <= requestLocalTokenEstimate * LEARNED_WINDOW_ESTIMATE_TOLERANCE,
  )
  return plausible.length > 0 ? Math.min(...plausible) : undefined
}

/**
 * Detect explicit provider moderation/policy wording without classifying every
 * client-side 400 as a content block. This is intentionally conservative.
 */
export function isProviderContentPolicyResponse(error: unknown): boolean {
  if (isProviderContentPolicyError(error)) return true
  if (!error || typeof error !== 'object') return false

  const value = error as {
    message?: unknown
    responseBody?: unknown
    data?: unknown
  }
  const text = [value.message, value.responseBody, value.data]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase()

  return [
    'content_filter',
    'content-filter',
    'content policy',
    'content_policy',
    'content blocked',
    'prompt blocked',
    'safety filter',
    'moderation blocked',
  ].some((marker) => text.includes(marker))
}

export function normalizeProviderContentPolicyError(
  error: unknown,
): ProviderContentPolicyError | undefined {
  if (!isProviderContentPolicyResponse(error)) return undefined
  if (isProviderContentPolicyError(error)) return error

  const statusCode = getErrorStatusCode(error)
  return createProviderContentPolicyError({
    statusCode,
    cause: error,
    message:
      error instanceof Error
        ? error.message
        : 'Provider blocked this request under its content policy',
  })
}

/**
 * Creates an authentication error (401)
 */
export function createAuthError(message = 'Authentication failed'): HttpError {
  return createHttpError(message, 401)
}

/**
 * Creates a forbidden error (403)
 */
export function createForbiddenError(message = 'Access forbidden'): HttpError {
  return createHttpError(message, 403)
}

/**
 * Creates a payment required error (402)
 */
export function createPaymentRequiredError(message = 'Payment required'): HttpError {
  return createHttpError(message, 402)
}

/**
 * Creates a server error (500 by default, or custom 5xx)
 */
export function createServerError(message = 'Server error', statusCode = 500): HttpError {
  return createHttpError(message, statusCode)
}

/**
 * Creates a network error (503 - service unavailable)
 * Used for connection failures, DNS errors, timeouts, etc.
 */
export function createNetworkError(message = 'Network error'): HttpError {
  return createHttpError(message, 503)
}

/**
 * Checks if an HTTP status code is retryable
 */
export function isRetryableStatusCode(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return false
  return RETRYABLE_STATUS_CODES.has(statusCode)
}

/**
 * Extracts the statusCode from an error if available.
 * Checks both 'statusCode' (our convention) and 'status' (AI SDK's APICallError convention).
 */
export function getErrorStatusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    // Check 'statusCode' first (our convention)
    if ('statusCode' in error) {
      const statusCode = (error as { statusCode: unknown }).statusCode
      if (typeof statusCode === 'number') {
        return statusCode
      }
    }
    // Check 'status' (AI SDK's APICallError uses this)
    if ('status' in error) {
      const status = (error as { status: unknown }).status
      if (typeof status === 'number') {
        return status
      }
    }
  }
  return undefined
}

/**
 * Sanitizes error messages for display
 * Removes sensitive information and formats for user consumption
 */
export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string') {
      return message
    }
  }
  return String(error)
}
