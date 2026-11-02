import { countTokensMessages } from './token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

/**
 * Same size as `compact-history.ts`'s DEFAULT_TAIL_BUDGET, so a manual
 * compaction lands in the same size class as a mechanical one.
 */
export const COMPACT_TAIL_MAX_TOKENS = 10_000

/**
 * Never tail material: the per-step scaffolding the runtime re-adds anyway,
 * plus every host user turn (the `/compact` command included). User turns are
 * represented by the summary, and the tail must start on an assistant so the
 * summary is never followed by a second consecutive user-role message.
 */
const EXCLUDED_TAIL_TAGS = [
  'STEP_PROMPT',
  'INSTRUCTIONS_PROMPT',
  'USER_PROMPT',
  'SUBAGENT_SPAWN',
] as const

/**
 * Duplicated from `compact-history.ts` on purpose: importing that module would
 * couple the two compaction paths. Both markers are required, same as there —
 * the bare tag is a string a user can send.
 */
const MECHANICAL_SUMMARY_HEADER =
  'This is a summary of the conversation so far. The original messages have been condensed to save context space.'

function textOf(message: Message): string {
  const content = message.content as unknown
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<Record<string, unknown>>)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}

function isMechanicalSummary(message: Message): boolean {
  if (message.role !== 'user') return false
  const text = textOf(message)
  return (
    text.includes('<conversation_summary>') &&
    text.includes(MECHANICAL_SUMMARY_HEADER)
  )
}

function isTailCandidate(message: Message): boolean {
  if (message.role === 'system') return false
  if (
    message.tags?.some((tag) =>
      (EXCLUDED_TAIL_TAGS as readonly string[]).includes(tag),
    )
  ) {
    return false
  }
  return !isMechanicalSummary(message)
}

/**
 * Returns the verbatim slice that may follow the summary in a manual `/compact`
 * rewrite.
 *
 * - Scaffolding (step / instructions / subagent spawn), system messages, an
 *   existing mechanical summary, and every `USER_PROMPT`-tagged message are
 *   excluded — including the `/compact` command itself.
 * - An exchange is one assistant message plus the `role: 'tool'` messages that
 *   follow it. Any other message (including a user turn or a user-role
 *   TOOL_CALL_ERROR) ends the exchange, so a selection can never start on an
 *   orphan tool result.
 * - The slice therefore always starts on an assistant. The summary is
 *   user-role; a leading user message would make two consecutive user turns,
 *   which providers that require alternating roles (Anthropic) reject. The
 *   latest user request is represented by the summary, not by the tail.
 * - Exchanges are taken newest-first until `maxTokens` would be exceeded.
 * - When the newest exchange alone exceeds the budget, returns [] rather than
 *   letting the tail defeat compaction.
 */
export function keepTailForCompaction(params: {
  messages: Message[]
  maxTokens?: number
}): Message[] {
  const { messages, maxTokens = COMPACT_TAIL_MAX_TOKENS } = params
  const candidates = messages.filter(isTailCandidate)

  const exchanges: Message[][] = []
  let current: Message[] | null = null
  for (const message of candidates) {
    if (message.role === 'assistant') {
      if (current) exchanges.push(current)
      current = [message]
    } else if (message.role === 'tool' && current) {
      current.push(message)
    } else if (current) {
      exchanges.push(current)
      current = null
    }
  }
  if (current) exchanges.push(current)

  const kept: Message[][] = []
  let tokens = 0
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const exchange = exchanges[i]
    const cost = countTokensMessages(exchange)
    if (tokens + cost > maxTokens) break
    tokens += cost
    kept.unshift(exchange)
  }
  return kept.flat()
}
