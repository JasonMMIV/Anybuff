import { useState } from 'react'
import { renderMarkdown } from '../utils/markdown'
import { ChevronDownIcon, CopyIcon, LightbulbIcon, ListIcon, TriangleIcon, UndoIcon } from './Icons'

export interface TodoTodo {
  task: string
  completed: boolean
}

export interface ToolItem {
  toolName: string
  status: 'running' | 'done' | 'error'
  agentType?: string
  /** Human-readable agent name; sub-agent cards title as `Sub-agent: <agentName ?? agentType>`. */
  agentName?: string
  detail?: string
  todos?: TodoTodo[]
}

function toolLabel(name: string): string {
  switch (name) {
    case 'read_files': return 'Read files'
    case 'edit_transaction': return 'Edit transaction'
    case 'web_search': return 'Web search'
    case 'query_index': return 'Query index'
    case 'basher': return 'Run command'
    case 'run_terminal_command': return 'Terminal command'
    default: return name.replace(/_/g, ' ')
  }
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {})
}

/** Render markdown; code blocks carry a copy button (part of the HTML, delegated click). */
export function Markdown({ text }: { text: string }) {
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('.code-copy')
    if (!target) return
    const pre = (target as HTMLElement).closest('pre')
    if (pre) {
      const clone = pre.cloneNode(true) as HTMLElement
      clone.querySelector('.code-copy')?.remove()
      copyText(clone.textContent ?? '')
      target.classList.add('copied')
      setTimeout(() => target.classList.remove('copied'), 1200)
    }
  }

  return (
    <div
      className="markdown"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  )
}

export interface WebResult {
  title: string
  url?: string
  snippet?: string
}

/** Extract <think>...</think> blocks and strip any leaked function calls from raw text. */
export function extractThinkTags(rawText: string): { reasoning?: string; text: string; isThinking: boolean } {
  // Strip any raw function:suggest_followups blocks from visible assistant text
  let cleanedText = rawText.replace(/function:suggest_followups\s*\{[\s\S]*?\}/gi, '')
  cleanedText = cleanedText.replace(/<suggest_followups>[\s\S]*?<\/suggest_followups>/gi, '')

  if (!cleanedText.includes('<think>')) {
    return { text: cleanedText.trim(), isThinking: false }
  }

  const thinkEndIndex = cleanedText.indexOf('</think>')
  if (thinkEndIndex !== -1) {
    const thinkStart = cleanedText.indexOf('<think>')
    const reasoning = cleanedText.slice(thinkStart + '<think>'.length, thinkEndIndex).trim()
    const text = (cleanedText.slice(0, thinkStart) + cleanedText.slice(thinkEndIndex + '</think>'.length)).trim()
    return { reasoning: reasoning || undefined, text, isThinking: false }
  } else {
    const thinkStart = cleanedText.indexOf('<think>')
    const reasoning = cleanedText.slice(thinkStart + '<think>'.length)
    const text = cleanedText.slice(0, thinkStart).trim()
    return { reasoning: reasoning || undefined, text, isThinking: true }
  }
}
/** Try to extract search results from a tool output string (web_search / researcher tools). */
function parseWebResults(detail: string): WebResult[] | null {
  const candidates: unknown[] = []
  try {
    const parsed = JSON.parse(detail)
    if (Array.isArray(parsed)) candidates.push(...parsed)
    else if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>
      const dataRec = rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : undefined
      const arr = rec.results ?? rec.items ?? rec.sources ?? dataRec?.sources
      if (Array.isArray(arr)) candidates.push(...arr)
      else candidates.push(parsed)
    }
  } catch {
    // Not JSON — maybe raw text with lines
    return null
  }
  const results = candidates
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
    .map((c) => ({
      title: String(c.title ?? c.name ?? ''),
      url: String(c.url ?? c.link ?? c.href ?? ''),
      snippet: String(c.snippet ?? c.description ?? c.text ?? '')
    }))
    .filter((r) => r.title || r.url)
  return results.length > 0 ? results.slice(0, 8) : null
}

function isSearchTool(name: string): boolean {
  const n = name.toLowerCase()
  return n.includes('web_search') || n.includes('search') || n.includes('researcher')
}

/** Clean up raw tool detail strings (e.g. format JSON nicely). */
function formatToolDetail(detail: string): string {
  const trimmed = detail.trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      // Check if it's an error message object
      if (typeof parsed.errorMessage === 'string') {
        return parsed.errorMessage
      }
      if (typeof parsed.error === 'string') {
        return parsed.error
      }
      if (typeof parsed.message === 'string') {
        return parsed.message
      }
      // Check if it's a file_mutation_result from edit_transaction
      if (parsed.kind === 'file_mutation_result' && Array.isArray(parsed.actions)) {
        return parsed.actions
          .map((a: Record<string, unknown>) => {
            const act = String(a.action || 'modified')
            const path = String(a.path || '')
            const outcome = String(a.outcome || 'applied')
            return `${act === 'create' ? 'Created' : act === 'delete' ? 'Deleted' : 'Modified'} ${path} (${outcome})`
          })
          .join('\n')
      }
      // Check if it's an agentReceipt or spawn report array
      if (Array.isArray(parsed)) {
        if (parsed[0]?.agentReceipt) {
          return parsed
            .map((item) => {
              const r = item.agentReceipt
              const changed =
                Array.isArray(r?.changedFiles) && r.changedFiles.length > 0
                  ? ` (${r.changedFiles.length} files changed)`
                  : ''
              return `Agent: ${item.agentName || item.agentType || 'specialist'}\nStatus: ${r?.status || 'completed'}${changed}`
            })
            .join('\n\n')
        }
        if (parsed[0]?.validationStatus) {
          return parsed
            .map((item) => item.message || item.validationStatus || '')
            .filter(Boolean)
            .join('\n')
        }
      }
      return JSON.stringify(parsed, null, 2)
    }
  } catch {
    // Plain text
  }
  return detail
}

/** Render a todo checklist from a list of TodoTodo items. */
export function TodoCard({ todos, collapsed, onToggleCollapse, inline }: { todos: TodoTodo[]; collapsed?: boolean; onToggleCollapse?: () => void; inline?: boolean }) {
  if (!todos || todos.length === 0) return null
  const done = todos.filter((t) => t.completed).length
  return (
    <div className={`todo-card${collapsed ? ' collapsed' : ''}`}> 
      {!inline && (
        <div className="todo-header" onClick={onToggleCollapse} style={onToggleCollapse ? { cursor: 'pointer' } : undefined}>
          <span className="todo-list-icon"><ListIcon size={16} /></span>
          <span className="todo-title">To-dos</span>
          <span className="todo-progress">{done}/{todos.length}</span>
          {onToggleCollapse && <span className="todo-toggle"><ChevronDownIcon size={14} className={collapsed ? 'todo-chevron-collapsed' : ''} /></span>}
        </div>
      )}
      {!collapsed && (
        <ul className="todo-list">
          {todos.map((item, i) => (
            <li key={i} className={`todo-item${item.completed ? ' done' : ''}`}>
              <span className="todo-check">
                {item.completed ? '✓' : '○'}
              </span>
              <span className="todo-text">{item.task}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ToolCard({ tool, isLast }: { tool: ToolItem; isLast: boolean }) {
  const running = tool.status === 'running' && isLast
  // Collapsed by default; click the header to expand the output
  const [open, setOpen] = useState(false)

  const hasDetail = Boolean(tool.detail?.trim())
  const hasTodos = tool.toolName === 'write_todos' && Array.isArray(tool.todos) && tool.todos.length > 0
  // Skip parsing/formatting entirely while the card stays collapsed
  const webResults = open && hasDetail && isSearchTool(tool.toolName) ? parseWebResults(tool.detail ?? '') : null
  const formattedDetail = open && hasDetail && !webResults && !hasTodos ? formatToolDetail(tool.detail ?? '') : null

  // For write_todos: show a summary in the header and render the checklist inline
  const todoSummary = hasTodos
    ? `${tool.todos!.filter((t) => t.completed).length}/${tool.todos!.length} completed`
    : ''

  const label = tool.toolName.startsWith('agent:')
    ? `Sub-agent: ${tool.agentName || tool.toolName.slice('agent:'.length)}`
    : toolLabel(tool.toolName)

  return (
    <div className={`tool-card ${tool.status}${running ? ' running' : ''}`}>
      <div className="tool-card-head" onClick={() => setOpen((o) => !o)}>
        {running ? (
          <span className="tool-spinner">⟳</span>
        ) : (
          <span className="tool-toggle">
            <TriangleIcon open={open} size={9} />
          </span>
        )}
        <span className="tool-name">{label}</span>
        {tool.agentType && <span className="tool-agent">{tool.agentType}</span>}
        {hasTodos && <span className="todo-summary-badge">{todoSummary}</span>}
        {tool.status === 'running' && <span className="tool-status-text">Running…</span>}
        {tool.status === 'error' && <span className="tool-status-text error">Failed</span>}
      </div>
      {hasTodos && open ? (
        <TodoCard todos={tool.todos!} inline />
      ) : open && hasDetail ? (
        <div className="tool-detail-wrap">
          {webResults ? (
            <div className="web-results">
              {webResults.map((r, i) => (
                <a
                  key={i}
                  className="web-result"
                  href={r.url || undefined}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="web-title">{r.title || r.url}</span>
                  {r.snippet && <span className="web-snippet">{r.snippet.slice(0, 220)}</span>}
                  {r.url && <span className="web-url">{r.url}</span>}
                </a>
              ))}
            </div>
          ) : (
            <pre className="tool-detail">{formattedDetail}</pre>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Collapsible thought process (reasoning / <think>) block */
export function ThoughtBlock({
  reasoning,
  streaming
}: {
  reasoning: string
  streaming: boolean
}) {
  // Collapsed by default; clicking the header expands it.
  const [open, setOpen] = useState(false)

  const trimmed = reasoning.trim()
  if (!trimmed && !streaming) return null

  return (
    <div className={`thought-block ${streaming ? 'thinking' : 'done'}`}>
      <div
        className="thought-head"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="thought-icon"><LightbulbIcon size={14} /></span>
        <span className="thought-label">{streaming ? 'Thinking…' : 'Thinking'}</span>
      </div>
      {open && (
        <div className="thought-content">
          <div className="thought-text">{trimmed}</div>
          {streaming && <span className="caret" />}
        </div>
      )}
    </div>
  )
}

export function UserBubble({ text, onCopy, onRevert }: { text: string; onCopy?: () => void; onRevert?: () => void }) {
  return (
    <div className="msg-row user">
      <div className="msg-stack user">
        <div className="user-bubble">
          <span className="user-text">{text}</span>
        </div>
        {(onCopy || onRevert) && (
          <span className="msg-actions" onClick={(e) => e.stopPropagation()}>
            {onCopy && (
              <button className="mini-btn" title="Copy" onClick={onCopy}>
                <CopyIcon size={12} />
              </button>
            )}
            {onRevert && (
              <button className="mini-btn danger" title="Revert file changes and restore this message for editing" onClick={onRevert}>
                <UndoIcon size={12} />
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

export function AssistantBubble({
  text,
  reasoning,
  streaming,
  onCopy
}: {
  text: string
  reasoning?: string
  streaming: boolean
  onCopy?: () => void
}) {
  const extracted = extractThinkTags(text)
  const combinedReasoning = [reasoning?.trim(), extracted.reasoning?.trim()].filter(Boolean).join('\n\n')
  const mainText = extracted.text
  const isReasoningOnly = streaming && !mainText.trim() && Boolean(combinedReasoning || extracted.isThinking)

  if (!mainText.trim() && !combinedReasoning && streaming) {
    return (
      <div className="msg-row assistant">
        <div className="thinking-dots">
          <span />
          <span />
          <span />
        </div>
      </div>
    )
  }

  return (
    <div className="msg-row assistant">
      <div className="msg-stack assistant">
        {combinedReasoning && (
          <ThoughtBlock
            reasoning={combinedReasoning}
            streaming={streaming && (!mainText.trim() || extracted.isThinking)}
          />
        )}
        {(mainText.trim() || !combinedReasoning) && (
          <div className="assistant-bubble">
            <Markdown text={mainText} />
            {streaming && !isReasoningOnly && <span className="caret" />}
          </div>
        )}
        {onCopy && mainText.trim() && (
          <span className="msg-actions" onClick={(e) => e.stopPropagation()}>
            <button className="mini-btn" title="Copy" onClick={onCopy}>
              <CopyIcon size={12} />
            </button>
          </span>
        )}
      </div>
    </div>
  )
}
