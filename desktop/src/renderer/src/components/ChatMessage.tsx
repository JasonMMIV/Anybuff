import { useState } from 'react'
import { renderMarkdown } from '../utils/markdown'
import {
  AlertCircleIcon,
  BoltIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CopyIcon,
  EditIcon,
  FileIcon,
  FolderIcon,
  GaugeIcon,
  LayersIcon,
  ListIcon,
  SparkIcon,
  PanelLeftIcon,
  PaperclipIcon,
  PlugIcon,
  RobotIcon,
  SearchIcon,
  SparklesIcon,
  SpecialistIcon,
  TerminalIcon,
  UndoIcon
} from './Icons'

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
  /** #12 工具具名卡片：lightweight tool-call params forwarded by the main process. */
  toolInput?: Record<string, unknown>
  /** #12 read_files 中被敏感檔過濾擋住的路徑（UI 畫刪除線 + blocked 徽章）。 */
  blockedPaths?: string[]
}

/* ─── #12 工具具名卡片：語意化標題規格表 ─── */

/** Monochrome SVG glyph per tool family (shown left of the title). */
function toolIcon(name: string): React.ReactNode {
  switch (name) {
    case 'read_files':
    case 'read_subtree':
    case 'find_files':
      return <FileIcon size={16} />
    case 'list_directory':
      return <FolderIcon size={16} />
    case 'code_search':
    case 'web_search':
      return <SearchIcon size={16} />
    case 'glob':
      return <FolderIcon size={16} />
    case 'read_url':
      return <PaperclipIcon size={16} />
    case 'read_docs':
      return <LayersIcon size={16} />
    case 'run_terminal_command':
    case 'basher':
      return <TerminalIcon size={16} />
    case 'edit_transaction':
    case 'apply_patch':
    case 'str_replace':
    case 'propose_str_replace':
    case 'write_file':
    case 'propose_write_file':
      return <EditIcon size={16} />
    case 'write_todos':
      return <ListIcon size={16} />
    case 'query_index':
    case 'gravity_index':
      return <GaugeIcon size={16} />
    case 'think_deeply':
      return <SparkIcon size={16} />
    case 'update_subgoal':
      return <CheckCircleIcon size={16} />
    case 'skill':
      return <SparklesIcon size={16} />
    case 'ask_user':
      return <AlertCircleIcon size={16} />
    case 'spawn_agents':
      return <RobotIcon size={16} />
    case 'render_ui':
      return <PanelLeftIcon size={16} />
    default:
      // MCP tools are exposed as `<server>__<tool>` — give them a distinct plug glyph.
      if (name.includes('__')) return <PlugIcon size={16} />
      return <BoltIcon size={16} />
  }
}

function toolLabel(name: string): string {
  switch (name) {
    case 'read_files': return 'Read files'
    case 'read_subtree': return 'Read subtree'
    case 'list_directory': return 'List directory'
    case 'find_files': return 'Find files'
    case 'code_search': return 'Code search'
    case 'glob': return 'Glob files'
    case 'web_search': return 'Web search'
    case 'read_url': return 'Read URL'
    case 'read_docs': return 'Read docs'
    case 'run_terminal_command': return 'Run command'
    case 'basher': return 'Run command'
    case 'edit_transaction': return 'Edit transaction'
    case 'apply_patch': return 'Apply patch'
    case 'str_replace': return 'Edit file'
    case 'propose_str_replace': return 'Propose edit'
    case 'write_file': return 'Write file'
    case 'propose_write_file': return 'Propose file'
    case 'write_todos': return 'To-dos'
    case 'query_index': return 'Query index'
    case 'think_deeply': return 'Think deeply'
    case 'update_subgoal': return 'Update subgoal'
    case 'skill': return 'Load skill'
    case 'gravity_index': return 'Gravity index'
    case 'ask_user': return 'Ask user'
    case 'spawn_agents': return 'Spawn agents'
    case 'render_ui': return 'Render UI'
    default:
      // MCP tools: `context7__fetch_docs` → `context7 · fetch docs`
      const sep = name.indexOf('__')
      if (sep > 0) {
        const server = name.slice(0, sep)
        const tool = name.slice(sep + 2).replace(/_/g, ' ')
        return `${server} · ${tool}`
      }
      return name.replace(/_/g, ' ')
  }
}

/** #12 樣式 B：常駐摘要 chips — the display-relevant tool-call facts. */
function toolSummaryChips(tool: ToolItem): { text: string; blocked?: boolean }[] {
  const input = tool.toolInput ?? {}
  const chips: { text: string; blocked?: boolean }[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) chips.push({ text: v })
  }
  switch (tool.toolName) {
    case 'read_files':
    case 'read_subtree': {
      const paths = Array.isArray(input.paths) ? (input.paths as string[]) : []
      const blocked = new Set(tool.blockedPaths ?? [])
      if (paths.length === 0) return []
      for (const p of paths) {
        chips.push({ text: p, blocked: blocked.has(p) })
      }
      return chips
    }
    case 'list_directory':
      push(input.path)
      return chips
    case 'glob':
      push(input.pattern)
      return chips
    case 'find_files':
      push(input.prompt)
      return chips
    case 'code_search':
      push(input.pattern)
      push(input.flags)
      push(input.cwd)
      return chips
    case 'web_search':
      push(input.query)
      return chips
    case 'read_url':
      push(input.url)
      return chips
    case 'read_docs':
      push(input.libraryTitle)
      push(input.topic)
      return chips
    case 'run_terminal_command':
    case 'basher':
      push(input.command)
      return chips
    case 'write_file':
    case 'propose_write_file':
    case 'str_replace':
    case 'propose_str_replace':
      push(input.path)
      return chips
    case 'apply_patch':
      push(input.path)
      return chips
    case 'edit_transaction': {
      const paths = Array.isArray(input.editPaths) ? (input.editPaths as string[]) : []
      for (const p of paths) chips.push({ text: p })
      return chips
    }
    case 'think_deeply':
      push(input.thought)
      return chips
    case 'update_subgoal':
      push(input.id)
      return chips
    case 'skill':
      push(input.name)
      return chips
    case 'gravity_index':
      push(input.action)
      push(input.query ?? input.slug)
      return chips
    case 'spawn_agents': {
      const types = Array.isArray(input.agentTypes) ? (input.agentTypes as string[]) : []
      if (types.length > 0) chips.push({ text: types.join(', ') })
      return chips
    }
    case 'ask_user':
      if (typeof input.questions === 'number') chips.push({ text: `${input.questions} questions` })
      return chips
    case 'write_todos': {
      const done = tool.todos?.filter((t) => t.completed).length ?? 0
      const total = tool.todos?.length ?? 0
      if (total > 0) chips.push({ text: `${done}/${total} completed` })
      return chips
    }
    default:
      return []
  }
}

/** #12 結果數 chip：從已完成工具的 detail/output 提取簡短計數（code_search / glob / web_search…）。 */
function toolResultCount(tool: ToolItem): string | null {
  if (tool.status !== 'done' || typeof tool.detail !== 'string') return null
  const d = tool.detail.trim()
  // m[2] is the unit ("matches"/"results"/…). The group MUST be capturing:
  // the original non-capturing (?:…) made m[2] always undefined and crashed
  // with 'Cannot read properties of undefined (reading toLowerCase)' whenever
  // a detail contained "N matches/results" (e.g. inside JSON payloads).
  const m = d.match(/(\d+)\s+(matches?|results?|files?|snippets?)/i)
  return m && m[2] ? `${m[1]} ${m[2].toLowerCase()}` : null
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {})
}

/** #21 訊息 footer 完成時間戳：同天顯示 HH:MM，跨天補上日期。 */
function formatMsgTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const sameDay = d.toDateString() === new Date().toDateString()
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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
  // Legacy transcripts may carry assistant items without a text field — never crash on them.
  if (typeof rawText !== 'string') return { text: '', isThinking: false }
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

  // Legacy transcripts may omit optional fields — never crash on them.
  const name = tool.toolName ?? 'tool'
  const isAgentCard = name.startsWith('agent:')

  const hasDetail = Boolean(tool.detail?.trim())
  const hasTodos = name === 'write_todos' && Array.isArray(tool.todos) && tool.todos.length > 0
  // Skip parsing/formatting entirely while the card stays collapsed
  const webResults = open && hasDetail && isSearchTool(name) ? parseWebResults(tool.detail ?? '') : null
  const formattedDetail = open && hasDetail && !webResults && !hasTodos ? formatToolDetail(tool.detail ?? '') : null

  // For write_todos: show a summary in the header and render the checklist inline
  const todoSummary = hasTodos
    ? `${tool.todos!.filter((t) => t.completed).length}/${tool.todos!.length} completed`
    : ''

  const label = isAgentCard
    ? `Sub-agent: ${tool.agentName || name.slice('agent:'.length)}`
    : toolLabel(name)

  // #12 樣式 B：常駐語意化標題（icon + label + agent）與摘要 chips。
  // 摘要 chips 直接併入標題列：只顯示前 3 個，其餘收斂為「+N」，單行 ellipsis。
  const icon = isAgentCard ? <SpecialistIcon size={16} /> : toolIcon(name)
  const chips = isAgentCard ? [] : toolSummaryChips(tool)
  const visibleChips = chips.slice(0, 3)
  const hiddenChips = chips.length - visibleChips.length
  const resultCount = toolResultCount(tool)
  const blockedCount = tool.blockedPaths?.length ?? 0
  const allowedCount =
    name === 'read_files' && Array.isArray(tool.toolInput?.paths)
      ? (tool.toolInput.paths as string[]).length - blockedCount
      : null

  return (
    <div className={`tool-card ${tool.status}${running ? ' running' : ''}`}>
      <div className="tool-card-head" onClick={() => setOpen((o) => !o)}>
        {running && <span className="tool-spinner">⟳</span>}
        <span className="tool-icon" aria-hidden="true">{icon}</span>
        <span className="tool-name">{label}</span>
        {tool.agentType && <span className="tool-agent">{tool.agentType}</span>}
        {visibleChips.length > 0 && !hasTodos && (
          <span className="tool-summary" aria-label="tool-call-summary">
            {visibleChips.map((c, i) => (
              <span key={i} className={`chip${c.blocked ? ' blocked-chip' : ''}`}>
                {c.blocked ? (
                  <>
                    <s className="blocked">{c.text}</s>
                    <span className="blocked-badge">blocked</span>
                  </>
                ) : (
                  c.text
                )}
              </span>
            ))}
            {hiddenChips > 0 && <span className="chip chip-more">+{hiddenChips}</span>}
          </span>
        )}
        {hasTodos && <span className="todo-summary-badge">{todoSummary}</span>}
        {tool.status === 'running' && <span className="tool-status-text">Running…</span>}
        {tool.status === 'error' && <span className="tool-status-text error">Failed</span>}
        {!running && tool.status === 'done' && (resultCount || allowedCount !== null) && (
          <span className="tool-result-count">
            {allowedCount !== null ? `${allowedCount}/${allowedCount + blockedCount} allowed` : resultCount}
          </span>
        )}
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
        <span className="thought-icon"><SparkIcon size={14} /></span>
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

export function UserBubble({ text, onCopy, onRevert, ts }: { text: string; onCopy?: () => void; onRevert?: () => void; ts?: number }) {
  return (
    <div className="msg-row user">
      <div className="msg-stack user">
        <div className="user-bubble">
          <span className="user-text">{text}</span>
        </div>
        {(ts || onCopy || onRevert) && (
          <span className="msg-footer" onClick={(e) => e.stopPropagation()}>
            {ts && <span className="msg-time">{formatMsgTime(ts)}</span>}
            {(onCopy || onRevert) && (
              <span className="msg-actions">
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
  onCopy,
  ts
}: {
  text: string
  reasoning?: string
  streaming: boolean
  onCopy?: () => void
  ts?: number
}) {
  const extracted = extractThinkTags(text)
  const combinedReasoning = [reasoning?.trim(), extracted.reasoning?.trim()].filter(Boolean).join('\n\n')
  const mainText = extracted.text
  const isReasoningOnly = streaming && !mainText.trim() && Boolean(combinedReasoning || extracted.isThinking)
  // #24 純思考訊息（只有 thinking 卡、無文字氣泡）＝與工具卡同類的過程回饋：
  // 縮緊行距與工具卡一致（chat-scroll gap 6px + 卡片自身邊距），不加　margin-bottom。
  const thoughtOnly = !mainText.trim() && Boolean(combinedReasoning)

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
    <div className={`msg-row assistant${thoughtOnly ? ' thought-only' : ''}`}>
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
        {(ts || onCopy) && mainText.trim() && (
          <span className="msg-footer" onClick={(e) => e.stopPropagation()}>
            {ts && <span className="msg-time">{formatMsgTime(ts)}</span>}
            {onCopy && (
              <span className="msg-actions">
                <button className="mini-btn" title="Copy" onClick={onCopy}>
                  <CopyIcon size={12} />
                </button>
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
