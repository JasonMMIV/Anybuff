/**
 * Context-overflow trim decision (AnyBuff context-management P0 A2).
 *
 * Pure decision logic for "overflow 400 → learn the provider's real window →
 * mechanically trim the request messages → retry once on the same model".
 * Zero `ai` imports: `llm.ts` calls this from its retry loops and re-invokes
 * the same model attempt with the trimmed messages; everything here is
 * unit-testable without provider mocks.
 */

import { reserveTokens } from '@codebuff/common/util/context-trim'
import { countTokensMessages } from '@codebuff/agent-runtime/util/token-counter'
import { trimMessagesToFitTokenLimit } from '@codebuff/agent-runtime/util/messages'
import {
  isContextOverflowError,
  overflowErrorText,
  parseLearnedContextWindow,
} from '../error-utils'
import { canTrimAtRequestLayer } from './failover'
import {
  recordLearnedModelContextWindow,
  resolveModelContextWindow,
} from './model-provider'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { Logger } from '@codebuff/common/types/contracts/logger'

/** Smallest target we will ever trim a request down to (plan §4 A2 step 3). */
const MIN_TRIM_TARGET_TOKENS = 4096

export type ContextOverflowTrimDecision =
  | {
      trim: false
      reason: 'not-overflow' | 'already-trimmed' | 'no-window' | 'irreducible'
      /** The window learned from the error text, when one was parsed. */
      learnedWindowTokens?: number
    }
  | {
      trim: true
      messages: Message[]
      targetTokens: number
      windowTokens: number
      learnedWindowTokens?: number
    }

/** Compact log prefix shared with the compat rules (§2 non-negotiable #5). */
const COMPAT_LOG_PREFIX = '[anybuff-compat]'

/**
 * Decide what to do with a request that just failed with a provider error.
 *
 * - `not-overflow`: the error is not a context-overflow 400 — caller proceeds
 *   with its normal retry/failover classification.
 * - `already-trimmed`: this model attempt already consumed its one trim retry.
 * - `no-window`: neither config nor the error text yields a usable window —
 *   the host's overflow-resume loop (P0 A4) owns this case.
 * - `irreducible`: the keep-during-truncation core already exceeds the target;
 *   trimming cannot help — failover (A3) or the host loop takes over.
 * - `trim`: retry the SAME model once with the returned trimmed messages.
 *
 * Learning (A2 step 4): when the error text discloses the provider's real
 * window, it is recorded via the in-memory overlay (explicit config windows
 * always win) and attached to the decision.
 */
export function decideContextOverflowTrim(params: {
  error: unknown
  /** Full request messages (system-first when applicable). */
  messages: Message[]
  /** Routable model string actually being attempted. */
  model: string
  /** True when this model attempt already used its one trim retry. */
  alreadyTrimmed: boolean
  /** Optional local estimate of the full rejected request; falls back to
   *  `countTokensMessages(messages)`. */
  requestTokenEstimate?: number
  logger?: Logger
}): ContextOverflowTrimDecision {
  const { error, messages, model, alreadyTrimmed } = params
  if (alreadyTrimmed) {
    return { trim: false, reason: 'already-trimmed' }
  }
  if (!isContextOverflowError(error)) {
    return { trim: false, reason: 'not-overflow' }
  }

  const errorText = overflowErrorText(error)
  const estimate =
    params.requestTokenEstimate ?? countTokensMessages(messages)
  const learned = parseLearnedContextWindow(errorText, estimate)
  if (learned !== undefined) {
    recordLearnedModelContextWindow(model, learned)
  }

  const declared = resolveModelContextWindow({ model })
  const windowTokens =
    learned !== undefined
      ? Math.min(learned, declared ?? learned)
      : declared
  if (windowTokens === undefined) {
    logDecision(params.logger, model, 'no-window', {
      learnedWindowTokens: learned,
    })
    return { trim: false, reason: 'no-window', learnedWindowTokens: learned }
  }

  const targetTokens = Math.max(
    MIN_TRIM_TARGET_TOKENS,
    windowTokens - reserveTokens(windowTokens),
  )

  if (!canTrimAtRequestLayer({ messages, targetTokens })) {
    logDecision(params.logger, model, 'irreducible', {
      windowTokens,
      targetTokens,
      learnedWindowTokens: learned,
    })
    return {
      trim: false,
      reason: 'irreducible',
      learnedWindowTokens: learned,
    }
  }

  const trimmed = trimMessagesToFitTokenLimit({
    messages,
    systemTokens: 0,
    maxTotalTokens: targetTokens,
    logger: params.logger ?? fallbackLogger,
  })
  if (countTokensMessages(trimmed) >= countTokensMessages(messages)) {
    // Nothing was actually dropped — same story as irreducible.
    logDecision(params.logger, model, 'irreducible', {
      windowTokens,
      targetTokens,
      learnedWindowTokens: learned,
    })
    return {
      trim: false,
      reason: 'irreducible',
      learnedWindowTokens: learned,
    }
  }

  logDecision(params.logger, model, 'trim', {
    windowTokens,
    targetTokens,
    learnedWindowTokens: learned,
    beforeTokens: estimate,
    afterTokens: countTokensMessages(trimmed),
  })
  return {
    trim: true,
    messages: trimmed,
    targetTokens,
    windowTokens,
    ...(learned !== undefined && { learnedWindowTokens: learned }),
  }
}

function logDecision(
  logger: Logger | undefined,
  model: string,
  action: string,
  detail: Record<string, unknown>,
): void {
  const line = `${COMPAT_LOG_PREFIX} context-overflow-trim ${action}: model=${model}`
  if (logger) {
    logger.info({ model, action, ...detail }, line)
  } else {
    console.info(`${line} ${JSON.stringify(detail)}`)
  }
}

/** Minimal no-op Logger for callers that pass none (keeps the pure module
 *  free of logger-construction dependencies). */
const fallbackLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
