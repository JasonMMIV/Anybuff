import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const SPAWN_TOOL_NAME = 'spawn_agents'

/**
 * Shown when a recognised transcript renders to nothing. Falling back to the raw
 * report here would hand the reviewer the reasoning parts this module exists to
 * drop, so each reason gets its own line instead of one vague sentence.
 */
const EMPTY_TRANSCRIPT = {
  empty: '(The subagent returned no messages.)',
  reasoningOnly:
    '(The subagent produced no visible output. Its internal reasoning was omitted.)',
  unreadable: '(The subagent produced no readable output.)',
} as const

/**
 * Renders a `spawn_agents` tool result into a readable record of what the
 * subagent actually changed.
 *
 * A reviewer is a leaf agent: it has no tools, so the only record of a
 * subagent's work is its `AgentOutput` inside the parent's history. Raw, that
 * record is unusable — `editor` nests its edits four levels deep
 * (`value.value.output.messages[...]`) and `editor-multi-prompt` only reports
 * file names plus "Successfully replaced N occurrence(s)". This turns both into
 * plain text a model can read directly.
 *
 * Two output shapes are recognised, both by shape rather than by agent name:
 *
 * - `structuredOutput.value.output.messages` — a subagent transcript
 *   (`editor`). Visible `text` is kept, `reasoning` is dropped, and each edit
 *   tool call is expanded into its path plus old/new strings. `write_file` is
 *   rendered in full and labelled as a whole-file write.
 * - `structuredOutput.value.unifiedDiff` (plus `chosenStrategy` / `reason` /
 *   `suggestedImprovements`) — the applied changes from `editor-multi-prompt`.
 *
 * Fail-open by construction: anything unrecognised (an `errorMessage`, a
 * `lastMessage` output, a non-array value, a null structured output, an
 * unknown shape) is returned untouched. A reviewer that sees raw JSON is still
 * better off than one that sees an empty edit list and concludes nothing
 * changed.
 *
 * The one place fail-open must NOT apply is a transcript that is recognised but
 * renders to nothing: its raw form still contains the reasoning parts ADR-34
 * removes, so it gets a placeholder instead (three variants — empty, reasoning
 * only, unreadable — so the reviewer can tell them apart).
 *
 * The `json` part type is preserved — only its `value` is swapped. Emitting a
 * `text` part instead would throw in `convertToolResultMessage`, which rejects
 * every tool output part that is not `json` or `media`.
 */
export function renderSubagentToolMessage(params: { message: Message }): Message {
  const { message } = params

  if (message.role !== 'tool' || message.toolName !== SPAWN_TOOL_NAME) {
    return message
  }

  const content = message.content
  if (!Array.isArray(content) || content.length === 0) {
    return message
  }

  let changed = false
  const nextContent = content.map((part) => {
    if (part.type !== 'json') {
      return part
    }

    // Captured before the closures below: narrowing on a property does not
    // survive into a callback.
    const value = part.value
    if (!Array.isArray(value)) {
      return part
    }

    const reports = value.map((report) => renderReport(report))
    if (reports.every((report, index) => report === value[index])) {
      return part
    }

    changed = true
    return { ...part, value: reports }
  })

  if (!changed) {
    return message
  }

  return { ...message, content: nextContent } as Message
}

/**
 * Renders one `AgentOutput` to text. Returns null when the shape is not one we
 * know how to represent — the caller then keeps the original value.
 */
export function renderAgentOutput(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const output = value as Record<string, unknown>

  const transcript = readTranscript(output)
  if (transcript !== null) {
    // A recognised transcript must never fall back to the raw report: the raw
    // value still carries the reasoning parts ADR-34 removes, so "renders to
    // nothing" would leak exactly what fail-open is supposed to avoid.
    const rendered = renderMessages(transcript)
    if (rendered !== null) {
      return rendered
    }
    if (transcript.length === 0) {
      return EMPTY_TRANSCRIPT.empty
    }
    return transcript.some(hasReasoningPart)
      ? EMPTY_TRANSCRIPT.reasoningOnly
      : EMPTY_TRANSCRIPT.unreadable
  }

  if (
    typeof output.unifiedDiff === 'string' ||
    typeof output.chosenStrategy === 'string'
  ) {
    return renderAppliedChanges(output)
  }

  return null
}

/**
 * The transcript shapes we recognise. `editor` emits `{ output: { messages } }`,
 * but `set_output` collapses a lone `data` key, so `{ messages }` is reachable
 * too — and leaving it unrecognised would hand the reviewer the raw reasoning
 * this module exists to drop.
 */
function readTranscript(output: Record<string, unknown>): unknown[] | null {
  const nested = output.output
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    const messages = (nested as Record<string, unknown>).messages
    if (Array.isArray(messages)) {
      return messages
    }
  }
  if (Array.isArray(output.messages)) {
    return output.messages
  }
  return null
}

function renderReport(report: unknown): unknown {
  if (report === null || typeof report !== 'object') {
    return report
  }

  const entry = report as Record<string, unknown>
  const output = entry.value
  if (output === null || typeof output !== 'object') {
    return report
  }

  const agentOutput = output as Record<string, unknown>
  if (agentOutput.type !== 'structuredOutput') {
    return report
  }

  const rendered = renderAgentOutput(agentOutput.value)
  if (rendered === null) {
    return report
  }

  return {
    agentName: entry.agentName,
    agentType: entry.agentType,
    rendered,
  }
}

function renderMessages(messages: unknown[]): string | null {
  const blocks: string[] = []
  // Tool results attach to the call that produced them, by id: a failed edit
  // must not read like an applied one. A single "last call" slot breaks as soon
  // as one message carries several calls — the editor's normal parallel edits.
  const blockIndexByCallId = new Map<string, number>()

  for (const message of messages) {
    if (message === null || typeof message !== 'object') {
      continue
    }

    const record = message as Record<string, unknown>
    const content = record.content

    if (typeof content === 'string') {
      const text = content.trim()
      if (text.length > 0) {
        blocks.push(text)
      }
      continue
    }

    if (!Array.isArray(content)) {
      continue
    }

    if (record.role === 'tool') {
      const results = renderToolResults(content).join('\n')
      const toolCallId =
        typeof record.toolCallId === 'string' ? record.toolCallId : undefined
      const blockIndex =
        toolCallId !== undefined
          ? blockIndexByCallId.get(toolCallId)
          : undefined

      if (blockIndex !== undefined) {
        blocks[blockIndex] = `${blocks[blockIndex]}\n${results}`
      } else {
        blocks.push(results)
      }
      continue
    }

    for (const part of content) {
      const rendered = renderContentPart(part)
      if (rendered === null) {
        continue
      }
      const index = blocks.length
      blocks.push(rendered)
      const callId = toolCallIdOf(part)
      if (callId !== undefined) {
        blockIndexByCallId.set(callId, index)
      }
    }
  }

  return blocks.length > 0 ? blocks.join('\n\n') : null
}

function toolCallIdOf(part: unknown): string | undefined {
  if (part === null || typeof part !== 'object') {
    return undefined
  }
  const record = part as Record<string, unknown>
  if (record.type !== 'tool-call') {
    return undefined
  }
  return typeof record.toolCallId === 'string' ? record.toolCallId : undefined
}

function renderContentPart(part: unknown): string | null {
  if (part === null || typeof part !== 'object') {
    return null
  }

  const record = part as Record<string, unknown>

  // The ADR-34 rule applies inside subagent transcripts too.
  if (record.type === 'reasoning') {
    return null
  }
  if (record.type === 'text') {
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    return text.length > 0 ? text : null
  }
  if (record.type === 'tool-call') {
    return renderToolCall(record)
  }

  // Anything else (an image, a file part, a malformed part) still happened.
  // Dropping it silently can collapse the whole transcript to "no readable
  // output", which reads like the subagent did nothing.
  const type = typeof record.type === 'string' ? record.type : 'unknown'
  return `(non-text part: ${type})`
}

function renderToolCall(call: Record<string, unknown>): string {
  const toolName = typeof call.toolName === 'string' ? call.toolName : 'unknown_tool'
  const input =
    call.input !== null && typeof call.input === 'object'
      ? (call.input as Record<string, unknown>)
      : {}

  if (toolName === 'str_replace') {
    return renderStrReplace(input)
  }
  if (toolName === 'write_file') {
    return renderWriteFile(input)
  }
  if (toolName === 'apply_patch') {
    return renderApplyPatch(input)
  }

  return `**${toolName}**\n${fence(JSON.stringify(input, null, 2), 'json')}`
}

function renderStrReplace(input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? input.path : undefined
  const header = `**str_replace — ${path ?? '(unknown path)'}**`
  const lines: string[] = []
  let rendered = 0

  for (const replacement of toReplacements(input.replacements)) {
    // The stored tool-call input is whatever the model emitted: `coerceToArray`
    // and `normalizeReplacementAliases` run inside the tool's schema at
    // execution time, not on the copy kept in message history.
    const oldString = readString(replacement, [
      'oldString',
      'old_str',
      'old_string',
      'old',
    ])
    const newString = readString(replacement, [
      'newString',
      'new_str',
      'new_string',
      'new',
    ])
    rendered++
    if (oldString === undefined || newString === undefined) {
      // Never drop a single unreadable replacement: the surviving labels would
      // renumber and the reviewer would conclude fewer edits were made.
      lines.push(`Change ${rendered}: (unreadable replacement)`)
      lines.push(fence(JSON.stringify(replacement, null, 2), 'json'))
      continue
    }

    lines.push(`Change ${rendered}: old`)
    lines.push(fence(oldString))
    lines.push(`Change ${rendered}: new`)
    lines.push(fence(newString))
  }

  if (rendered === 0) {
    // Never show an edit with no contents — fall back to the raw input instead.
    return `${header}\n${fence(JSON.stringify(input, null, 2), 'json')}`
  }

  return [header, ...lines].join('\n')
}

function toReplacements(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === 'object',
    )
  }
  if (value !== null && typeof value === 'object') {
    return [value as Record<string, unknown>]
  }
  return []
}

function readString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string') {
      return candidate
    }
  }
  return undefined
}

function renderApplyPatch(input: Record<string, unknown>): string {
  const operation = input.operation
  if (operation !== null && typeof operation === 'object') {
    const record = operation as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : undefined
    const path = typeof record.path === 'string' ? record.path : undefined
    const diff = typeof record.diff === 'string' ? record.diff : ''

    if (type !== undefined && path !== undefined) {
      const header = `**apply_patch (${type}) — ${path}**`
      if (diff.length > 0) {
        return `${header}\n${fence(diff, 'diff')}`
      }

      // A deletion legitimately has no body. Anything else without a diff
      // carries its payload in another field — render those fields rather than
      // dropping them, which would be a fail-open regression.
      const extras = Object.fromEntries(
        Object.entries(record).filter(
          ([key]) => key !== 'type' && key !== 'path' && key !== 'diff',
        ),
      )
      if (Object.keys(extras).length === 0) {
        return `${header}\n${type === 'delete_file' ? '(deletes the file)' : '(no file content)'}`
      }
      return `${header}\n${fence(JSON.stringify(extras, null, 2), 'json')}`
    }
  }

  return `**apply_patch**\n${fence(JSON.stringify(input, null, 2), 'json')}`
}

/** True when the message carries at least one dropped `reasoning` part. */
function hasReasoningPart(message: unknown): boolean {
  if (message === null || typeof message !== 'object') {
    return false
  }
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    (part) =>
      part !== null &&
      typeof part === 'object' &&
      (part as Record<string, unknown>).type === 'reasoning',
  )
}

function renderWriteFile(input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? input.path : '(unknown path)'
  const instructions =
    typeof input.instructions === 'string' ? input.instructions.trim() : ''
  const hasContent = typeof input.content === 'string'
  const content = hasContent ? (input.content as string) : ''

  const header = `**write_file — ${path} (whole-file write)**`
  const intro = instructions.length > 0 ? `${header}\n${instructions}` : header

  // A missing `content` is not an empty file: an empty fence under a
  // "whole-file write" header reads as "the file was emptied".
  const body = !hasContent
    ? '(no content supplied)'
    : content.length === 0
      ? '(empty file)'
      : fence(content)

  return `${intro}\n${body}`
}

function renderToolResults(content: unknown[]): string[] {
  const results: string[] = []

  for (const part of content) {
    if (part === null || typeof part !== 'object') {
      continue
    }
    const record = part as Record<string, unknown>
    if (record.type !== 'json') {
      // Media and other non-text outputs still happened; say so rather than
      // dropping the result entirely.
      results.push('→ (non-text result)')
      continue
    }
    // An unreadable result must not vanish: a missing outcome reads as success.
    results.push(`→ ${renderToolResultValue(record.value) ?? '(empty result)'}`)
  }

  return results.length > 0 ? results : ['→ (no result)']
}

function renderToolResultValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (Array.isArray(value)) {
    const rendered = value
      .map((entry) => renderToolResultValue(entry))
      .filter((entry): entry is string => entry !== null)
    return rendered.length > 0 ? rendered.join('\n- ') : null
  }

  if (typeof value !== 'object') {
    return String(value)
  }

  const record = value as Record<string, unknown>

  // Tool outputs are sometimes nested as `{ type: 'json', value }` arrays
  // (e.g. `editor-multi-prompt`'s `toolResults`).
  if (
    record.type === 'json' &&
    'value' in record &&
    Object.keys(record).length === 2
  ) {
    return renderToolResultValue(record.value)
  }

  const file = typeof record.file === 'string' ? record.file : undefined
  const message = typeof record.message === 'string' ? record.message : undefined
  const errorMessage =
    typeof record.errorMessage === 'string' ? record.errorMessage : undefined
  const patch = typeof record.patch === 'string' ? record.patch : undefined

  const headline =
    errorMessage !== undefined
      ? file
        ? `${file}: ${errorMessage}`
        : errorMessage
      : message !== undefined
        ? file
          ? `${file}: ${message}`
          : message
        : undefined

  if (headline === undefined) {
    return fence(JSON.stringify(value, null, 2), 'json')
  }

  const parts = [headline]
  if (patch !== undefined) {
    parts.push(fence(patch, 'diff'))
  }

  // Siblings such as `exitCode` or `stdout` carry the outcome. Returning on
  // `message` alone would hide a failing exit code behind a success-looking
  // line.
  const known = new Set(['type', 'value', 'file', 'message', 'errorMessage', 'patch'])
  const extras = Object.fromEntries(
    Object.entries(record).filter(([key]) => !known.has(key)),
  )
  if (Object.keys(extras).length > 0) {
    parts.push(fence(JSON.stringify(extras, null, 2), 'json'))
  }

  return parts.join('\n')
}

function renderAppliedChanges(output: Record<string, unknown>): string {
  const lines: string[] = []

  const strategy =
    typeof output.chosenStrategy === 'string' ? output.chosenStrategy : undefined
  const reason = typeof output.reason === 'string' ? output.reason : undefined
  const improvements =
    typeof output.suggestedImprovements === 'string'
      ? output.suggestedImprovements
      : undefined

  if (strategy !== undefined) {
    lines.push(`Chosen strategy: ${strategy}`)
  }
  if (reason !== undefined) {
    lines.push(`Reason: ${reason}`)
  }

  const applied = renderToolResultValue(output.toolResults)
  if (applied !== null) {
    lines.push(`Applied edits:\n${applied}`)
  }

  const diff = typeof output.unifiedDiff === 'string' ? output.unifiedDiff : ''
  lines.push(
    diff.length > 0
      ? `Unified diff of the applied changes:\n${fence(diff, 'diff')}`
      : 'No diff was reported for the applied changes.',
  )

  if (improvements !== undefined) {
    lines.push(`Suggested improvements: ${improvements}`)
  }

  return lines.join('\n\n')
}

/**
 * Fences text with more backticks than the longest run it contains, so diff and
 * code content that itself contains ``` cannot close the fence early.
 */
function fence(text: string, language?: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  )
  const marker = '`'.repeat(Math.max(3, longest + 1))
  const opening = language ? `${marker}${language}` : marker
  return `${opening}\n${text}\n${marker}`
}
