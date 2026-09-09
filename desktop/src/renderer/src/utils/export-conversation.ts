/**
 * #8 對話匯出（UI Export 選單）— conversation → Markdown serializer.
 *
 * Mirrors the upstream CLI `/copy` format (cli/src/commands/copy-conversation.ts):
 * role headings (`## User` / `## Assistant` / `## Error`), reasoning as a
 * blockquote, tool calls with their inputs & outputs in fenced code blocks
 * (JSON envelopes pretty-printed), todo checklists and file-change summaries —
 * so the exported file can be handed to another coding agent/session that
 * parses role boundaries out of Markdown.
 *
 * Input shape is the persisted transcript entry (host-core TaskMessage /
 * renderer ChatItem subset) — the same entries AnyBuff:getTaskView returns.
 * Unlike the CLI's clipboard variant there is no byte budget: a file export
 * keeps everything, byte-for-byte (no whitespace normalization anywhere).
 */

/** Minimal structural view of a persisted transcript tool entry. */
export interface ExportToolMessage {
  toolName?: string
  status?: string
  agentType?: string
  agentName?: string
  detail?: string
  todos?: Array<{ task: string; completed?: boolean }> | null
  toolInput?: unknown
  blockedPaths?: string[]
}

/** Minimal structural view of a persisted transcript message we can serialize. */
export interface ExportMessage {
  kind?: string
  text?: string
  reasoning?: string
  files?: Array<{ path: string; action: string }>
  tool?: ExportToolMessage
}

export interface SerializedConversation {
  text: string
  /** Number of rendered role messages (user / assistant / error) in the file. */
  messageCount: number
}

/** Human-friendly tool label, e.g. `read_files` -> `Read Files`. */
function toolDisplayName(toolName: string): string {
  if (toolName === 'list_directory') return 'List Directories'
  return toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

/** Fence tool bodies so they read as code, never as markdown that can leak out. */
function fence(content: string, lang = ''): string {
  // Avoid breaking out of the fence if the content itself contains ```.
  const ticks = content.includes('```') ? '````' : '```'
  return `${ticks}${lang}\n${content}\n${ticks}`
}

function renderToolInput(input: unknown): string {
  if (input == null) return ''
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/**
 * Tool results are stored as strings; many are a JSON envelope. Pretty-print
 * when the string parses as JSON so the transcript is readable; otherwise keep
 * the raw text. Returns the fence language to use alongside the body.
 */
function renderToolOutput(output: string): { body: string; lang: string } {
  const trimmed = output.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { body: JSON.stringify(JSON.parse(trimmed), null, 2), lang: 'json' }
    } catch {
      // Not valid JSON — fall through to raw.
    }
  }
  return { body: output, lang: '' }
}

/**
 * A list rendered as one segment (items joined with single newlines) so the
 * section separator in the body stays a blank line but list items don't
 * become separate paragraphs.
 */
function listSegment(header: string, items: string[]): string {
  if (items.length === 0) return ''
  return `${header}\n${items.join('\n')}`
}

/** Render one transcript entry into the markdown section list. */
function renderMessage(message: ExportMessage, out: string[]): void {
  switch (message.kind) {
    case 'user': {
      const text = (message.text ?? '').trim()
      if (!text) return
      out.push('## User', text)
      return
    }
    case 'assistant': {
      const text = (message.text ?? '').trim()
      const reasoning = (message.reasoning ?? '').trim()
      if (!text && !reasoning) return
      out.push('## Assistant')
      if (reasoning) {
        // Reasoning as a blockquote so it reads as model thinking, not output.
        const quoted = reasoning
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
        out.push(`> _Reasoning_\n${quoted}`)
      }
      if (text) out.push(text)
      return
    }
    case 'tool':
      renderToolMessage(message, out)
      return
    case 'file-changes': {
      const files = message.files ?? []
      if (files.length === 0) return
      out.push(
        listSegment(
          '**Changed files:**',
          files.map((f) =>
            f && typeof f.path === 'string' ? `- ${f.path} (${f.action ?? 'modified'})` : ''
          )
        )
      )
      return
    }
    case 'compaction': {
      const text = (message.text ?? '').trim()
      if (text) out.push(`> _${text}_`)
      return
    }
    case 'system': {
      // Persisted 'system' entries are error/interruption notices (upstream
      // renders its error variant with an `## Error` heading).
      const text = (message.text ?? '').trim()
      if (!text) return
      out.push('## Error', text)
      return
    }
    default: {
      // Unknown/legacy kinds: never silently drop text.
      const text = (message.text ?? '').trim()
      if (text) out.push(`> ${text}`)
      return
    }
  }
}

/** Render a `kind: 'tool'` transcript entry (tool call / sub-agent card). */
function renderToolMessage(message: ExportMessage, out: string[]): void {
  const tool = message.tool
  const name = tool?.toolName
  if (!name) return

  // Sub-agent bubble: the store flattens spawned agents into a `agent:<type>` card.
  if (name.startsWith('agent:') && tool.agentType) {
    const label = tool.agentName ?? tool.agentType
    out.push(`### ⤷ Subagent: ${label}${tool.agentName ? ` (${tool.agentType})` : ''}`)
    if (tool.detail?.trim()) out.push(tool.detail.trim())
    out.push('### ⤶ End subagent')
    return
  }

  // Tools executed inside a sub-agent carry the spawning agent's type — note
  // it so a flat transcript still shows where the call came from.
  if (tool.agentType) out.push(`> _subagent: ${tool.agentType}_`)

  const display = toolDisplayName(name)
  const inputText = renderToolInput(tool.toolInput)
  const hasInput = inputText.trim().length > 0
  const detail = tool.detail ?? ''
  const hasOutput = detail.trim().length > 0

  // write_todos → checklist (matches the UI's todo card) plus its result.
  if (name === 'write_todos' && Array.isArray(tool.todos)) {
    const items = tool.todos
      .filter((t): t is { task: string; completed?: boolean } => Boolean(t && typeof t.task === 'string'))
      .map((t) => `- ${t.completed ? '[x]' : '[ ]'} ${t.task}`)
    if (items.length > 0) out.push(listSegment('**Todo list**', items))
    if (hasOutput) {
      const rendered = renderToolOutput(detail)
      out.push(fence(rendered.body, rendered.lang))
    }
    return
  }

  // A tool call with no input and no output (e.g. still running) gets a
  // compact one-liner rather than a header with nothing beneath it.
  if (!hasInput && !hasOutput) {
    out.push(`**🛠 ${display}** _(no input or output)_`)
    return
  }

  out.push(`**🛠 ${display}**`)
  if (tool.blockedPaths?.length) {
    out.push(`> _Blocked by the sensitive-file filter: ${tool.blockedPaths.join(', ')}_`)
  }
  if (hasInput) out.push(fence(inputText, 'json'))
  if (hasOutput) {
    const rendered = renderToolOutput(detail)
    out.push(fence(rendered.body, rendered.lang))
  }
}

/** Role messages rendered under a `##` heading (what upstream counts). */
function isRoleMessage(message: ExportMessage): boolean {
  if (message.kind === 'user') return Boolean((message.text ?? '').trim())
  if (message.kind === 'assistant') return Boolean((message.text ?? '').trim() || (message.reasoning ?? '').trim())
  if (message.kind === 'system') return Boolean((message.text ?? '').trim())
  return false
}

/**
 * Serialize a full conversation transcript to Markdown. No size budget and no
 * whitespace normalization — a file export keeps every message, tool input
 * and tool result byte-for-byte.
 */
export function serializeConversationToMarkdown(messages: ExportMessage[]): SerializedConversation {
  const out: string[] = []
  for (const message of messages) {
    renderMessage(message, out)
  }
  const count = messages.filter(isRoleMessage).length
  const header = `# AnyBuff conversation\n_${count} message${count === 1 ? '' : 's'}_`
  const body = out.join('\n\n').trim()
  return { text: `${header}\n\n---\n\n${body}\n`, messageCount: count }
}

/**
 * Default file name for the save dialog: date prefix (exports sort naturally,
 * repeated exports never collide) + the task prompt slugged to a safe filename.
 */
export function suggestExportFileName(prompt: string, projectName?: string): string {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
  const base = (prompt || projectName || 'conversation').trim()
  const slug = base
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${date}-${slug || 'conversation'}.md`
}
