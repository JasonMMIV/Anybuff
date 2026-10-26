import { renderSubagentToolMessage } from './render-subagent-output'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

/**
 * How a child agent's inherited history is narrowed at the spawn boundary.
 *
 * - `review-context`: a reviewer should judge the work, not the author's
 *   internal monologue. Drop assistant `reasoning` parts; keep every visible
 *   `text` part, every tool call, and every tool result. Subagent outputs are
 *   additionally rendered into readable edits (ADR-35), because a reviewer's
 *   only record of a subagent's work is its `AgentOutput` in this history.
 */
export type MessageHistoryFilter = 'review-context'

/**
 * Curate an inherited message history for review. Pure: the input messages and
 * array are never mutated, so the parent line keeps its own reasoning (ADR-26
 * governs the parent line, not this child-side curation).
 *
 * Only `reasoning` parts are removed. Visible assistant text, tool calls and
 * tool results are passed through untouched — the reviewer still sees what the
 * author did and what the author said, just not the author's private thinking.
 * A turn that contained nothing but reasoning drops entirely, because an empty
 * assistant content array is a wire hazard.
 *
 * The final contiguous assistant run is replayed verbatim. The wire layer
 * merges adjacent assistant messages into one, and the latest turn's thinking
 * blocks must be replayed unmodified (Claude 400s otherwise — the same boundary
 * semantics as `splitTail`'s ADR-26 guard).
 *
 * Subagent tool results are rendered only for `review-context`: the reviewer is
 * a leaf with no tools, so a nested `AgentOutput` it cannot parse is an edit it
 * cannot review. The renderer is fail-open — unrecognised shapes stay as-is.
 */
export function filterInheritedHistory(params: {
  messages: Message[]
  filter: MessageHistoryFilter
  logger: Logger
}): Message[] {
  const { messages, filter, logger } = params

  if (messages.length === 0) {
    return []
  }

  let lastRunStart = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    lastRunStart = i
    while (lastRunStart > 0 && messages[lastRunStart - 1].role === 'assistant') {
      lastRunStart--
    }
    break
  }

  let changed = false
  const filtered = messages.flatMap((message, index) => {
    if (
      message.role !== 'assistant' ||
      !Array.isArray(message.content) ||
      index >= lastRunStart
    ) {
      return [message]
    }

    const content = message.content.filter((part) => part.type !== 'reasoning')

    if (content.length === message.content.length) {
      return [message]
    }
    changed = true
    if (content.length === 0) {
      return []
    }
    return [{ ...message, content }]
  })

  if (changed) {
    logger.debug(
      {
        messagesBefore: messages.length,
        messagesAfter: filtered.length,
      },
      'Curated inherited message history for review',
    )
  }

  if (filter !== 'review-context') {
    return filtered
  }

  let rendered = 0
  const withRenderedEdits = filtered.map((message) => {
    const next = renderSubagentToolMessage({ message })
    if (next !== message) {
      rendered++
    }
    return next
  })

  if (rendered > 0) {
    logger.debug(
      { renderedToolResults: rendered },
      'Rendered subagent edits for review',
    )
  }

  return withRenderedEdits
}
