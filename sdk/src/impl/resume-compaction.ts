/**
 * Resume compaction helper (AnyBuff context-management P0 A4).
 *
 * Mechanical (zero-LLM) compaction of a previous run's messageHistory before
 * resuming after a context-overflow failure. Runs the same deterministic
 * summarizer the agent loop uses (`compactMessages`); only fires when the
 * history actually exceeds `maxTokens`; never calls a model.
 */

import { compactMessages } from '@codebuff/agent-runtime/compact-history'
import { countTokensMessages } from '@codebuff/agent-runtime/util/token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

export type ResumeCompactionResult = {
  messages: Message[]
  compacted: boolean
  estimatedTokens: number
}

/** Compact log prefix shared with the compat rules (§2 non-negotiable #5). */
const COMPAT_LOG_PREFIX = '[anybuff-compat]'

/**
 * Compact a resumable history down toward `maxTokens` (the halving target
 * `trigger(W) × 0.5^(k-1)` computed by the host). Returns the original
 * messages untouched when they already fit or when compaction cannot shrink
 * them further; the caller decides whether that is terminal (P0 A4 k-cap).
 */
export function compactMessagesForResume(params: {
  messages: Message[]
  /** Target token ceiling for the compacted history. */
  maxTokens: number
  logger?: { warn: (obj: unknown, msg: string) => void }
}): ResumeCompactionResult {
  const { messages } = params
  const beforeTokens = countTokensMessages(messages)
  if (beforeTokens <= params.maxTokens) {
    return { messages, compacted: false, estimatedTokens: beforeTokens }
  }

  const { messages: compacted } = compactMessages({ messages })
  const afterTokens = countTokensMessages(compacted)

  try {
    console.info(
      `${COMPAT_LOG_PREFIX} resume-compaction: history ${beforeTokens} → ${afterTokens} tokens (target ${params.maxTokens})`,
    )
  } catch {
    // Logging must never block the compaction itself.
  }

  if (afterTokens >= beforeTokens) {
    // Compaction could not shrink this history — surface it so the caller can
    // treat the resume as terminal instead of looping.
    params.logger?.warn(
      { beforeTokens, afterTokens, maxTokens: params.maxTokens },
      'Resume compaction could not shrink the history below the target',
    )
    return { messages, compacted: false, estimatedTokens: beforeTokens }
  }

  return { messages: compacted, compacted: true, estimatedTokens: afterTokens }
}
