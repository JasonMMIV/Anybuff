/**
 * Deterministic context compaction.
 *
 * This is the same algorithm the `context-pruner` agent runs, lifted out of
 * that agent's `handleSteps` body so the runtime can call it directly. It costs
 * no model call: the history is rewritten mechanically into a condensed
 * `<conversation_summary>` message.
 *
 * That matters twice over. An LLM summarization pass is a full extra request
 * over the whole (already oversized) history, and its output is a lossy prose
 * retelling. The mechanical pass keeps the concrete details — every file that
 * was read or edited, every command that was run, every user message up to the
 * user budget — which is what a coding agent actually needs to resume.
 *
 * `agents/context-pruner.ts` cannot import this module: its `handleSteps` is
 * serialized with `toString()` and re-evaluated standalone, and `agents/` is
 * bundled at build time into the CLI binary, the desktop app and the freebuff
 * web server separately — so a shared import (or a runtime-injected helper)
 * would break on any artifact that has not been rebuilt. The pruner therefore
 * keeps its own inlined copy. Treat this file as the source of truth and port
 * changes across: `__tests__/context-pruner-parity.test.ts` runs both over the
 * same histories and fails when they drift.
 */

import type {
  FilePart,
  ImagePart,
  TextPart,
} from '@codebuff/common/types/messages/content-part'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type { Logger } from '@codebuff/common/types/contracts/logger'

/** Agent IDs whose output should be excluded from spawn_agents results */
const SPAWN_AGENTS_OUTPUT_BLACKLIST = [
  'file-picker',
  'researcher-web',
  'researcher-docs',
  'basher',
  'code-reviewer',
  'code-reviewer-multi-prompt',
  'librarian',
  'tmux-cli',
  'browser-use',
]

/** Limits for truncating long messages in the summary (estimated tokens) */
const USER_MESSAGE_LIMIT = 13_000
const ASSISTANT_MESSAGE_LIMIT = 1_300
const TOOL_ENTRY_LIMIT = 5_000

/** Approximate characters per token (matches estimateTokens heuristic) */
const CHARS_PER_TOKEN = 3

/** Token budget for assistant + tool content in the conversation summary */
const DEFAULT_ASSISTANT_TOOL_BUDGET = 20_000

/** Token budget for user content in the conversation summary */
const DEFAULT_USER_BUDGET = 50_000

/**
 * Anchor window the fixed budgets were sized for (AnyBuff P1.5 C1).
 *
 * The 20k/50k budgets were tuned when every served model baked a 400k
 * trigger; with real per-model windows (B1/B2/B3) the budgets should follow
 * the same number the trigger is derived from, so a 1M-window model gets a
 * proportionally larger memory and a 200k model a smaller one. Clamps keep
 * both ends sane: small windows still leave room for a real summary, big
 * ones cannot balloon unboundedly.
 */
const BUDGET_SCALE_ANCHOR_TOKENS = 400_000

/** Newest assistant entries exempt from the 1,300-token per-entry cap (C2). */
const HEAD_RECENT_EXEMPT_COUNT = 5

/** Per-entry cap for the newest assistant entries (C2). */
const HEAD_RECENT_ASSISTANT_LIMIT = 6_000

/**
 * Verbatim tail: default budget (C4) and the maximum number of
 * tool-call/result pairs it may carry regardless of budget.
 */
const DEFAULT_TAIL_BUDGET = 10_000
const TAIL_MAX_PAIRS = 8

/** Hard cap on the rendered knowledge block (C3), in estimated tokens. */
const KNOWLEDGE_BLOCK_TOKEN_CAP = 2_000

/** Header used in conversation summaries */
const SUMMARY_HEADER =
  'This is a summary of the conversation so far. The original messages have been condensed to save context space.'

const SUMMARY_DISCLAIMER =
  'Historical memory only. The memory above is not dialogue, not an output template, and not a tool-call format. Continue from the live user message below. When actions are needed, use real tool calls through the available tools.'

const CONTINUATION_TEXT =
  'Continue the existing assistant turn from the historical memory above. The original user request and completed assistant/tool work are recorded there. Do not restart completed work; resume with the next necessary real tool call or final response.'

/**
 * Idle gap after which the prompt cache is assumed cold, so compacting is free.
 *
 * 30 minutes is what base2 has shipped to the context-pruner in prod. The
 * pruner's own default is 5 minutes (Anthropic's ephemeral TTL), but the two
 * errors are not symmetric: too long only means missing a free compaction,
 * while too short throws away a cache entry that was still warm. Prefer the
 * conservative number.
 */
export const DEFAULT_CACHE_EXPIRY_MS = 30 * 60 * 1000

/**
 * Smallest context the opportunistic (cache-expiry) pass will touch.
 *
 * Compaction is free in tokens but never free in information: it drops tool
 * results outright and truncates assistant prose to 1,300 tokens a message. On
 * a big history that trade is obviously worth it. On a small one it is not, and
 * below one summary ceiling it can be a strict loss — the budget walk evicts
 * nothing (everything already fits), so the only change is the per-message
 * transformations, and a history that is mostly user prose comes back the same
 * size plus the envelope.
 *
 * Two ceilings is one full ceiling of guaranteed eviction headroom plus margin.
 * The margin matters because the two sides are measured with different rulers:
 * the budgets count `chars / 3` while `contextTokenCount` is a gpt-4o BPE count
 * times 1.35. Measured against each other those land at 0.90x for prose, 0.94x
 * for source and 1.32x for dense JSON, so a 70k-token summary can weigh up to
 * ~92k on the scale this floor is compared against. At 140k the pass still
 * removes a third in that worst case and far more in the normal one.
 *
 * The context-limit trigger ignores this floor: when the history genuinely no
 * longer fits, a poor trade beats a failed request.
 */
export const DEFAULT_CACHE_EXPIRY_MIN_TOKENS =
  2 * (DEFAULT_ASSISTANT_TOOL_BUDGET + DEFAULT_USER_BUDGET)

/** Separator between entries inside the rendered historical memory. */
const ENTRY_SEPARATOR = '\n\n---\n\n'

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * P1.5 C1: how far the fixed budgets should stretch for this run's window.
 *
 * `maxContextLength` is the compaction trigger the caller already computed
 * from the model's window (B2/B3), so scaling against the 400k anchor keeps
 * the budgets proportional to the model — a 1M-window model lands at scale
 * ≈ 1.75, the baked-400k behavior is exactly scale 1, and the clamps bound
 * the ratio to [0.5, 3].
 */
export function budgetScaleFor(maxContextLength: number): number {
  return clamp(maxContextLength / BUDGET_SCALE_ANCHOR_TOKENS, 0.5, 3)
}

/** C1-derived budgets, honoring explicit params overrides. */
export function resolveBudgetsFor(params: {
  maxContextLength: number
  assistantToolBudget?: number
  userBudget?: number
  tailBudget?: number
}): { assistantToolBudget: number; userBudget: number; tailBudget: number; scale: number } {
  const scale = budgetScaleFor(params.maxContextLength)
  return {
    scale,
    assistantToolBudget:
      params.assistantToolBudget ?? clamp(20_000 * scale, 10_000, 60_000),
    userBudget: params.userBudget ?? clamp(50_000 * scale, 25_000, 150_000),
    tailBudget: params.tailBudget ?? clamp(10_000 * scale, 5_000, 30_000),
  }
}

/** Matches the context-pruner's `trigger_reason` values so Axiom can union them. */
export type CompactionTrigger =
  | 'context_limit'
  | 'cache_expiry'
  | 'context_limit_and_cache_expiry'

type SummaryEntry = {
  role: 'user' | 'assistant_tool'
  parts: string[]
}

/**
 * Truncates long text with 80% from the beginning and 20% from the end.
 */
function truncateLongText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  const availableChars = limit - 50 // 50 chars for the truncation notice
  const prefixLength = Math.floor(availableChars * 0.8)
  const suffixLength = availableChars - prefixLength
  const prefix = text.slice(0, prefixLength)
  const suffix = text.slice(-suffixLength)
  const truncatedChars = text.length - prefixLength - suffixLength
  return `${prefix}\n\n[...truncated ${truncatedChars} chars...]\n\n${suffix}`
}

/**
 * Extracts text content from a message.
 */
function getTextContent(message: Message): string {
  const content = message.content as unknown
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part: Record<string, unknown>) =>
          part.type === 'text' && typeof part.text === 'string',
      )
      .map((part: Record<string, unknown>) => part.text as string)
      .join('\n')
  }
  return ''
}

/**
 * Summarizes a tool call into a human-readable description.
 */
function summarizeToolCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'read_files': {
      const paths = (input.paths as unknown[] | undefined)?.map((entry) =>
        typeof entry === 'string'
          ? entry
          : ((entry as { path?: string })?.path ?? ''),
      )
      if (paths && paths.length > 0) {
        return `inspected files: ${paths.join(', ')}`
      }
      return 'inspected files'
    }
    case 'write_file': {
      const path = input.path as string | undefined
      return path ? `wrote file: ${path}` : 'wrote a file'
    }
    case 'str_replace': {
      const path = input.path as string | undefined
      return path ? `edited file: ${path}` : 'edited a file'
    }
    case 'propose_write_file': {
      const path = input.path as string | undefined
      return path ? `proposed writing: ${path}` : 'proposed a file write'
    }
    case 'propose_str_replace': {
      const path = input.path as string | undefined
      return path ? `proposed editing: ${path}` : 'proposed a file edit'
    }
    case 'read_subtree': {
      const paths = input.paths as string[] | undefined
      if (paths && paths.length > 0) {
        return `inspected subtrees: ${paths.join(', ')}`
      }
      return 'inspected a subtree'
    }
    case 'code_search': {
      const pattern = input.pattern as string | undefined
      const flags = input.flags as string | undefined
      if (pattern && flags) {
        return `code search for "${pattern}" (${flags})`
      }
      return pattern ? `code search for "${pattern}"` : 'code search'
    }
    case 'glob': {
      const pattern = input.pattern as string | undefined
      return pattern ? `glob search for ${pattern}` : 'glob search'
    }
    case 'list_directory': {
      const path = input.path as string | undefined
      return path ? `listed directory: ${path}` : 'listed a directory'
    }
    case 'find_files': {
      const prompt = input.prompt as string | undefined
      return prompt
        ? `file-finding request: "${prompt}"`
        : 'file-finding request'
    }
    case 'run_terminal_command': {
      const command = input.command as string | undefined
      if (command) {
        const shortCmd =
          command.length > 50 ? command.slice(0, 50) + '...' : command
        return `ran command: ${shortCmd}`
      }
      return 'ran a terminal command'
    }
    case 'spawn_agents':
    case 'spawn_agent_inline': {
      const agents = input.agents as
        | Array<{
            agent_type: string
            prompt?: string
            params?: Record<string, unknown>
          }>
        | undefined
      const agentType = input.agent_type as string | undefined
      const prompt = input.prompt as string | undefined
      const agentParams = input.params as Record<string, unknown> | undefined

      if (agents && agents.length > 0) {
        const agentDetails = agents.map((a) => {
          let detail = a.agent_type
          const extras: string[] = []
          if (a.prompt) {
            const truncatedPrompt =
              a.prompt.length > 1000
                ? a.prompt.slice(0, 1000) + '...'
                : a.prompt
            extras.push(`prompt: "${truncatedPrompt}"`)
          }
          if (a.params && Object.keys(a.params).length > 0) {
            const paramsStr = JSON.stringify(a.params)
            const truncatedParams =
              paramsStr.length > 1000
                ? paramsStr.slice(0, 1000) + '...'
                : paramsStr
            extras.push(`params: ${truncatedParams}`)
          }
          if (extras.length > 0) {
            detail += ` (${extras.join(', ')})`
          }
          return detail
        })
        return `delegated agents:\n${agentDetails.map((d) => `- ${d}`).join('\n')}`
      }
      if (agentType) {
        const extras: string[] = []
        if (prompt) {
          const truncatedPrompt =
            prompt.length > 1000 ? prompt.slice(0, 1000) + '...' : prompt
          extras.push(`prompt: "${truncatedPrompt}"`)
        }
        if (agentParams && Object.keys(agentParams).length > 0) {
          const paramsStr = JSON.stringify(agentParams)
          const truncatedParams =
            paramsStr.length > 1000
              ? paramsStr.slice(0, 1000) + '...'
              : paramsStr
          extras.push(`params: ${truncatedParams}`)
        }
        if (extras.length > 0) {
          return `delegated agent ${agentType} (${extras.join(', ')})`
        }
        return `delegated agent ${agentType}`
      }
      return 'delegated agent work'
    }
    case 'write_todos': {
      const todos = input.todos as
        | Array<{ task: string; completed: boolean }>
        | undefined
      if (todos) {
        const completed = todos.filter((t) => t.completed).length
        const incomplete = todos.filter((t) => !t.completed)
        if (incomplete.length === 0) {
          return `Todos: ${completed}/${todos.length} complete (all done!)`
        }
        const remainingTasks = incomplete.map((t) => `- ${t.task}`).join('\n')
        return `Todos: ${completed}/${todos.length} complete. Remaining:\n${remainingTasks}`
      }
      return 'Updated todos'
    }
    case 'ask_user': {
      const questions = input.questions as
        | Array<{ question: string }>
        | undefined
      if (questions && questions.length > 0) {
        const questionTexts = questions.map((q) => q.question).join('; ')
        const truncated =
          questionTexts.length > 200
            ? questionTexts.slice(0, 200) + '...'
            : questionTexts
        return `Asked user: ${truncated}`
      }
      return 'Asked user question'
    }
    case 'suggest_followups':
      return 'Suggested followups'
    case 'web_search': {
      const query = input.query as string | undefined
      return query ? `web search for "${query}"` : 'web search'
    }
    case 'read_url': {
      const url = input.url as string | undefined
      return url ? `read URL: ${url}` : 'read a URL'
    }
    case 'gravity_index': {
      const query = input.query as string | undefined
      const action = input.action as string | undefined
      if (query) {
        return `Gravity Index ${action ?? 'search'} for "${query}"`
      }
      return action ? `Gravity Index ${action}` : 'Gravity Index use'
    }
    case 'read_docs': {
      const libraryTitle = input.libraryTitle as string | undefined
      const topic = input.topic as string | undefined
      if (libraryTitle && topic) {
        return `consulted docs: ${libraryTitle} - ${topic}`
      }
      return libraryTitle ? `consulted docs: ${libraryTitle}` : 'consulted docs'
    }
    case 'set_output':
      return 'set structured output'
    case 'set_messages':
      return 'updated message history'
    default:
      return `used tool ${toolName}`
  }
}

const SCAFFOLDING_TAGS = [
  'INSTRUCTIONS_PROMPT',
  'STEP_PROMPT',
  'SUBAGENT_SPAWN',
]

/**
 * Recognizes a memory artifact this module (or the context-pruner) produced.
 *
 * Both markers are required, and that is the point. A summary is dropped from
 * the history and re-parsed into entries, so anything mistaken for one is
 * silently eaten — and the bare `<conversation_summary>` tag is a string a user
 * can easily send, most obviously when asking about this very code. Requiring
 * the header too means only text that reproduces our envelope qualifies.
 *
 * The context-pruner matches on the tag alone. That is a deliberate divergence
 * (see the parity test): it matters much more here, because the cache-expiry
 * trigger compacts on ordinary idle turns rather than only near the context
 * limit, so a user message can meet a compaction pass within minutes.
 */
function isConversationSummary(message: Message): boolean {
  if (message.role !== 'user') return false
  const text = getTextContent(message)
  return (
    text.includes('<conversation_summary>') && text.includes(SUMMARY_HEADER)
  )
}

/**
 * Real conversation, as opposed to per-step scaffolding the runtime re-adds
 * anyway or a summary this pass is about to rebuild. Both are excluded from the
 * historical memory, and neither counts as evidence that the assistant has
 * started working on the live prompt.
 */
function isRealHistory(message: Message): boolean {
  return (
    !message.tags?.some((tag) => SCAFFOLDING_TAGS.includes(tag)) &&
    !isConversationSummary(message)
  )
}

/** The images on the most recent user message that had any. */
function lastUserImageParts(messages: Message[]): Array<ImagePart | FilePart> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    const imageParts = message.content.filter(
      (part: Record<string, unknown>) =>
        part.type === 'image' || part.type === 'media',
    )
    if (imageParts.length > 0) return imageParts as Array<ImagePart | FilePart>
  }
  return []
}

/** Pulls the historical memory back out of a summary message. */
function extractSummaryContent(message: Message): string {
  const text = getTextContent(message)
  const match = text.match(
    /<conversation_summary>([\s\S]*?)<\/conversation_summary>/,
  )
  if (!match) return ''
  let content = match[1].trim()
  if (content.startsWith(SUMMARY_HEADER)) {
    content = content.slice(SUMMARY_HEADER.length).trim()
  }
  const memoryMatch = content.match(
    /<historical_memory>([\s\S]*?)<\/historical_memory>/,
  )
  if (memoryMatch) {
    content = memoryMatch[1].trim()
  }
  return content
}

/**
 * Parses a previous summary text blob back into role-tagged entries, so a
 * second compaction can re-apply the budgets over old and new history alike.
 */
function parseSummaryIntoEntries(summaryText: string): SummaryEntry[] {
  if (!summaryText.trim()) return []

  const chunks = summaryText.split(ENTRY_SEPARATOR).filter((c) => c.trim())

  return chunks.map((chunk) => {
    const trimmed = chunk.trim()
    const isUser =
      trimmed.startsWith('[USER]') ||
      trimmed.startsWith('User request') ||
      trimmed.startsWith('User message') ||
      trimmed.startsWith('Current unresolved user request')
    return {
      role: isUser ? ('user' as const) : ('assistant_tool' as const),
      parts: [trimmed],
    }
  })
}

/**
 * Condenses each message into a role-tagged entry. Tool calls become one-line
 * descriptions, tool results are dropped except for errors and edit outcomes,
 * and long text is truncated head-and-tail.
 *
 * P1.5 C2: the newest HEAD_RECENT_EXEMPT_COUNT assistant messages (counted
 * newest-first, ignoring tool-only messages which rarely carry prose) are
 * exempt from the 1,300-token per-entry cap and may keep up to
 * HEAD_RECENT_ASSISTANT_LIMIT tokens instead. The middle of an argument is
 * exactly what the old cap destroyed, and these are the messages the tail
 * (C4) does not reach. Positional, not semantic — see the plan's §6 C2.
 */
function summarizeMessagesIntoEntries(messages: Message[]): SummaryEntry[] {
  const entries: SummaryEntry[] = []

  // Pre-compute how many prose-bearing assistant messages qualify for the
  // recent exemption by counting backwards over the whole slice.
  let recentQuota = HEAD_RECENT_EXEMPT_COUNT
  const recentLimit = new Map<Message, number>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const hasText =
      Array.isArray(message.content) &&
      (message.content as Array<Record<string, unknown>>).some(
        (part) => part.type === 'text' && typeof part.text === 'string',
      )
    if (!hasText) continue
    if (recentQuota > 0) {
      recentLimit.set(message, HEAD_RECENT_ASSISTANT_LIMIT)
      recentQuota--
    }
  }

  for (const message of messages) {
    if (message.role === 'user') {
      let text = getTextContent(message).trim()
      if (!text) continue
      text = truncateLongText(text, USER_MESSAGE_LIMIT * CHARS_PER_TOKEN)
      const hasImages =
        Array.isArray(message.content) &&
        message.content.some(
          (part: Record<string, unknown>) =>
            part.type === 'image' || part.type === 'media',
        )
      const imageNote = hasImages ? ' [image(s) were attached]' : ''
      entries.push({ role: 'user', parts: [`[USER]${imageNote}\n${text}`] })
    } else if (message.role === 'assistant') {
      const textLimit = recentLimit.get(message) ?? ASSISTANT_MESSAGE_LIMIT
      const textParts: string[] = []
      const toolSummaries: string[] = []

      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            const textWithoutThinkTags = part.text
              .replace(/<think>[\s\S]*?<\/think>/g, '')
              .trim()
            if (textWithoutThinkTags) {
              textParts.push(textWithoutThinkTags)
            }
          } else if (part.type === 'tool-call') {
            const input = (part.input as Record<string, unknown>) || {}
            toolSummaries.push(summarizeToolCall(part.toolName, input))
          }
        }
      }

      const parts: string[] = []
      if (textParts.length > 0) {
        const combinedText = truncateLongText(
          textParts.join('\n'),
          textLimit * CHARS_PER_TOKEN,
        )
        parts.push(`Progress note:\n${combinedText}`)
      }
      if (toolSummaries.length > 0) {
        parts.push(toolSummaries.join('\n'))
      }

      if (parts.length > 0) {
        entries.push({ role: 'assistant_tool', parts })
      }
    } else if (message.role === 'tool') {
      const entryParts = summarizeToolResult(message as ToolMessage)
      if (entryParts.length > 0) {
        entries.push({
          role: 'assistant_tool',
          parts: [
            truncateLongText(
              entryParts.join('\n\n'),
              TOOL_ENTRY_LIMIT * CHARS_PER_TOKEN,
            ),
          ],
        })
      }
    }
  }

  return entries
}

/**
 * Tool results are dropped wholesale except for the parts an agent still needs
 * after the fact: errors, non-zero exit codes, user answers, edit outcomes and
 * non-blacklisted subagent output.
 */
function summarizeToolResult(toolMessage: ToolMessage): string[] {
  const entryParts: string[] = []

  if (Array.isArray(toolMessage.content)) {
    for (const part of toolMessage.content) {
      if (part.type === 'json' && part.value) {
        const value = part.value as Record<string, unknown>

        if (value.errorMessage || value.error) {
          let errorText = String(value.errorMessage || value.error)
          if (errorText.length > 100) {
            errorText = errorText.slice(0, 100) + '...'
          }
          entryParts.push(
            `Tool error from ${toolMessage.toolName}: ${errorText}`,
          )
        }

        if (
          toolMessage.toolName === 'run_terminal_command' &&
          'exitCode' in value
        ) {
          const exitCode = value.exitCode as number
          if (exitCode !== 0) {
            entryParts.push(`Command failed with exit code: ${exitCode}`)
          }
        }

        if (toolMessage.toolName === 'ask_user') {
          if (value.skipped) {
            entryParts.push('User skipped question')
          } else if ('answers' in value) {
            const answers = value.answers as
              | Array<{
                  selectedOption?: string
                  selectedOptions?: string[]
                  otherText?: string
                }>
              | undefined
            if (answers && answers.length > 0) {
              const answerTexts = answers
                .map((a) => {
                  if (a.otherText) return a.otherText
                  if (a.selectedOptions) return a.selectedOptions.join(', ')
                  if (a.selectedOption) return a.selectedOption
                  return '(no answer)'
                })
                .join('; ')
              const truncated =
                answerTexts.length > 10_000
                  ? answerTexts.slice(0, 10_000) + '...'
                  : answerTexts
              entryParts.push(`User answered: ${truncated}`)
            }
          }
        }

        if (
          toolMessage.toolName === 'str_replace' ||
          toolMessage.toolName === 'propose_str_replace' ||
          toolMessage.toolName === 'write_file' ||
          toolMessage.toolName === 'propose_write_file'
        ) {
          const resultStr = JSON.stringify(value)
          const truncatedResult =
            resultStr.length > 2000
              ? resultStr.slice(0, 2000) + '...'
              : resultStr
          entryParts.push(
            `Edit result from ${toolMessage.toolName}:\n${truncatedResult}`,
          )
        }
      }
    }
  }

  if (
    toolMessage.toolName === 'spawn_agents' &&
    Array.isArray(toolMessage.content)
  ) {
    for (const part of toolMessage.content) {
      if (part.type === 'json' && Array.isArray(part.value)) {
        const agentResults = part.value as Array<{
          agentName?: string
          agentType?: string
          value?: { type?: string; value?: unknown }
        }>
        const includedResults = agentResults.filter(
          (r) =>
            r.agentType && !SPAWN_AGENTS_OUTPUT_BLACKLIST.includes(r.agentType),
        )
        if (includedResults.length > 0) {
          const resultSummaries = includedResults.map((r) => {
            let outputStr = ''
            if (r.value?.value !== undefined && r.value?.value !== null) {
              outputStr =
                typeof r.value.value === 'string'
                  ? r.value.value
                  : JSON.stringify(r.value.value)
              outputStr = outputStr
                .replace(/<think>[\s\S]*?<\/think>/g, '')
                .trim()
              if (
                outputStr.length >
                ASSISTANT_MESSAGE_LIMIT * CHARS_PER_TOKEN
              ) {
                outputStr =
                  outputStr.slice(
                    0,
                    ASSISTANT_MESSAGE_LIMIT * CHARS_PER_TOKEN,
                  ) + '...'
              }
            }
            return `- ${r.agentType}: ${outputStr || '(no output)'}`
          })
          entryParts.push(`Agent results:\n${resultSummaries.join('\n')}`)
        }
      }
    }
  }

  return entryParts
}

/**
 * Walks entries newest-first and keeps what fits. The two roles have separate
 * budgets on purpose: exhausting the assistant/tool budget must not evict user
 * prompts, and vice versa. The newest entry is always kept even when it alone
 * blows its budget.
 */
function selectEntriesWithinBudget(
  entries: SummaryEntry[],
  budgets: { assistantToolBudget: number; userBudget: number },
): {
  /** Chronological order. */
  includedEntries: SummaryEntry[]
  newestEntryForced: boolean
} {
  let assistantToolTokens = 0
  let userTokens = 0
  let assistantToolBudgetExhausted = false
  let userBudgetExhausted = false
  const reverseIncluded: SummaryEntry[] = []

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    const entryText = entry.parts.join(ENTRY_SEPARATOR)
    const entryTokens = Math.ceil(entryText.length / CHARS_PER_TOKEN)

    if (entry.role === 'user') {
      if (userBudgetExhausted) continue
      if (userTokens + entryTokens > budgets.userBudget) {
        userBudgetExhausted = true
        continue
      }
      userTokens += entryTokens
    } else {
      if (assistantToolBudgetExhausted) continue
      if (assistantToolTokens + entryTokens > budgets.assistantToolBudget) {
        assistantToolBudgetExhausted = true
        continue
      }
      assistantToolTokens += entryTokens
    }

    reverseIncluded.push(entry)
  }

  const newestEntry = entries[entries.length - 1]
  let newestEntryForced = false
  if (newestEntry && !reverseIncluded.includes(newestEntry)) {
    reverseIncluded.unshift(newestEntry)
    newestEntryForced = true
  }

  return { includedEntries: reverseIncluded.reverse(), newestEntryForced }
}

/** Renders chronological entries into the historical memory blob. */
function renderSummaryText(entries: SummaryEntry[]): string {
  return entries.flatMap((entry) => entry.parts).join(ENTRY_SEPARATOR)
}

/**
 * P1.5 C4: walks the history newest-first and collects a verbatim tail —
 * whole tool-call/result pairs (plus any plain messages interleaved between
 * them) — stopping at `tailBudget` estimated tokens or `TAIL_MAX_PAIRS` pairs.
 *
 * The cut must be structurally legal: the boundary always lands on the start
 * of an assistant tool-call message (or the oldest collected plain message),
 * never mid-pair, so the retained slice reads as a normal conversation. The
 * summary is cut where the tail begins so nothing appears twice.
 */
function splitTail(params: {
  /** The history that is a candidate for tail inclusion (mid-turn: all real history; otherwise minus the live prompt). */
  messages: Message[]
  tailBudget: number
}): { tail: Message[]; rest: Message[]; tailTokens: number; pairCount: number } {
  const { messages, tailBudget } = params
  // Exclusive start of the tail: everything from `boundary` onward is kept
  // verbatim. Walk newest-first collecting tool-call/result pairs (plus the
  // plain messages interleaved between them) until the budget or TAIL_MAX_PAIRS
  // stops the walk, then trim any dangling tool results at the boundary — a
  // tail that opens on a result whose call stayed in the head would be
  // structurally illegal (providers require results to follow their call).
  let boundary = messages.length
  let pairs = 0
  let tokens = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    // The live prompt is never tail material: mid-turn it is summarized into
    // the head, and non-mid-turn it is re-appended whole below. Either way,
    // letting the walk cross it would duplicate it.
    if (message.tags?.includes('USER_PROMPT')) break
    if (
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      (message.content as Array<Record<string, unknown>>).some(
        (part) => part.type === 'tool-call',
      )
    ) {
      if (pairs >= TAIL_MAX_PAIRS) break
      pairs++
    }
    const cost = countTokensOfMessage(message)
    if (tokens + cost > tailBudget) break
    tokens += cost
    boundary = i
  }

  // Drop dangling tool results at the start of the tail.
  while (
    boundary < messages.length &&
    messages[boundary].role === 'tool'
  ) {
    boundary++
  }

  const tail = messages.slice(boundary)
  // A tail with no tool-call pair is pure prose the head would carry better —
  // keep the history intact instead of duplicating it verbatim.
  const tailHasPair = tail.some(
    (message) =>
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      (message.content as Array<Record<string, unknown>>).some(
        (part) => part.type === 'tool-call',
      ),
  )
  if (!tailHasPair) {
    return { tail: [], rest: messages, tailTokens: 0, pairCount: 0 }
  }

  return {
    tail,
    rest: messages.slice(0, boundary),
    tailTokens: tail.reduce((sum, m) => sum + countTokensOfMessage(m), 0),
    pairCount: tail.filter(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        (message.content as Array<Record<string, unknown>>).some(
          (part) => part.type === 'tool-call',
        ),
    ).length,
  }
}

/** Rough per-message token estimate consistent with CHARS_PER_TOKEN. */
function countTokensOfMessage(message: Message): number {
  let chars = 0
  const content = message.content as unknown
  if (typeof content === 'string') {
    chars = content.length
  } else if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === 'text' && typeof part.text === 'string') {
        chars += part.text.length
      } else if (part.type === 'tool-call') {
        try {
          chars += JSON.stringify(part.input ?? {}).length
        } catch {
          chars += 0
        }
      } else if (part.type === 'json') {
        try {
          chars += JSON.stringify(part.value ?? {}).length
        } catch {
          chars += 0
        }
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

// =============================================================================
// P1.5 C3: pinned knowledge block
// =============================================================================

const KNOWLEDGE_GOAL_CHAR_CAP = 2_400
const KNOWLEDGE_LIST_CAP = 25
const KNOWLEDGE_NEXT_CHAR_CAP = 1_400
const KNOWLEDGE_BLOCK_HEADER = '<knowledge_memory>'

/** Short replies that carry no goal signal (parity with live-prompt heuristics). */
const GOAL_NOISE_RE =
  /^(ok|okay|done|continue|go on|go ahead|thanks|thank you|yes|no|sure|proceed|keep going|繼續|好|完成|嗯)[.!…。]*\s*$/i

/** Tool calls that inspected something (paths go into Files Inspected). */
const INSPECT_TOOLS = new Set([
  'read_files',
  'read_subtree',
  'code_search',
  'glob',
  'list_directory',
  'find_files',
])
/** Tool calls that changed something (paths go into Edits Made). */
const EDIT_TOOLS = new Set([
  'write_file',
  'str_replace',
  'propose_write_file',
  'propose_str_replace',
])

function pathFromToolInput(toolName: string, input: Record<string, unknown>): string[] {
  void toolName
  const raw = input.paths ?? input.path
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) {
    return raw
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : ((entry as { path?: string } | undefined)?.path ?? ''),
      )
      .filter((p): p is string => p.length > 0)
  }
  return []
}

/**
 * Deterministic Goal/Files/Edits/Next block, pinned verbatim ahead of the
 * historical memory. Everything comes from structured message data — no
 * heuristics beyond the short-reply noise filter, per the plan's
 * anti-overengineering list (§7): no Decisions regex, no edit receipts.
 */
function buildKnowledgeBlock(params: {
  messages: Message[]
  previousBlock: string | null
}): string {
  const { messages, previousBlock } = params

  // Latest real USER_PROMPT text, unless it is a short filler reply.
  let goal: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    if (message.tags?.includes('USER_PROMPT') === false) continue
    const text = getTextContent(message).trim()
    if (!text || GOAL_NOISE_RE.test(text.replace(/<[^>]+>/g, '').trim())) continue
    goal = text
    break
  }

  const inspected: string[] = []
  const edited: string[] = []
  let nextAction: string | null = null

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type !== 'tool-call') continue
      const toolName = part.toolName as string
      const input = (part.input as Record<string, unknown>) || {}
      if (INSPECT_TOOLS.has(toolName)) {
        for (const p of pathFromToolInput(toolName, input)) {
          if (!inspected.includes(p)) inspected.push(p)
        }
      }
      if (EDIT_TOOLS.has(toolName)) {
        for (const p of pathFromToolInput(toolName, input)) {
          if (!edited.includes(p)) edited.push(p)
        }
      }
      if (toolName === 'write_todos' && nextAction === null) {
        const todos = input.todos as
          | Array<{ task: string; completed: boolean }>
          | undefined
        const open = todos?.find((t) => !t.completed)
        if (open) nextAction = open.task
      }
    }
  }

  if (nextAction === null) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue
      const text = getTextContent(messages[i]).trim()
      if (text) {
        nextAction = text.slice(-KNOWLEDGE_NEXT_CHAR_CAP)
        break
      }
    }
  }

  // Carry forward entries from the previous block (entry-list rebuild, not
  // whole-block append): the previous block's lists are re-parsed and
  // unioned, current entries first.
  const previousLists = parseKnowledgeLists(previousBlock)
  const mergeWithCap = (current: string[], previous: string[]) => {
    const merged = [...current]
    for (const p of previous) {
      if (merged.length >= KNOWLEDGE_LIST_CAP) break
      if (!merged.includes(p)) merged.push(p)
    }
    return merged
  }
  const files = mergeWithCap(inspected, previousLists.inspected)
  const edits = mergeWithCap(edited, previousLists.edited)
  if (goal === null) goal = previousLists.goal
  if (nextAction === null) nextAction = previousLists.nextAction

  const lines: string[] = []
  if (goal) {
    lines.push(
      `Goal: ${goal.length > KNOWLEDGE_GOAL_CHAR_CAP ? goal.slice(0, KNOWLEDGE_GOAL_CHAR_CAP) + '…' : goal}`,
    )
  }
  if (files.length > 0) {
    lines.push(`Files Inspected:\n${files.map((p) => `- ${p}`).join('\n')}`)
  }
  if (edits.length > 0) {
    lines.push(`Edits Made:\n${edits.map((p) => `- ${p}`).join('\n')}`)
  }
  if (nextAction) {
    lines.push(
      `Next Action: ${
        nextAction.length > KNOWLEDGE_NEXT_CHAR_CAP
          ? nextAction.slice(0, KNOWLEDGE_NEXT_CHAR_CAP) + '…'
          : nextAction
      }`,
    )
  }
  if (lines.length === 0) return ''

  let block = `${KNOWLEDGE_BLOCK_HEADER}\n${lines.join('\n\n')}\n</knowledge_memory>`
  // Whole-block token cap: drop trailing sections until it fits.
  while (
    lines.length > 1 &&
    Math.ceil(block.length / CHARS_PER_TOKEN) > KNOWLEDGE_BLOCK_TOKEN_CAP
  ) {
    lines.pop()
    block = `${KNOWLEDGE_BLOCK_HEADER}\n${lines.join('\n\n')}\n</knowledge_memory>`
  }
  if (Math.ceil(block.length / CHARS_PER_TOKEN) > KNOWLEDGE_BLOCK_TOKEN_CAP) {
    return ''
  }
  return block
}

/** Re-parses a previous knowledge block so its entries survive compaction. */
function parseKnowledgeLists(block: string | null): {
  goal: string | null
  inspected: string[]
  edited: string[]
  nextAction: string | null
} {
  if (!block) return { goal: null, inspected: [], edited: [], nextAction: null }
  const match = block.match(
    /<knowledge_memory>([\s\S]*?)<\/knowledge_memory>/,
  )
  if (!match) return { goal: null, inspected: [], edited: [], nextAction: null }
  const body = match[1]
  const goalMatch = body.match(/^Goal: ([\s\S]*?)(?=\n\n|\nFiles Inspected:|$)/m)
  const nextMatch = body.match(/^Next Action: ([\s\S]*)$/m)
  const list = (header: string) => {
    const section = body.match(
      new RegExp(`^${header}:\\n([\\s\\S]*?)(?=\\n\\n|\\n[A-Z][a-z]* [A-Z]|$)`, 'm'),
    )
    if (!section) return []
    return section[1]
      .split('\n')
      .map((line) => line.replace(/^- /, '').trim())
      .filter((line) => line.length > 0)
  }
  return {
    goal: goalMatch ? goalMatch[1].trim() : null,
    inspected: list('Files Inspected'),
    edited: list('Edits Made'),
    nextAction: nextMatch ? nextMatch[1].trim() : null,
  }
}

/**
 * Wraps the historical memory in the message the model actually sees.
 * P1.5 C3: a pinned `<knowledge_memory>` block sits inside the envelope,
 * ahead of the historical memory, so the newest Goal/Files/Edits/Next facts
 * are exempt from the head budgets.
 */
function buildSummaryMessage(
  summaryText: string,
  knowledgeBlock: string,
  imageParts: Array<ImagePart | FilePart>,
  sentAt: number,
): Message {
  const textPart: TextPart = {
    type: 'text',
    text: `<conversation_summary>
${SUMMARY_HEADER}

${knowledgeBlock ? `${knowledgeBlock}\n\n` : ''}<historical_memory>
${summaryText}
</historical_memory>
</conversation_summary>

${SUMMARY_DISCLAIMER}`,
  }
  return {
    role: 'user',
    content: [textPart, ...imageParts],
    sentAt,
  }
}

/** Pulls a previous knowledge block back out of a summary message. */
function extractKnowledgeBlock(message: Message): string | null {
  const text = getTextContent(message)
  const match = text.match(
    /<knowledge_memory>([\s\S]*?)<\/knowledge_memory>/,
  )
  return match ? match[0] : null
}

export type CompactionResult = {
  messages: Message[]
  summaryText: string
  /**
   * Snake_case on purpose: these go straight into the Axiom event, under the
   * same field names the context-pruner logs, so both agents' compactions can
   * be queried as one series.
   */
  stats: {
    mid_turn: boolean
    user_budget: number
    assistant_tool_budget: number
    /** P1.5 C5: which layer supplied the scale anchor. */
    trigger_source: 'baked' | 'params' | 'window'
    /** P1.5 C5: C1 scale actually applied. */
    budget_scale: number
    tail_budget: number
    /** P1.5 C5: estimated tokens carried by the verbatim tail (0 when none). */
    tail_tokens: number
    tail_pair_count: number
    /** P1.5 C5: estimated tokens of the pinned knowledge block (0 when empty). */
    knowledge_block_tokens: number
    previous_summary_entry_count: number
    user_entry_count: number
    dropped_user_entry_count: number
    assistant_tool_entry_count: number
    dropped_assistant_tool_entry_count: number
    newest_entry_forced: boolean
    live_user_prompt_found: boolean
    summary_estimated_tokens: number
  }
}

/**
 * Rewrites `messages` into
 * `[summary(+knowledge block), instructionsPrompt?, ...verbatim tail, livePromptOrContinuation]`.
 * Pure and synchronous — no model call.
 */
export function compactMessages(params: {
  messages: Message[]
  assistantToolBudget?: number
  userBudget?: number
  /** C4: explicit verbatim-tail budget; defaults to the C1-scaled clamp. */
  tailBudget?: number
  /** C1 scale anchor (the compaction trigger the caller derived from the window). */
  maxContextLength?: number
  now?: number
}): CompactionResult {
  const {
    messages,
    now = Date.now(),
    maxContextLength = BUDGET_SCALE_ANCHOR_TOKENS,
  } = params
  // C1: scale budgets off the caller's window-derived trigger, honoring
  // explicit overrides. Defaulting the anchor to 400k reproduces the
  // pre-P1.5 budgets bit-for-bit at scale 1.
  const { assistantToolBudget, userBudget, tailBudget, scale } =
    resolveBudgetsFor({
      maxContextLength,
      assistantToolBudget: params.assistantToolBudget,
      userBudget: params.userBudget,
      tailBudget: params.tailBudget,
    })

  // The live instructions prompt is scaffolding, not history: hold onto it and
  // re-append it after the summary so the agent keeps its standing orders.
  const instructionsPromptMessage =
    messages.findLast((message) =>
      message.tags?.includes('INSTRUCTIONS_PROMPT'),
    ) ?? null

  const previousSummary = messages.findLast(isConversationSummary)

  // If compaction happens before the assistant has started responding to the
  // current user prompt, preserve that prompt as a real message after the
  // memory artifact. Mid-turn, the prompt goes into the memory alongside the
  // work that followed it and a synthetic continuation prompt takes its place.
  const livePromptIndex = messages.findLastIndex((message) =>
    message.tags?.includes('USER_PROMPT'),
  )
  const livePrompt = livePromptIndex === -1 ? null : messages[livePromptIndex]
  const isMidTurn =
    livePrompt !== null &&
    messages.slice(livePromptIndex + 1).some(isRealHistory)

  const realHistory = messages.filter(
    (message, index) =>
      isRealHistory(message) && (isMidTurn || index !== livePromptIndex),
  )

  // C4: split the verbatim tail off first; the head only summarizes what the
  // tail does not carry. The live prompt is never tail material — it is
  // re-appended whole below.
  const { tail, rest, tailTokens, pairCount } = splitTail({
    messages: realHistory,
    tailBudget,
  })

  const messagesToSummarize = rest

  const previousSummaryEntries = parseSummaryIntoEntries(
    previousSummary ? extractSummaryContent(previousSummary) : '',
  )
  const entries = [
    ...previousSummaryEntries,
    ...summarizeMessagesIntoEntries(messagesToSummarize),
  ]
  const { includedEntries, newestEntryForced } = selectEntriesWithinBudget(
    entries,
    { assistantToolBudget, userBudget },
  )
  const summaryText = renderSummaryText(includedEntries)

  // Images cannot survive as text, so carry the most recent set forward.
  const imageParts = lastUserImageParts(rest)

  // C3: pinned knowledge block inside the summary envelope, ahead of the
  // historical memory. Scans the full real history (the tail carries the
  // same facts, but the block must survive the next compaction, when the
  // tail itself will be gone) and is seeded from the previous block so
  // entries survive repeated compactions.
  const knowledgeBlock = buildKnowledgeBlock({
    messages: realHistory,
    previousBlock: previousSummary ? extractKnowledgeBlock(previousSummary) : null,
  })

  const finalMessages: Message[] = [
    buildSummaryMessage(summaryText, knowledgeBlock, imageParts, now),
  ]
  if (instructionsPromptMessage) {
    // Refresh sentAt so downstream cache-expiry checks see a live timestamp.
    finalMessages.push({ ...instructionsPromptMessage, sentAt: now })
  }
  // C4: verbatim tail between the summary (and instructions) and the live
  // prompt. Messages here are re-used as-is — reasoning content, tool-call
  // inputs and results all survive byte-for-byte.
  finalMessages.push(...tail)
  finalMessages.push(
    isMidTurn || !livePrompt
      ? {
          role: 'user',
          content: [{ type: 'text', text: CONTINUATION_TEXT }],
          sentAt: now,
        }
      : { ...livePrompt, sentAt: now },
  )

  const countUsers = (list: SummaryEntry[]) =>
    list.filter((entry) => entry.role === 'user').length
  const userEntries = countUsers(entries)
  const includedUserEntries = countUsers(includedEntries)
  const assistantToolEntries = entries.length - userEntries
  const includedAssistantToolEntries =
    includedEntries.length - includedUserEntries

  return {
    messages: finalMessages,
    summaryText,
    stats: {
      mid_turn: isMidTurn,
      user_budget: userBudget,
      assistant_tool_budget: assistantToolBudget,
      trigger_source: 'baked',
      budget_scale: scale,
      tail_budget: tailBudget,
      tail_tokens: tailTokens,
      tail_pair_count: pairCount,
      knowledge_block_tokens: Math.ceil(
        knowledgeBlock.length / CHARS_PER_TOKEN,
      ),
      previous_summary_entry_count: previousSummaryEntries.length,
      user_entry_count: userEntries,
      dropped_user_entry_count: userEntries - includedUserEntries,
      assistant_tool_entry_count: assistantToolEntries,
      dropped_assistant_tool_entry_count:
        assistantToolEntries - includedAssistantToolEntries,
      newest_entry_forced: newestEntryForced,
      live_user_prompt_found: livePrompt !== null,
      summary_estimated_tokens: Math.ceil(summaryText.length / CHARS_PER_TOKEN),
    },
  }
}

/**
 * How long the conversation sat idle before the live user prompt arrived, or
 * null when the history has no pair of timestamps to measure between.
 *
 * The gap is measured from the last assistant message to the USER_PROMPT that
 * follows it: that is the window in which the provider's prompt cache had to
 * survive on its own. Tool messages carry no `sentAt`, so they are skipped.
 */
export function promptCacheGapMs(messages: Message[]): number | null {
  const userPromptIndex = messages.findLastIndex((message) =>
    message.tags?.includes('USER_PROMPT'),
  )
  if (userPromptIndex <= 0) return null

  const userPrompt = messages[userPromptIndex]
  if (!userPrompt.sentAt) return null

  for (let i = userPromptIndex - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    return message.sentAt ? userPrompt.sentAt - message.sentAt : null
  }
  return null
}

/**
 * Decides whether to compact, and why.
 *
 * Two triggers. The context limit is the one that must fire — the history no
 * longer fits. Cache expiry is the opportunistic one: once the prompt cache has
 * gone cold, the next request re-reads the whole history at full price anyway,
 * so rewriting it costs nothing and every later step in the turn is cheaper.
 * Compacting while the cache is warm would be the expensive mistake, which is
 * why the TTL errs long.
 *
 * The opportunistic trigger additionally needs enough context to be worth the
 * detail it destroys — see DEFAULT_CACHE_EXPIRY_MIN_TOKENS. The context limit
 * ignores that floor.
 */
export function evaluateCompactionTrigger(params: {
  messages: Message[]
  contextTokenCount: number
  maxContextLength: number
  /** Pass null to disable the opportunistic cache-expiry trigger. */
  cacheExpiryMs?: number | null
  /** Pass null to take the opportunistic compaction at any size. */
  cacheExpiryMinTokens?: number | null
}): {
  /** null means "leave the history alone". */
  trigger: CompactionTrigger | null
  cacheGapMs: number | null
  /** The thresholds actually applied, after defaulting. */
  cacheExpiryMs: number | null
  cacheExpiryMinTokens: number | null
} {
  const { messages, contextTokenCount, maxContextLength } = params
  const cacheExpiryMs =
    params.cacheExpiryMs === undefined
      ? DEFAULT_CACHE_EXPIRY_MS
      : params.cacheExpiryMs
  const cacheExpiryMinTokens =
    params.cacheExpiryMinTokens === undefined
      ? DEFAULT_CACHE_EXPIRY_MIN_TOKENS
      : params.cacheExpiryMinTokens

  const overContextLimit = contextTokenCount > maxContextLength
  const worthCompacting =
    cacheExpiryMinTokens === null || contextTokenCount >= cacheExpiryMinTokens
  const cacheGapMs =
    cacheExpiryMs === null || !worthCompacting
      ? null
      : promptCacheGapMs(messages)
  const cacheExpired =
    cacheExpiryMs !== null && cacheGapMs !== null && cacheGapMs > cacheExpiryMs

  const trigger: CompactionTrigger | null = overContextLimit
    ? cacheExpired
      ? 'context_limit_and_cache_expiry'
      : 'context_limit'
    : cacheExpired
      ? 'cache_expiry'
      : null

  return { trigger, cacheGapMs, cacheExpiryMs, cacheExpiryMinTokens }
}

/**
 * Runtime entry point for `compactContext` agents: decides, compacts and logs.
 * Returns null when the history should be left alone.
 *
 * Never calls a model, so it cannot fail on a provider error and has no
 * fallback path — the previous LLM-summarizing version returned the full
 * history when the call failed, which left the context over budget.
 */
export function maybeCompactHistory(params: {
  messages: Message[]
  contextTokenCount: number
  maxContextLength: number
  /** Pass null to compact on the context limit only. */
  cacheExpiryMs?: number | null
  /** Pass null to take the opportunistic compaction at any size. */
  cacheExpiryMinTokens?: number | null
  logger?: Logger
  runId?: string
  onCompaction?: (trigger: CompactionTrigger) => void
}): Message[] | null {
  const { messages, contextTokenCount, maxContextLength, logger, runId } =
    params

  const { trigger, cacheGapMs, cacheExpiryMs, cacheExpiryMinTokens } =
    evaluateCompactionTrigger({
      messages,
      contextTokenCount,
      maxContextLength,
      cacheExpiryMs: params.cacheExpiryMs,
      cacheExpiryMinTokens: params.cacheExpiryMinTokens,
    })
  if (!trigger) return null

  // C1: the window-derived trigger doubles as the budget scale anchor, so
  // the head budgets follow the model's real window.
  const result = compactMessages({ messages, maxContextLength })
  try {
    params.onCompaction?.(trigger)
  } catch {
    // Reporting must never block the compaction itself.
  }

  // Telemetry is best-effort and must never block the compaction itself.
  try {
    logger?.info(
      {
        axiomEvent: 'context_compaction_completed',
        agent_run_id: runId,
        trigger_reason: trigger,
        context_token_count: contextTokenCount,
        max_context_length: maxContextLength,
        ...(cacheGapMs === null ? {} : { cache_gap_ms: cacheGapMs }),
        ...(cacheExpiryMs === null ? {} : { cache_expiry_ms: cacheExpiryMs }),
        ...(cacheExpiryMinTokens === null
          ? {}
          : { cache_expiry_min_tokens: cacheExpiryMinTokens }),
        message_count: messages.length,
        // Spread first: stats carries trigger_source (C5) and this caller
        // always resolves the window itself.
        ...result.stats,
        trigger_source: 'window',
      },
      'Context compaction completed',
    )
  } catch {
    // Ignore logging failures.
  }

  return result.messages
}
