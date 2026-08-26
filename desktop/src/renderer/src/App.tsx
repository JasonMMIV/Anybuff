import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AskUserBanner from './components/AskUserBanner'
import Sidebar, { type ProjectRecord, type TaskRecord, type SearchResult } from './components/Sidebar'
import RightPanel, { type RightTab } from './components/RightPanel'
import SettingsModal from './components/SettingsModal'
import AgentWizardModal from './components/AgentWizardModal'
import Composer, { type AgentMode, type Attachment, type SkillInfo } from './components/Composer'
import MessageQueuePanel, { type QueuedMessage } from './components/MessageQueuePanel'
import { AssistantBubble, TodoCard, ToolCard, UserBubble, type TodoTodo, type ToolItem } from './components/ChatMessage'
import { FileChangesSummary, type FileChange } from './components/FileChangesSummary'
import {
  AlertCircleIcon,
  AppIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  InfoIcon,
  PanelLeftIcon,
  PanelRightIcon,
  WindowMinimizeIcon,
  WindowMaximizeIcon,
  WindowRestoreIcon,
  WindowCloseIcon
} from './components/Icons'
import type { TreeNode } from './components/FileTree'
import type { UiEvent } from '../../preload'

interface UiSettings {
  providers: { id: string; label: string; models: string[] }[]
  activeModel: string
  reasoningEffort: string
  approvalMode: string
}

type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; reasoning?: string }
  | { kind: 'tool'; tool: ToolItem }
  | { kind: 'file-changes'; files: FileChange[] }
  | { kind: 'compaction'; text: string }
  | { kind: 'system'; text: string }

/** Silent background polling / internal tools that should be hidden from the UI timeline */
function isSilentTool(name?: string): boolean {
  if (!name) return false
  const n = name.toLowerCase().trim()
  return (
    n === 'git_status' ||
    n === 'suggest_followups' ||
    n === 'check_job' ||
    n === 'check_background_agent' ||
    n === 'list_jobs' ||
    n === 'end_turn' ||
    n === 'add_message' ||
    n === 'set_messages' ||
    n === 'set_output' ||
    n === 'spawn_agents' ||
    n === 'spawn_agent_inline' ||
    n === 'run_file_change_hooks' ||
    n === 'run_targeted_validation'
  )
}

const DEFAULT_PROMPT_HEIGHT = 44
const MAX_PROMPT_HEIGHT = 160

// Browser preview mode: renders the full UI with mock data when Electron preload is absent
const IS_PREVIEW = typeof window.AnyBuff === 'undefined'

/** Human-readable banner text per failure reason. */
function resumeBannerText(reason: string | undefined): string {
  switch (reason) {
    case 'stopped':
      return 'This run was stopped — your progress and conversation are preserved.'
    case 'rate-limit':
      return 'The model API rate limit or quota was exceeded — your progress and conversation are preserved.'
    case 'auth':
      return 'Authentication failed (check your API key) — your progress and conversation are preserved.'
    case 'timeout':
      return 'The run timed out — your progress and conversation are preserved.'
    case 'network':
      return 'A network error interrupted the run — your progress and conversation are preserved.'
    default:
      return 'This run was interrupted — your progress and conversation are preserved.'
  }
}

const RETRY_REASON_LABELS: Record<string, string> = {
  network: 'Network error',
  timeout: 'Request timed out',
  'rate-limit': 'Rate limit exceeded'
}

/** Live countdown line for the in-chat auto-retry strip. */
function autoRetryStripText(
  notice: { attempt: number; maxAttempts: number; nextAt: number; reason?: string },
  now: number
): string {
  const label = RETRY_REASON_LABELS[notice.reason ?? ''] ?? 'Temporary issue'
  const remaining = Math.max(0, Math.ceil((notice.nextAt - now) / 1000))
  if (remaining <= 0) return `${label} — retrying now…`
  return `${label} — retrying in ${remaining}s (attempt ${notice.attempt} of ${notice.maxAttempts})`
}

const PREVIEW_SETTINGS: UiSettings = {
  providers: [
    { id: 'openai', label: 'OpenAI API', models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] },
    { id: 'anthropic', label: 'Anthropic API', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] }
  ],
  activeModel: 'openai/gpt-5.5',
  reasoningEffort: 'default',
  approvalMode: 'balanced'
}

const PREVIEW_SKILLS: SkillInfo[] = [
  { name: 'meta', description: 'Broad project-level implementation and validation heuristics', path: '', source: 'project' },
  { name: 'refactor', description: 'Safely restructure code with minimal behavior change', path: '', source: 'home' }
]

const PREVIEW_ITEMS: ChatItem[] = [
  { kind: 'user', text: 'Add zero-division error handling to the divide function' },
  {
    kind: 'assistant',
    text: 'Let me look at the current `calculator.js` before planning the change.\n\n```js\n// src/calculator.js\nexport function divide(a, b) {\n  return a / b\n}\n```\n\nThis function divides directly, so it returns `Infinity` when `b` is 0. I\'ll add an explicit zero-division check.'
  },
  { kind: 'tool', tool: { toolName: 'edit_transaction', status: 'done', agentType: 'editor', detail: 'applied 1 edit: src/calculator.js\n+  if (b === 0) {\n+    throw new RangeError(\'Cannot divide by zero\')\n+  }' } },
  {
    kind: 'assistant',
    text: 'Done:\n\n- `divide` now throws a `RangeError` when the divisor is 0\n- The original calculation logic is preserved\n\n```js\nexport function divide(a, b) {\n  if (b === 0) {\n    throw new RangeError(\'Cannot divide by zero\')\n  }\n  return a / b\n}\n```'
  },
  { kind: 'file-changes', files: [
    { path: 'src/calculator.js', action: 'modify' as const },
    { path: 'src/utils.js', action: 'create' as const }
  ] }
]

function flattenTree(nodes: TreeNode[], cwd: string): string[] {
  const out: string[] = []
  for (const n of nodes) {
    const rel = n.path.replace(cwd, '').replace(/^[\\/]+/, '')
    if (!rel) continue
    const display = rel.split('\\').join('/')
    if (n.type === 'file') out.push(display)
    if (n.children) out.push(...flattenTree(n.children, cwd))
  }
  return out
}

function absPath(cwd: string, rel: string): string {
  const sep = cwd.includes('\\') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export interface FollowupItem {
  prompt: string
  label?: string
}

/** Extract next-step suggestions from the suggest_followups tool output or raw text. */
function parseFollowups(message: unknown): FollowupItem[] {
  if (!message) return []
  const out: FollowupItem[] = []

  const collectItem = (item: unknown): void => {
    if (!item) return
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (trimmed.length > 2) {
        out.push({ prompt: trimmed, label: trimmed })
      }
    } else if (typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const prompt =
        typeof rec.prompt === 'string'
          ? rec.prompt.trim()
          : typeof rec.text === 'string'
            ? rec.text.trim()
            : ''
      const label =
        typeof rec.label === 'string'
          ? rec.label.trim()
          : typeof rec.title === 'string'
            ? rec.title.trim()
            : prompt
      if (prompt) {
        out.push({ prompt, label: label || prompt })
      } else if (Array.isArray(rec.followups)) {
        rec.followups.forEach(collectItem)
      } else if (Array.isArray(rec.suggestions)) {
        rec.suggestions.forEach(collectItem)
      } else if (Array.isArray(rec.items)) {
        rec.items.forEach(collectItem)
      }
    }
  }

  if (typeof message === 'object') {
    if (Array.isArray(message)) {
      message.forEach(collectItem)
    } else {
      collectItem(message)
    }
  } else if (typeof message === 'string') {
    const raw = message.trim()
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        return parseFollowups(parsed)
      } catch {
        const fnMatch =
          raw.match(/function:suggest_followups\s*(\{[\s\S]*?\})/i) ||
          raw.match(/<suggest_followups>([\s\S]*?)<\/suggest_followups>/i)
        if (fnMatch) {
          try {
            const parsed = JSON.parse(fnMatch[1])
            return parseFollowups(parsed)
          } catch {}
        }
      }

      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*(?:[-*•\d.)]+\s+)?"?([^"]{4,})"?\s*$/)
        if (m && !/^\s*$/.test(m[1])) {
          const text = m[1].trim()
          if (text && !text.toLowerCase().startsWith('function:') && !text.startsWith('{')) {
            out.push({ prompt: text, label: text })
          }
        }
      }
    }
  }

  // Deduplicate by prompt
  const seen = new Set<string>()
  const deduped: FollowupItem[] = []
  for (const item of out) {
    if (!seen.has(item.prompt)) {
      seen.add(item.prompt)
      deduped.push(item)
    }
  }

  return deduped.slice(0, 6)
}

/** Derive the current execution stage from recent tool/sub-agent activity. */
function deriveStage(events: UiEvent[], running: boolean): string | null {
  if (!running) return null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const name = (e.toolName ?? e.agentType ?? '').toLowerCase()
    if (e.type === 'subagent_start' || e.type === 'tool_start' || e.type === 'tool_call') {
      if (/planner|think|plan/.test(name)) return 'Planning'
      if (/editor|write|implement|create_file/.test(name)) return 'Editing'
      if (/review|critic/.test(name)) return 'Reviewing'
      if (/bash|test|typecheck|build|lint|validate/.test(name)) return 'Validating'
      if (/search|picker|research|reader|read_|list_|query/.test(name)) return 'Researching'
    }
  }
  return 'Working'
}

export type ColorTheme = 'default' | 'black' | 'grey' | 'vermillion' | 'amber' | 'teal'

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('AnyBuff-theme')
    return saved === 'light' ? 'light' : 'dark'
  })
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() => {
    const saved = localStorage.getItem('AnyBuff-color-theme') as ColorTheme | null
    return saved || 'default'
  })
  const [cwd, setCwd] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [branch, setBranch] = useState('')
  const [hasProvider, setHasProvider] = useState(false)
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  /** #2 執行中訊息佇列：messages parked while a run is in flight. */
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [chatItems, setChatItems] = useState<ChatItem[]>([])
  const [events, setEvents] = useState<UiEvent[]>([])
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string; name: string } | null>(null)

  const [settings, setSettings] = useState<UiSettings>({ providers: [], activeModel: '', reasoningEffort: 'default', approvalMode: 'balanced' })
  const [agentMode, setAgentMode] = useState<AgentMode>('default')
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [fileCandidates, setFileCandidates] = useState<string[]>([])

  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(false)
  const [rightTab, setRightTab] = useState<RightTab>('activity')

  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'general' | 'providers' | 'theme' | 'routing' | 'agents'>('general')
  const [showAgentWizard, setShowAgentWizard] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [tokenUsage, setTokenUsage] = useState<{ used: number; max: number } | null>(null)
  const [totalCost, setTotalCost] = useState(0)

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [followups, setFollowups] = useState<FollowupItem[]>([])
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [historyTask, setHistoryTask] = useState<{ id: string; prompt: string } | null>(null)
  const [historyResults, setHistoryResults] = useState<SearchResult[]>([])
  const [pendingJump, setPendingJump] = useState<{ taskId?: string; index: number } | null>(null)
  const [pendingRevert, setPendingRevert] = useState<{ files: string[]; lastUserIdx: number; lastUserText: string } | null>(null)
  const [focusSignal, setFocusSignal] = useState(0)
  /** Set when the last run failed (stopped, API error, timeout) but its state was preserved. */
  const [resumeInfo, setResumeInfo] = useState<{ prompt: string; reason?: string; errorMessage?: string } | null>(null)
  /** Live auto-retry countdown for a transient failure (network/timeout/rate-limit). Transient only. */
  const [retryNotice, setRetryNotice] = useState<{
    attempt: number
    maxAttempts: number
    nextAt: number
    reason?: string
    headline?: string
    detail?: string
  } | null>(null)
  /** Ticking clock so the retry strip shows a live countdown. */
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [approvalRequest, setApprovalRequest] = useState<{ message: string; raw?: unknown } | null>(null)
  // ask_user override: questions awaiting user answers (rendered as a banner)
  const [pendingAskUser, setPendingAskUser] = useState<Array<Record<string, any>> | null>(null)
  const [askSelections, setAskSelections] = useState<Record<number, string[]>>({})
  const [askOther, setAskOther] = useState<Record<number, string>>({})
  const [activeTodos, setActiveTodos] = useState<TodoTodo[]>([])
  const [todoPanelCollapsed, setTodoPanelCollapsed] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(100)
  /** The conversation that owns the active agent run (may differ from the view). */
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null)
  /** Reactive mirror of currentTaskRef — which conversation is displayed. */
  const [activeViewTaskId, setActiveViewTaskId] = useState<string | null>(null)

  /** View state: which conversation is displayed (also the event-routing key). */
  const currentTaskRef = useRef<string | null>(null)
  /** Keep the ref and its reactive mirror in sync at every view switch. */
  const setViewTask = useCallback((id: string | null) => {
    currentTaskRef.current = id
    setActiveViewTaskId(id)
  }, [])
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const toolIndexRef = useRef(-1)
  const changedFilesRef = useRef<string[]>([])
  const accumulatedFileChangesRef = useRef<FileChange[]>([])
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const msgRefs = useRef<(HTMLDivElement | null)[]>([])

  // Theme switch
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('AnyBuff-theme', theme)
    if (!IS_PREVIEW) window.AnyBuff.setTheme(theme)
  }, [theme])

  // Color theme switch
  useEffect(() => {
    document.documentElement.dataset.colorTheme = colorTheme
    localStorage.setItem('AnyBuff-color-theme', colorTheme)
  }, [colorTheme])

  // Window maximize state (frameless title bar)
  useEffect(() => {
    if (IS_PREVIEW) return
    void window.AnyBuff.windowIsMaximized().then(setIsMaximized)
    const unsub = window.AnyBuff.onWindowMaximizeChange(setIsMaximized)
    return unsub
  }, [])



  const reloadPage = useCallback(() => {
    if (IS_PREVIEW) return
    window.AnyBuff.windowReload()
  }, [])

  const forceReloadPage = useCallback(() => {
    if (IS_PREVIEW) return
    window.AnyBuff.windowForceReload()
  }, [])

  const zoomIn = useCallback(() => {
    if (IS_PREVIEW) return
    setZoomLevel((prev) => {
      const next = Math.min(prev + 10, 300)
      window.AnyBuff.setZoomFactor(next / 100)
      return next
    })
  }, [])

  const zoomOut = useCallback(() => {
    if (IS_PREVIEW) return
    setZoomLevel((prev) => {
      const next = Math.max(prev - 10, 30)
      window.AnyBuff.setZoomFactor(next / 100)
      return next
    })
  }, [])

  const resetZoom = useCallback(() => {
    if (IS_PREVIEW) return
    setZoomLevel(100)
    window.AnyBuff.setZoomFactor(1)
  }, [])

  const toggleFullScreen = useCallback(() => {
    if (IS_PREVIEW) return
    window.AnyBuff.windowToggleFullScreen()
  }, [])

  // Auto-dismiss notice
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => {
        setNotice(null)
      }, 4000)
      return () => clearTimeout(timer)
    }
  }, [notice])

  // Close the project selector when clicking elsewhere
  useEffect(() => {
    if (!projectMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [projectMenuOpen])

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])

  // Initial state
  useEffect(() => {
    if (IS_PREVIEW) {
      setCwd('~/demo-project')
      setProjectName('demo-project')
      setBranch('main')
      setHasProvider(true)
      setSettings(PREVIEW_SETTINGS)
      setProjects([
        {
          path: '~/demo-project',
          name: 'demo-project',
          tasks: [
            {
              id: 't1',
              prompt: 'Add zero-division error handling to the divide function',
              createdAt: Date.now() - 3600_000,
              messages: [
                { kind: 'user', text: 'Add zero-division error handling to the divide function' },
                {
                  kind: 'assistant',
                  text: 'Done — `divide` now throws a `RangeError` when the divisor is 0, and the original calculation logic is preserved.'
                }
              ]
            }
          ]
        }
      ])
      setSkills(PREVIEW_SKILLS)
      setChatItems(PREVIEW_ITEMS)
      setEvents([
        { type: 'subagent_start', agentType: 'file-picker' },
        { type: 'tool_start', toolName: 'read_files' },
        { type: 'tool_result', toolName: 'read_files', status: 'done' },
        {
          type: 'tool_call',
          toolName: 'query_index',
          queryInput: { query: 'zero division error handling', mode: 'search', limit: 5 }
        },
        {
          type: 'tool_result',
          toolName: 'query_index',
          status: 'done',
          queryIndex: {
            kind: 'query_index_result',
            results: [
              {
                path: 'src/calculator.js',
                score: 8.4,
                matchedOn: ['symbol', 'path'],
                symbols: ['divide', 'multiply'],
                matchedSnippets: ['export function divide(a, b)']
              },
              {
                path: 'README.md',
                score: 2.1,
                matchedOn: ['concept'],
                relatedFiles: [{ path: 'src/calculator.js', score: 1.2, reason: 'references calculator module' }]
              }
            ],
            totalIndexed: 4,
            indexAge: 42_000,
            status: { state: 'ready', ready: true, semantic: 'disabled', totalIndexed: 4, indexAge: 42_000 }
          },
          message: 'Found 2 indexed file results.'
        },
        { type: 'tool_start', toolName: 'edit_transaction' },
        { type: 'tool_result', toolName: 'edit_transaction', status: 'done', message: 'applied 1 edit: src/calculator.js\n+  if (b === 0) {\n+    throw new RangeError(\'Cannot divide by zero\')\n+  }' },
        { type: 'finish' }
      ])
      return
    }
    void (async () => {
      const state = (await window.AnyBuff.getState()) as {
        cwd: string | null
        running: boolean
        settings: {
          providers: { id: string; label: string; models: string[] }[]
          activeModel: string
          reasoningEffort: string
          approvalMode: string
          hasProvider: boolean
          projects: ProjectRecord[]
        }
      }
      setCwd(state.cwd)
      setRunning(state.running)
      setRunningTaskId((state as { runningTaskId?: string | null }).runningTaskId ?? null)
      setHasProvider(state.settings.hasProvider)
      setSettings({
        providers: state.settings.providers,
        activeModel: state.settings.activeModel,
        reasoningEffort: state.settings.reasoningEffort,
        approvalMode: state.settings.approvalMode
      })
      setProjects(state.settings.projects ?? [])
    })()
  }, [])

  // Project name, git branch, @-file candidates, skills
  useEffect(() => {
    if (!cwd) return
    if (IS_PREVIEW) {
      setFileCandidates(['src/calculator.js', 'src/index.js', 'README.md', 'package.json'])
      return
    }
    void window.AnyBuff.projectName(cwd).then(setProjectName)
    void window.AnyBuff.gitBranch(cwd).then(setBranch)
    void window.AnyBuff.listFiles(cwd).then((t) => setFileCandidates(flattenTree(t as TreeNode[], cwd)))
    void window.AnyBuff.listSkills(cwd).then((s) => setSkills(s as SkillInfo[]))
  }, [cwd])

  // Auto-scroll to bottom — paused while the user has scrolled up to read
  // history; scrolling back near the bottom resumes following the stream.
  useEffect(() => {
    if (!autoScrollRef.current) return
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight })
  }, [chatItems])

  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  // Tick while an auto-retry countdown is visible so its seconds stay live.
  useEffect(() => {
    if (!retryNotice) return
    const timer = setInterval(() => setNowTick(Date.now()), 500)
    return () => clearInterval(timer)
  }, [retryNotice])

  // SDK events → UI
  useEffect(() => {
    if (IS_PREVIEW) return
    const unsubscribe = window.AnyBuff.onEvent((event) => {
      /* ── Global lifecycle events (apply regardless of visible conversation) ── */

      // Run ownership lives in the main process; these events keep the global
      // running indicator accurate even when viewing another conversation.
      if (event.type === 'run_status') {
        if (event.status === 'running') {
          setRunning(true)
          if (event.taskId) setRunningTaskId(event.taskId)
        } else {
          setRunning(false)
          setRunningTaskId(null)
        }
        // Any run transition ends the current retry wait (a new attempt is
        // starting, or the run reached a terminal state).
        setRetryNotice(null)
        return
      }

      // Approval requests pause the single active run wherever it is — always surface.
      if ((event as any).type === 'ask_user') {
        const qs = (event as any).raw
        setPendingAskUser(Array.isArray(qs) && qs.length > 0 ? qs : null)
        setAskSelections({})
        setAskOther({})
        return
      }

      if (event.type === 'approval_request') {
        setApprovalRequest({ message: event.message ?? 'Permission requested', raw: event.raw })
        return
      }

      if (event.type === 'context_window' && typeof event.used === 'number' && typeof event.max === 'number') {
        setTokenUsage({ used: event.used, max: event.max })
        return
      }

      // Cost accumulates across all runs even when their conversations are not visible.
      if (event.type === 'finish' && typeof event.totalCost === 'number') {
        setTotalCost((c) => c + event.totalCost!)
      }

      /* ── Conversation-scoped events ── */
      // Route by taskId so background runs never pollute the visible timeline.
      if (!event.taskId || event.taskId !== currentTaskRef.current) return

      if (event.type === 'auto_retry') {
        setRetryNotice({
          attempt: Number(event.attempt ?? 0),
          maxAttempts: Number(event.maxAttempts ?? 0),
          nextAt: Number(event.nextAt ?? Date.now()),
          reason: typeof event.status === 'string' ? event.status : undefined,
          headline: typeof event.message === 'string' ? event.message : undefined,
          detail: typeof event.text === 'string' ? event.text : undefined
        })
        setNowTick(Date.now())
        return
      }

      if (event.type === 'context_compaction') {
        const note =
          event.action === 'mechanical_trim'
            ? 'Older tool outputs were trimmed to fit the context window.'
            : 'Earlier messages were summarized to fit the context window.'
        setChatItems((prev) => [...prev, { kind: 'compaction', text: note }])
        return
      }

      if (event.type === 'reasoning_stream' || event.type === 'reasoning_delta') {
        const delta = event.text ?? ''
        if (!delta) return
        setChatItems((prev) => {
          const next = [...prev]
          if (next.length > 0 && next[next.length - 1].kind === 'assistant') {
            const last = next[next.length - 1] as { kind: 'assistant'; text: string; reasoning?: string }
            next[next.length - 1] = { kind: 'assistant', text: last.text, reasoning: (last.reasoning ?? '') + delta }
          } else {
            next.push({ kind: 'assistant', text: '', reasoning: delta })
          }
          return next
        })
        return
      }

      if (event.type === 'stream') {
        const chunk = event.text ?? ''
        if (!chunk) return

        // Check if stream contains followups
        const fnMatch =
          chunk.match(/function:suggest_followups\s*(\{[\s\S]*?\})/i) ||
          chunk.match(/<suggest_followups>([\s\S]*?)<\/suggest_followups>/i)
        if (fnMatch) {
          const parsed = parseFollowups(fnMatch[1])
          if (parsed.length > 0) {
            setFollowups(parsed)
          }
        }

        setChatItems((prev) => {
          const next = [...prev]
          if (next.length > 0 && next[next.length - 1].kind === 'assistant') {
            const last = next[next.length - 1] as { kind: 'assistant'; text: string; reasoning?: string }
            const newText = last.text + chunk
            const fullMatch =
              newText.match(/function:suggest_followups\s*(\{[\s\S]*?\})/i) ||
              newText.match(/<suggest_followups>([\s\S]*?)<\/suggest_followups>/i)
            if (fullMatch) {
              const parsed = parseFollowups(fullMatch[1])
              if (parsed.length > 0) {
                setFollowups(parsed)
              }
            }
            next[next.length - 1] = {
              kind: 'assistant',
              text: newText,
              reasoning: last.reasoning
            }
          } else {
            next.push({
              kind: 'assistant',
              text: chunk,
              reasoning: undefined
            })
          }
          return next
        })
        return
      }

      if (event.type === 'tool_start' || event.type === 'tool_call') {
        // The SDK surfaces the followup items on the tool_call input
        if (event.toolName === 'suggest_followups') {
          const parsed = parseFollowups(event.message ?? event.raw ?? '')
          if (parsed.length > 0) setFollowups(parsed)
        }
        // Remember files mutated this run so the Revert button can undo them.
        if (event.files?.length) {
          changedFilesRef.current = [...new Set([...changedFilesRef.current, ...event.files])]
        }
        // Collect file changes with action types for the summary
        if (event.changedFiles && event.changedFiles.length > 0) {
          accumulatedFileChangesRef.current = [...accumulatedFileChangesRef.current, ...event.changedFiles]
        }
        if (event.toolName === 'query_index' && event.type === 'tool_call') {
          setEvents((prev) => [...prev.slice(-299), event])
        }
        // Silent background polling tools (e.g. git_status, suggest_followups, check_job) are hidden from the UI timeline
        if (isSilentTool(event.toolName)) {
          return
        }
        const tool: ToolItem = {
          toolName: event.toolName ?? 'tool',
          status: 'running',
          agentType: event.agentType,
          todos: event.toolName === 'write_todos' && Array.isArray(event.todos) ? event.todos : undefined
        }
        if (event.toolName === 'write_todos' && Array.isArray(event.todos)) {
          setActiveTodos(event.todos)
        }
        toolIndexRef.current = chatItemsRef.current.length
        setChatItems((prev) => [...prev, { kind: 'tool', tool }])
        return
      }

      if (event.type === 'tool_result') {
        if (isSilentTool(event.toolName)) {
          if (event.toolName === 'suggest_followups') {
            const parsed = parseFollowups(event.message ?? event.raw ?? '')
            if (parsed.length > 0) setFollowups(parsed)
          }
          return
        }
        const idx = toolIndexRef.current
        toolIndexRef.current = -1
        if (idx >= 0) {
          setChatItems((prev) => {
            const next = [...prev]
            const item = next[idx]
            if (item && item.kind === 'tool') {
              next[idx] = { kind: 'tool', tool: { ...item.tool, status: 'done', detail: event.message ?? event.status } }
            }
            return next
          })
        }
        if (event.toolName === 'query_index') {
          setEvents((prev) => [...prev.slice(-299), event])
        }
        return
      }

      if (event.type === 'finish') {
        setActiveTodos([])
        // Insert file changes summary if files were modified
        const fileChanges = accumulatedFileChangesRef.current
        if (fileChanges.length > 0) {
          // Deduplicate by path, keeping the most severe action
          const actionPriority: Record<string, number> = { delete: 3, create: 2, modify: 1 }
          const deduped = new Map<string, FileChange>()
          for (const fc of fileChanges) {
            const existing = deduped.get(fc.path)
            if (!existing || (actionPriority[fc.action] ?? 0) > (actionPriority[existing.action] ?? 0)) {
              deduped.set(fc.path, fc)
            }
          }
          const summaryFiles = Array.from(deduped.values())
          setChatItems((prev) => [...prev, { kind: 'file-changes', files: summaryFiles }])
        }
        accumulatedFileChangesRef.current = []
        return
      }

      if (event.type === 'subagent_start') {
        const agentType = event.agentType ?? 'subagent'
        const tool: ToolItem = {
          toolName: `agent:${agentType}`,
          status: 'running',
          agentType: agentType,
          agentName: event.agentName,
          detail: event.message
        }
        setChatItems((prev) => [...prev, { kind: 'tool', tool }])
        setEvents((prev) => [...prev.slice(-299), event])
        return
      }

      if (event.type === 'subagent_stream') {
        const agentType = event.agentType
        const text = event.text ?? ''
        if (text) {
          setChatItems((prev) => {
            const next = [...prev]
            for (let i = next.length - 1; i >= 0; i--) {
              const item = next[i]
              if (item.kind === 'tool' && item.tool.agentType === agentType && item.tool.status === 'running') {
                next[i] = {
                  kind: 'tool',
                  tool: {
                    ...item.tool,
                    detail: (item.tool.detail ?? '') + text
                  }
                }
                break
              }
            }
            return next
          })
        }
        return
      }

      if (event.type === 'subagent_finish') {
        const agentType = event.agentType
        setChatItems((prev) => {
          const next = [...prev]
          for (let i = next.length - 1; i >= 0; i--) {
            const item = next[i]
            if (item.kind === 'tool' && item.tool.agentType === agentType && item.tool.status === 'running') {
              next[i] = {
                kind: 'tool',
                tool: {
                  ...item.tool,
                  status: 'done',
                  detail: event.message || item.tool.detail || 'Completed'
                }
              }
              break
            }
          }
          return next
        })
        setEvents((prev) => [...prev.slice(-299), event])
        return
      }

      if (event.type === 'error') {
        setApprovalRequest(null)
        const msg = event.message ?? 'An error occurred'
        if (
          msg.includes('suggest_followups already ended') ||
          msg.includes('No more non-terminal tools are available after followups')
        ) {
          return
        }
        setChatItems((prev) => [...prev, { kind: 'system', text: msg }])
        return
      }

      setEvents((prev) => [...prev.slice(-299), event])
    })
    return unsubscribe
  }, [])

  // Keep chatItems in a ref for event callbacks
  const chatItemsRef = useRef(chatItems)
  chatItemsRef.current = chatItems

  const refreshProjects = useCallback(() => {
    if (IS_PREVIEW) return
    void window.AnyBuff.listProjects().then((p) => setProjects(p as ProjectRecord[]))
  }, [])

  const openAgentWizard = useCallback(() => {
    if (!cwd) {
      setNotice('Select a project folder before creating a custom agent.')
      return
    }
    setShowSettings(false)
    setShowAgentWizard(true)
  }, [cwd])

  const selectFolder = useCallback(async () => {
    if (IS_PREVIEW) return
    const path = await window.AnyBuff.selectFolder()
    if (path) {
      setCwd(path as string)
      autoScrollRef.current = true
      setChatItems([])
      setEvents([])
      setNotice(null)
      setAttachments([])
      setTokenUsage(null)
      setTotalCost(0)
      setHistoryTask(null)
      setResumeInfo(null)
      setViewTask(null)
      refreshProjects()
    }
  }, [refreshProjects, setViewTask])

  // Compose final prompt: resolve @ files, /skills, and attachments
  const buildFinalPrompt = useCallback(
    async (raw: string): Promise<string> => {
      const lines: string[] = []
      let text = raw

      // Resolve /skill:name token
      const skillTokens = text.match(/\/skill:([\w.-]+)/g) ?? []
      for (const token of skillTokens) {
        const name = token.replace('/skill:', '')
        const skill = skills.find((s) => s.name === name)
        if (skill && skill.path && !IS_PREVIEW) {
          const res = (await window.AnyBuff.readSkillFile(skill.path)) as { ok: boolean; content?: string }
          if (res.ok) {
            lines.push(`I invoke the following skill: ${name}\n\n${res.content}`)
          }
        }
        text = text.split(token).join(' ')
      }

      // @-mention files → add to attachments
      const mentionPaths = new Set<string>()
      for (const token of text.split(/\s+/)) {
        if (token.startsWith('@')) {
          const rel = token.slice(1)
          if (cwd && fileCandidates.includes(rel)) mentionPaths.add(rel)
        }
      }
      const allAttachments = [...attachments]
      for (const rel of mentionPaths) {
        if (!allAttachments.some((a) => a.path === rel)) {
          allAttachments.push({ path: rel, name: basenameOf(rel), isDir: false, isRelative: true })
        }
      }

      if (allAttachments.length > 0 && cwd) {
        lines.push('## Attached files')
        for (const att of allAttachments) {
          const full = att.isRelative ? absPath(cwd, att.path) : att.path
          if (IS_PREVIEW) {
            lines.push(`\n<file path="${att.path}">\n(preview content)\n</file>`)
            continue
          }
          if (att.isDir) {
            const tree = (await window.AnyBuff.listFiles(full)) as TreeNode[]
            const files = flattenTree(tree, full)
            lines.push(`\n<folder path="${att.path}">\n${files.slice(0, 200).join('\n')}\n</folder>`)
          } else {
            const res = (await window.AnyBuff.readFile(full)) as { ok: boolean; content?: string; error?: string }
            if (res.ok) {
              const content = (res.content ?? '').slice(0, 120_000)
              lines.push(`\n<file path="${att.path}">\n${content}\n</file>`)
            } else {
              lines.push(`\n<file path="${att.path}">\n[unreadable: ${res.error}]\n</file>`)
            }
          }
        }
      }

      const final = text.trim() + (lines.length > 0 ? `\n\n${lines.join('\n\n')}` : '')
      return final
    },
    [attachments, skills, fileCandidates, cwd]
  )

  /* ── #2 執行中訊息佇列：edit / reorder / delete / promote ── */

  const queueEdit = useCallback(
    async (id: string, text: string) => {
      // Re-bake attachments for the edited text so the stored prompt stays valid.
      const finalPrompt = await buildFinalPrompt(text)
      setQueuedMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text, finalPrompt } : m)))
    },
    [buildFinalPrompt]
  )

  const queueDelete = useCallback((id: string) => {
    setQueuedMessages((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const queueMove = useCallback((id: string, direction: -1 | 1) => {
    setQueuedMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id)
      const to = idx + direction
      if (idx < 0 || to < 0 || to >= prev.length) return prev
      const next = [...prev]
      ;[next[idx], next[to]] = [next[to], next[idx]]
      return next
    })
  }, [])

  /** 插隊：promote a queued message to the front of the queue. */
  const queueSendNext = useCallback((id: string) => {
    setQueuedMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id)
      if (idx <= 0) return prev
      const item = prev[idx]
      return [item, ...prev.filter((m) => m.id !== id)]
    })
  }, [])

  const send = useCallback(
    async (textOverride?: string, prebuiltPrompt?: string) => {
      const text = (textOverride ?? prompt).trim()
      if (!text || !cwd) return
      if (/^\/init(?:\s|$)/i.test(text)) {
        setPrompt('')
        openAgentWizard()
        return
      }
      // Bake @file contents etc. in BEFORE queueing so a queued message keeps
      // exactly what was selected when it was written (#2 執行中訊息佇列).
      const finalPrompt = prebuiltPrompt ?? (await buildFinalPrompt(text))

      if (running) {
        if (IS_PREVIEW) return
        // A run is in flight → park the message in the execution queue instead
        // of rejecting it; the queue drains automatically when the turn ends.
        setQueuedMessages((prev) => [
          ...prev,
          {
            id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            text,
            finalPrompt
          }
        ])
        setPrompt('')
        return
      }

      setPrompt('')
      changedFilesRef.current = []
      accumulatedFileChangesRef.current = []
      setFollowups([])
      autoScrollRef.current = true
      setChatItems((prev) => [...prev, { kind: 'user', text }, { kind: 'assistant', text: '' }])
      setRunning(true)
      setNotice(null)
      setHistoryTask(null)
      setResumeInfo(null)
      // New conversations get their id up front so streamed events route to
      // this view immediately; existing conversations reuse their id.
      if (!currentTaskRef.current && !IS_PREVIEW) {
        const newId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        setViewTask(newId)
      }
      // Optimistic: this view owns the run until events say otherwise.
      if (!IS_PREVIEW) setRunningTaskId(currentTaskRef.current)

    if (IS_PREVIEW) {
      const reply =
        'Got it! I will analyze the project first, then make the changes.\n\n```js\nconsole.log(\'hello\')\n```\n\nDoes this look right?'
      let i = 0
      const timer = setInterval(() => {
        i += 4
        if (i >= reply.length) {
          clearInterval(timer)
          setChatItems((prev) => {
            const next = [...prev]
            next[next.length - 1] = { kind: 'assistant', text: reply }
            return next
          })
          setRunning(false)
          setStopping(false)
        } else {
          setChatItems((prev) => {
            const next = [...prev]
            next[next.length - 1] = { kind: 'assistant', text: reply.slice(0, i) }
            return next
          })
        }
      }, 40)
      return
    }
    try {
      // The main process owns the run and all conversation context. Passing the
      // existing taskId continues that conversation with full history; omitting
      // it starts (and names) a new one.
      const runPromise = window.AnyBuff.runPrompt({
        cwd,
        prompt: finalPrompt,
        displayText: text,
        taskId: currentTaskRef.current ?? undefined,
        mode: agentMode
      }) as Promise<{ ok: boolean; taskId?: string; error?: string; interrupted?: boolean; reason?: string; errorMessage?: string }>
      // The task record is created synchronously at the start of the main-process
      // handler — refresh the sidebar immediately so the conversation shows up
      // (and is reachable) while it is still streaming.
      refreshProjects()
      const result = await runPromise
      if (!result.ok) {
        setChatItems((prev) => [...prev, { kind: 'system', text: result.error ?? 'Execution failed' }])
      } else {
        if (result.taskId) setViewTask(result.taskId)
        // Failed (stopped or API error) runs preserve their state; offer to resume.
        if (result.interrupted) {
          setResumeInfo({ prompt: text, reason: result.reason, errorMessage: result.errorMessage })
        }
      }
      void window.AnyBuff.gitBranch(cwd).then(setBranch)
    } catch (err) {
      setChatItems((prev) => [...prev, { kind: 'system', text: String(err) }])
    } finally {
      setRunning(false)
      setStopping(false)
      setRetryNotice(null)
      setApprovalRequest(null)
      setNotice((prev) => (prev && prev.includes('Stop requested') ? null : prev))
    }
  }, [prompt, cwd, running, agentMode, buildFinalPrompt, refreshProjects, openAgentWizard, setViewTask])

  // When the current turn ends, automatically dispatch the first queued message.
  // drainingQueueRef serializes against re-entrant effect runs (StrictMode dev
  // double-invoke included); `send` flips `running` synchronously so the follow-up
  // run sees the in-flight state immediately.
  const drainingQueueRef = useRef(false)
  useEffect(() => {
    if (IS_PREVIEW) return
    if (running || drainingQueueRef.current) return
    const next = queuedMessages[0]
    if (!next) return
    drainingQueueRef.current = true
    setQueuedMessages((prev) => prev.slice(1))
    void send(next.text, next.finalPrompt).finally(() => {
      drainingQueueRef.current = false
    })
  }, [running, queuedMessages, send])

  const stop = useCallback(() => {
    setApprovalRequest(null)
    setStopping(true)
    setNotice('Stop requested. Waiting for agent to safely halt...')
    if (!IS_PREVIEW) void window.AnyBuff.abort()
  }, [])

  // Resume an interrupted run from its preserved state (no re-appending the user prompt).
  const resumeRun = useCallback(async () => {
    const info = resumeInfo
    const taskId = currentTaskRef.current
    if (!info || !cwd || running || !taskId) return
    setRunning(true)
    setRunningTaskId(taskId)
    setNotice(null)
    setResumeInfo(null)
    setChatItems((prev) => [...prev, { kind: 'assistant', text: '' }])
    if (IS_PREVIEW) {
      setRunning(false)
      setStopping(false)
      setNotice('Resume is available in the Electron app (preview mode does not persist run state).')
      return
    }
    try {
      // The main process resolves the best preserved state: the interrupted
      // run's own state, or a fresher mid-turn checkpoint after a crash.
      const result = (await window.AnyBuff.runPrompt({
        cwd,
        prompt: info.prompt,
        resume: true,
        taskId,
        mode: agentMode
      })) as { ok: boolean; taskId?: string; error?: string; interrupted?: boolean; reason?: string; errorMessage?: string }
      if (!result.ok) {
        setChatItems((prev) => [...prev, { kind: 'system', text: result.error ?? 'Resume failed' }])
      } else if (result.interrupted) {
        setResumeInfo({ prompt: info.prompt, reason: result.reason, errorMessage: result.errorMessage })
      }
      void window.AnyBuff.gitBranch(cwd).then(setBranch)
      refreshProjects()
    } catch (err) {
      setChatItems((prev) => [...prev, { kind: 'system', text: String(err) }])
    } finally {
      setRunning(false)
      setStopping(false)
      setNotice((prev) => (prev && prev.includes('Stop requested') ? null : prev))
    }
  }, [resumeInfo, cwd, running, agentMode, refreshProjects])

  // Discard the banner; the preserved state simply stays on disk unused.
  const discardResume = useCallback(() => {
    setResumeInfo(null)
  }, [])

  const newTask = useCallback(() => {
    // Only resets the VIEW — any active run keeps going in the background and
    // its conversation stays fully persisted in the main-process session store.
    setChatItems([])
    autoScrollRef.current = true
    setEvents([])
    changedFilesRef.current = []
    accumulatedFileChangesRef.current = []
    setAttachments([])
    setTokenUsage(null)
    setTotalCost(0)
    setFollowups([])
    setPrompt('')
    setHistoryTask(null)
    setResumeInfo(null)
    setViewTask(null)
  }, [setViewTask])

  // Clicking Revert opens an in-app confirmation instead of blocking window.confirm.
  const requestRevert = useCallback(() => {
    // Find the last user message — the exchange being undone.
    let lastUserIdx = -1
    let lastUserText = ''
    for (let i = chatItems.length - 1; i >= 0; i--) {
      const item = chatItems[i]
      if (item.kind === 'user') {
        lastUserIdx = i
        lastUserText = item.text
        break
      }
    }
    const files = [...new Set(changedFilesRef.current)]
    if (files.length === 0 && lastUserIdx < 0) {
      setNotice('No file changes detected in this conversation.')
      return
    }
    setPendingRevert({ files, lastUserIdx, lastUserText })
  }, [chatItems])

  const confirmRevert = useCallback(async () => {
    const pending = pendingRevert
    setPendingRevert(null)
    if (!pending || !cwd) return
    const { files, lastUserIdx, lastUserText } = pending
    // Update the UI immediately: drop the exchange and put the original message
    // back into the composer (unsent) so the user can edit it right away.
    if (lastUserIdx >= 0) {
      setChatItems((prev) => prev.slice(0, lastUserIdx))
      setPrompt(lastUserText)
    }
    setEvents([])
    changedFilesRef.current = []
    accumulatedFileChangesRef.current = []
    setFollowups([])
    setHistoryTask(null)
    setResumeInfo(null)
    // Undo the file changes in parallel so a large exchange doesn't stall the UI.
    let okCount = 0
    const errors: string[] = []
    if (!IS_PREVIEW) {
      if (files.length > 0) setNotice(`Reverting ${files.length} file(s)…`)
      const results = await Promise.all(
        files.map(async (f) => {
          const res = (await window.AnyBuff.gitRevert({ cwd, file: f })) as { ok: boolean; error?: string }
          return { f, res }
        })
      )
      for (const { f, res } of results) {
        if (res.ok) okCount++
        else errors.push(`${f}: ${res.error ?? 'failed'}`)
      }
      void window.AnyBuff.gitBranch(cwd).then(setBranch)
    } else {
      okCount = files.length
    }
    // Persisted history: trim the reverted turn (transcript + SDK run state)
    // so the conversation KEEPS its earlier context. The task record survives —
    // resending the edited message continues this same conversation.
    const taskId = currentTaskRef.current
    if (taskId && !IS_PREVIEW) {
      if (lastUserText) {
        const res = (await window.AnyBuff.trimTaskLastTurn({ taskId, userText: lastUserText })) as {
          ok: boolean
          error?: string
        }
        if (res?.ok) {
          refreshProjects()
        } else {
          // Turn not found in the persisted state — remove the whole record.
          setViewTask(null)
          void window.AnyBuff.deleteTask(taskId)
          refreshProjects()
        }
      } else {
        // No user message to anchor the trim — remove the whole record.
        setViewTask(null)
        void window.AnyBuff.deleteTask(taskId)
        refreshProjects()
      }
    }
    if (errors.length > 0) {
      setNotice(`Reverted ${okCount}/${files.length} file(s). ${errors.slice(0, 3).join('; ')}`)
    } else if (files.length > 0) {
      setNotice(`Reverted ${okCount} file(s). Your original message is back in the input box — edit and resend.`)
    } else {
      setNotice('Exchange discarded. Your original message is back in the input box — edit and resend.')
    }
    // Focus the composer so the restored message is immediately editable.
    setFocusSignal((n) => n + 1)
  }, [pendingRevert, cwd, refreshProjects])

  const openFileByPath = useCallback(async (path: string, name: string) => {
    if (IS_PREVIEW) {
      setSelectedFile({ path, content: '// simulated file content (preview mode)', name })
      return
    }
    const result = (await window.AnyBuff.readFile(path)) as { ok: boolean; content?: string; error?: string }
    if (result.ok) {
      setSelectedFile({ path, content: result.content ?? '', name })
    }
  }, [])

  const onSelectFile = useCallback(
    (node: TreeNode) => {
      if (node.type !== 'file') return
      void openFileByPath(node.path, node.name)
    },
    [openFileByPath]
  )

  const handleCloseSettings = useCallback(() => {
    setShowSettings(false)
    if (!IS_PREVIEW) {
      void window.AnyBuff.getState().then((state) => {
        const s = (state as { settings: { activeModel: string; reasoningEffort: string; approvalMode: string; providers: { id: string; label: string; models: string[] }[]; hasProvider?: boolean } }).settings
        if (s) {
          setHasProvider(Boolean(s.hasProvider))
          setSettings({ providers: s.providers, activeModel: s.activeModel, reasoningEffort: s.reasoningEffort, approvalMode: s.approvalMode })
        }
      })
      refreshProjects()
    }
  }, [refreshProjects])

  const onSettingsSaved = useCallback(
    (saved: { hasProvider: boolean }) => {
      setHasProvider(saved.hasProvider)
      if (!IS_PREVIEW) {
        void window.AnyBuff.getState().then((state) => {
          const s = (state as { settings: { activeModel: string; reasoningEffort: string; approvalMode: string; providers: { id: string; label: string; models: string[] }[] } }).settings
          if (s) {
            setSettings({ providers: s.providers, activeModel: s.activeModel, reasoningEffort: s.reasoningEffort, approvalMode: s.approvalMode })
          }
        })
        refreshProjects()
      }
    },
    [refreshProjects]
  )

  const onModelChange = useCallback((m: string) => {
    setSettings((prev) => ({ ...prev, activeModel: m }))
    if (!IS_PREVIEW) {
      void window.AnyBuff.saveSettings({
        providers: settingsRef.current.providers,
        activeModel: m,
        reasoningEffort: settingsRef.current.reasoningEffort,
        approvalMode: settingsRef.current.approvalMode,
        apiKeys: {},
        deleteKeys: []
      })
    }
  }, [])

  const onReasoningChange = useCallback((r: string) => {
    setSettings((prev) => ({ ...prev, reasoningEffort: r }))
    if (!IS_PREVIEW) {
      void window.AnyBuff.saveSettings({
        providers: settingsRef.current.providers,
        activeModel: settingsRef.current.activeModel,
        reasoningEffort: r,
        approvalMode: settingsRef.current.approvalMode,
        apiKeys: {},
        deleteKeys: []
      })
    }
  }, [])

  // Attachments
  const onAttachFiles = useCallback(async () => {
    if (IS_PREVIEW) {
      setAttachments((prev) => [...prev, { path: 'src/calculator.js', name: 'calculator.js', isDir: false, isRelative: true }])
      return
    }
    const paths = (await window.AnyBuff.selectFiles()) as string[]
    const added: Attachment[] = []
    for (const p of paths) {
      const info = (await window.AnyBuff.pathInfo(p)) as { ok: boolean; isDir?: boolean; name?: string }
      if (info.ok) {
        added.push({ path: p, name: info.name ?? basenameOf(p), isDir: Boolean(info.isDir), isRelative: false })
      }
    }
    setAttachments((prev) => {
      const next = [...prev]
      for (const a of added) {
        if (!next.some((x) => x.path === a.path)) next.push(a)
      }
      return next
    })
  }, [])

  const onAttachFilesPath = useCallback((relPath: string) => {
    setAttachments((prev) =>
      prev.some((a) => a.path === relPath)
        ? prev
        : [...prev, { path: relPath, name: basenameOf(relPath), isDir: false, isRelative: true }]
    )
  }, [])

  const onRemoveAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path))
  }, [])

  // Right panel tab
  const onRightTab = useCallback((tab: RightTab) => {
    setRightTab(tab)
  }, [])

  // Debounced cross-task history search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setHistoryResults([])
      return
    }
    const q = searchQuery.trim().toLowerCase()
    const timer = setTimeout(async () => {
      if (IS_PREVIEW) {
        // Preview mode: search through preview projects' tasks (user and assistant only)
        const out: SearchResult[] = []
        for (const proj of projects) {
          for (const t of proj.tasks ?? []) {
            const msgs = (t.messages ?? []) as { kind?: string; text?: string }[]
            msgs.forEach((msg, idx) => {
              if (msg.kind !== 'user' && msg.kind !== 'assistant') return
              const rawText = msg.text || ''
              const text = rawText.replace(/\s+/g, ' ')
              const matchIdx = text.toLowerCase().indexOf(q)
              if (matchIdx >= 0) {
                const start = Math.max(0, matchIdx - 20)
                const snippet =
                  (start > 0 ? '...' : '') + text.slice(start, start + 100) + (start + 100 < text.length ? '...' : '')
                out.push({
                  index: idx,
                  kind: msg.kind === 'user' ? 'Msg' : 'AI',
                  text: snippet,
                  taskId: t.id,
                  taskPrompt: t.prompt,
                  projectPath: proj.path,
                  projectName: proj.name,
                  key: `prev-hist-${t.id}-${idx}`
                })
              }
            })
          }
        }
        setHistoryResults(out)
        return
      }

      try {
        const raw = (await window.AnyBuff.searchHistory(q)) as {
          taskId: string
          taskPrompt: string
          projectPath: string
          projectName: string
          messageIndex: number
          kind: 'user' | 'assistant'
          snippet: string
          createdAt: number
        }[]
        const out: SearchResult[] = (raw ?? []).map((r) => ({
          index: r.messageIndex,
          kind: r.kind === 'user' ? 'Msg' : 'AI',
          text: r.snippet,
          taskId: r.taskId,
          taskPrompt: r.taskPrompt,
          projectPath: r.projectPath,
          projectName: r.projectName,
          key: `hist-${r.taskId}-${r.messageIndex}`
        }))
        setHistoryResults(out)
      } catch {
        setHistoryResults([])
      }
    }, 200)

    return () => clearTimeout(timer)
  }, [searchQuery, projects])

  // Search chat messages (user & assistant across history and current conversation) AND file names
  const searchResults = useMemo<SearchResult[]>(() => {
    if (!searchQuery.trim()) return []
    const q = searchQuery.toLowerCase()
    const out: SearchResult[] = []

    // 1. Search current in-memory conversation (user and assistant only)
    chatItems.forEach((item, i) => {
      if (item.kind === 'user' || item.kind === 'assistant') {
        const rawText = item.text || ''
        const text = rawText.replace(/\s+/g, ' ')
        const matchIdx = text.toLowerCase().indexOf(q)
        if (matchIdx >= 0) {
          const start = Math.max(0, matchIdx - 20)
          const snippet =
            (start > 0 ? '...' : '') + text.slice(start, start + 100) + (start + 100 < text.length ? '...' : '')
          out.push({
            index: i,
            kind: item.kind === 'user' ? 'Msg' : 'AI',
            text: snippet,
            taskId: currentTaskRef.current ?? undefined,
            taskPrompt: historyTask?.prompt ?? undefined,
            projectPath: cwd ?? undefined,
            projectName: projectName || undefined,
            key: `current-${i}`
          })
        }
      }
    })

    // 2. Include historical search results (excluding the active current task to prevent duplicates)
    const activeTaskId = currentTaskRef.current
    for (const hr of historyResults) {
      if (activeTaskId && hr.taskId === activeTaskId) continue
      out.push(hr)
    }

    // 3. Also search file names
    fileCandidates.forEach((f) => {
      if (f.toLowerCase().includes(q)) out.push({ index: -1, kind: 'File', text: f, key: `file-${f}` })
    })
    return out
  }, [searchQuery, chatItems, historyResults, fileCandidates, historyTask, cwd, projectName])

  const onOpenProject = useCallback(
    async (path: string) => {
      if (path === cwd) return
      if (IS_PREVIEW) return
      // Switching projects only changes the view — a running task keeps going
      // in the background and its history stays persisted in the main process.
      setCwd(path)
      autoScrollRef.current = true
      setChatItems([])
      setEvents([])
      changedFilesRef.current = []
      accumulatedFileChangesRef.current = []
      setAttachments([])
      setTokenUsage(null)
      setTotalCost(0)
      setSelectedFile(null)
      setHistoryTask(null)
      setResumeInfo(null)
      setViewTask(null)
      setProjectMenuOpen(false)
      const pname = (await window.AnyBuff.projectName(path)) as string
      setProjectName(pname)
    },
    [cwd, setViewTask]
  )

  const onOpenTask = useCallback(
    async (project: ProjectRecord, task: TaskRecord) => {
      await onOpenProject(project.path)
      if (IS_PREVIEW) {
        setViewTask(task.id)
        setChatItems((task.messages ?? []) as ChatItem[])
        setHistoryTask({ id: task.id, prompt: task.prompt })
        setPrompt('')
        return
      }
      // Re-attach = load the full snapshot (transcript + status + resume info)
      // from the main-process session store. The event gate opens only AFTER
      // the snapshot lands so live deltas apply on top of it, never under it.
      const view = (await window.AnyBuff.getTaskView(task.id)) as {
        ok: boolean
        transcript?: ChatItem[]
        status?: string
        canResume?: boolean
        resumeReason?: string
        resumeErrorMessage?: string
      }
      setHistoryTask({ id: task.id, prompt: task.prompt })
      setChatItems((view.ok ? view.transcript ?? [] : []) as ChatItem[])
      setViewTask(task.id)
      if (view.ok && view.canResume && view.status !== 'running') {
        setResumeInfo({
          prompt: task.prompt,
          reason: view.resumeReason ?? 'error',
          errorMessage: view.resumeErrorMessage
        })
      } else {
        setResumeInfo(null)
      }
      setPrompt('')
    },
    [onOpenProject, setViewTask]
  )

  const onRenameTask = useCallback(
    async (project: ProjectRecord, task: TaskRecord, newPrompt: string) => {
      if (!newPrompt || newPrompt === task.prompt) return
      if (!IS_PREVIEW) {
        await window.AnyBuff.renameTask({ taskId: task.id, newPrompt })
      }
      setProjects((prev) =>
        prev.map((p) => {
          if (p.path !== project.path) return p
          return {
            ...p,
            tasks: p.tasks.map((t) => (t.id === task.id ? { ...t, prompt: newPrompt } : t))
          }
        })
      )
      if (historyTask?.id === task.id) {
        setHistoryTask((prev) => (prev ? { ...prev, prompt: newPrompt } : null))
      }
    },
    [historyTask]
  )

  const onDeleteTask = useCallback(
    async (project: ProjectRecord, task: TaskRecord) => {
      if (!IS_PREVIEW) {
        const res = (await window.AnyBuff.deleteTask(task.id)) as { ok: boolean; error?: string }
        if (!res?.ok) {
          setNotice(res?.error ?? 'Failed to delete the task.')
          return
        }
      }
      setProjects((prev) =>
        prev.map((p) => {
          if (p.path !== project.path) return p
          return {
            ...p,
            tasks: p.tasks.filter((t) => t.id !== task.id)
          }
        })
      )
      if (historyTask?.id === task.id || currentTaskRef.current === task.id) {
        newTask()
      }
    },
    [historyTask, newTask]
  )

  const onRemoveProject = useCallback(
    async (project: ProjectRecord) => {
      if (!IS_PREVIEW) {
        const res = (await window.AnyBuff.removeProject(project.path)) as { ok: boolean; error?: string }
        if (!res?.ok) {
          setNotice(res?.error ?? 'Failed to remove the project.')
          return
        }
      }
      setProjects((prev) => prev.filter((p) => p.path !== project.path))
      const isCurrentProjectTask = historyTask && project.tasks.some((t) => t.id === historyTask.id)
      if (isCurrentProjectTask || cwd === project.path) {
        newTask()
      }
    },
    [cwd, historyTask, newTask]
  )

  const onSearchJump = useCallback(
    async (r: SearchResult) => {
      if (r.index < 0) {
        // File result: open it in the file tree panel
        if (!cwd) return
        const abs = absPath(cwd, r.text)
        const name = basenameOf(r.text)
        if (IS_PREVIEW) {
          setSelectedFile({ path: abs, content: '// simulated file content (preview mode)', name })
        } else {
          void window.AnyBuff.readFile(abs).then((res) => {
            if (res.ok) setSelectedFile({ path: abs, content: res.content ?? '', name })
          })
        }
        setRightOpen(true)
        setRightTab('files')
        return
      }

      // Check if the result belongs to the currently active task
      const isCurrentTask =
        (!r.taskId && !r.projectPath) ||
        (r.taskId === currentTaskRef.current && (!r.projectPath || r.projectPath === cwd))

      if (isCurrentTask) {
        const el = msgRefs.current[r.index]
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el?.classList.add('search-flash')
        setTimeout(() => el?.classList.remove('search-flash'), 1500)
        return
      }

      // Historical task: open it and set pending jump
      if (r.taskId && r.projectPath) {
        const targetProject = projects.find((p) => p.path === r.projectPath)
        const targetTask = targetProject?.tasks.find((t) => t.id === r.taskId)
        if (targetProject && targetTask) {
          setPendingJump({ taskId: r.taskId, index: r.index })
          await onOpenTask(targetProject, targetTask)
          return
        }
      }

      const el = msgRefs.current[r.index]
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el?.classList.add('search-flash')
      setTimeout(() => el?.classList.remove('search-flash'), 1500)
    },
    [cwd, projects, onOpenTask]
  )

  // Safe jump scrolling when loading a historical task from search
  useEffect(() => {
    if (!pendingJump) return
    const timer = setTimeout(() => {
      const el = msgRefs.current[pendingJump.index]
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('search-flash')
        setTimeout(() => el.classList.remove('search-flash'), 1500)
        setPendingJump(null)
      }
    }, 100)
    return () => clearTimeout(timer)
  }, [chatItems, pendingJump])

  // View-scoped run state: only the conversation being VIEWED shows streaming
  // cursors, stop buttons, and activity animations — background runs elsewhere
  // are surfaced via the sidebar spinner and the global topbar badge instead.
  const viewRunning = running && runningTaskId !== null && runningTaskId === activeViewTaskId
  const viewStopping = stopping && viewRunning
  const busyElsewhere = running && !viewRunning

  const streaming = viewRunning && chatItems.length > 0
  const currentStage = deriveStage(events, running)
  // Runs live in the main process now — navigating is always safe.
  const canSwitchProject = chatItems.length === 0 && !historyTask

  const models = settings.providers

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-left">
          <AppIcon size={16} />
          <nav className="titlebar-menus">
            <div className="titlebar-menu">
              <button className="titlebar-menu-btn">File</button>
              <div className="titlebar-menu-dropdown">
                <button className="menu-item" onClick={newTask}>New Task</button>
                <button className="menu-item" onClick={() => void selectFolder()}>Open Folder…</button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => setShowSettings(true)}>Settings</button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => window.AnyBuff.windowClose()}>Exit</button>
              </div>
            </div>
            <div className="titlebar-menu">
              <button className="titlebar-menu-btn">Edit</button>
              <div className="titlebar-menu-dropdown">
                <button className="menu-item" onClick={() => setSearchOpen(true)}>Find…</button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => document.execCommand('undo')}>Undo</button>
                <button className="menu-item" onClick={() => document.execCommand('redo')}>Redo</button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => document.execCommand('cut')}>Cut</button>
                <button className="menu-item" onClick={() => document.execCommand('copy')}>Copy</button>
                <button className="menu-item" onClick={() => void navigator.clipboard?.readText().then((t) => document.execCommand('insertText', false, t)).catch(() => {}) }>Paste</button>
                <button className="menu-item" onClick={() => document.execCommand('selectAll')}>Select All</button>
              </div>
            </div>
            <div className="titlebar-menu">
              <button className="titlebar-menu-btn">View</button>
              <div className="titlebar-menu-dropdown">
                <button className="menu-item" onClick={reloadPage}>Reload</button>
                <button className="menu-item" onClick={forceReloadPage}>Force Reload</button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={resetZoom}>Actual Size</button>
                <button className="menu-item" onClick={zoomIn}>Zoom In</button>
                <button className="menu-item" onClick={zoomOut}>Zoom Out</button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={toggleFullScreen}>Toggle Full Screen</button>
              </div>
            </div>
          </nav>
        </div>
        <div className="titlebar-drag-region" />
        {!IS_PREVIEW && (
          <div className="window-controls">
            <button className="window-control-btn" onClick={() => window.AnyBuff.windowMinimize()} title="Minimize">
              <WindowMinimizeIcon size={12} />
            </button>
            <button className="window-control-btn" onClick={() => window.AnyBuff.windowMaximize()} title={isMaximized ? 'Restore' : 'Maximize'}>
              {isMaximized ? <WindowRestoreIcon size={12} /> : <WindowMaximizeIcon size={12} />}
            </button>
            <button className="window-control-btn window-close-btn" onClick={() => window.AnyBuff.windowClose()} title="Close">
              <WindowCloseIcon size={12} />
            </button>
          </div>
        )}
      </header>
      <div className="app-body">
        {showAgentWizard && cwd ? (
          <AgentWizardModal
            cwd={cwd}
            onClose={() => {
              setShowAgentWizard(false)
              setShowSettings(true)
              setSettingsTab('agents')
            }}
            onCreated={({ id, filePath }) => {
              setShowAgentWizard(false)
              setShowSettings(true)
              setSettingsTab('agents')
              setNotice(`Created ${id}. Reload Custom Agents in Settings to use it. (${filePath})`)
            }}
          />
        ) : showSettings ? (
          <SettingsModal
            onClose={handleCloseSettings}
            onCreateAgent={openAgentWizard}
            onSaved={onSettingsSaved}
            theme={theme}
            onToggleTheme={toggleTheme}
            colorTheme={colorTheme}
            onSelectColorTheme={setColorTheme}
            initialTab={settingsTab}
          />
        ) : (
          <>
            <Sidebar
              open={leftOpen}
              onNewTask={newTask}
              searchOpen={searchOpen}
              onToggleSearch={() => setSearchOpen((v) => !v)}
              searchQuery={searchQuery}
              onSearchQuery={setSearchQuery}
              searchResults={searchResults}
              onSearchJump={onSearchJump}
              projects={projects}
              runningTaskId={runningTaskId}
              onNewProject={() => void selectFolder()}
              onOpenProject={(p) => void onOpenProject(p)}
              onOpenTask={(p, t) => void onOpenTask(p, t)}
              onRenameTask={onRenameTask}
              onDeleteTask={onDeleteTask}
              onRemoveProject={onRemoveProject}
              onSettings={() => setShowSettings(true)}
              currentProjectPath={cwd}
              activeTaskId={activeViewTaskId}
            />

            <main className="main">
              <header className="topbar">
                <div className="topbar-left">
                  <button
                    className="btn icon-only panel-toggle"
                    onClick={() => setLeftOpen((v) => !v)}
                    title={leftOpen ? 'Collapse sidebar' : 'Open sidebar'}
                  >
                    <PanelLeftIcon size={15} />
                  </button>
                  <div className="project-select" ref={projectMenuRef}>
                    <button
                      className={`project-name-btn${canSwitchProject ? '' : ' locked'}`}
                      onClick={canSwitchProject ? () => setProjectMenuOpen((v) => !v) : undefined}
                      title={canSwitchProject ? 'Choose project' : 'Project is locked while a conversation is active'}
                    >
                      {projectName ? <FolderIcon size={13} /> : <AppIcon size={14} />}
                      <span className="project-name">{projectName || 'Anybuff'}</span>
                      {canSwitchProject && <ChevronDownIcon size={12} />}
                    </button>
                    {projectMenuOpen && canSwitchProject && (
                      <div className="project-menu">
                        {projects.length === 0 && <div className="mention-empty">No projects yet</div>}
                        {projects.slice(0, 15).map((p) => (
                          <button
                            key={p.path}
                            className={`project-menu-item${p.path === cwd ? ' current' : ''}`}
                            onClick={() => {
                              setProjectMenuOpen(false)
                              if (p.path !== cwd) void onOpenProject(p.path)
                            }}
                            title={p.path}
                          >
                            {p.path === cwd ? <FolderOpenIcon size={13} /> : <FolderIcon size={13} />}
                            <span className="pm-name">{p.name}</span>
                          </button>
                        ))}
                        {projects.length > 0 && <div className="project-menu-sep" />}
                        <button
                          className="project-menu-item add"
                          onClick={() => {
                            setProjectMenuOpen(false)
                            void selectFolder()
                          }}
                        >
                          <FolderPlusIcon size={13} />
                          <span className="pm-name">Add Project…</span>
                        </button>
                      </div>
                    )}
                  </div>
                  {branch && <span className="branch-badge">⎇ {branch}</span>}
                  {running && (
                    <span
                      className="running-badge"
                      title={runningTaskId && runningTaskId !== currentTaskRef.current ? 'A task is running in another conversation' : undefined}
                    >
                      <span className="spinner-ring" /> {currentStage ?? 'Working'}
                    </span>
                  )}
                </div>
                <div className="topbar-right">
                  {!cwd && (
                    <button className="btn primary" onClick={() => void selectFolder()}>
                      <FolderIcon size={14} /> Select Folder
                    </button>
                  )}
                  {!hasProvider && (
                    <button className="btn warn" onClick={() => setShowSettings(true)}>
                      Set API Key
                    </button>
                  )}
                  <button
                    className="btn icon-only panel-toggle"
                    onClick={() => setRightOpen((v) => !v)}
                    title={rightOpen ? 'Collapse panel' : 'Open panel'}
                  >
                    <PanelRightIcon size={15} />
                  </button>
                </div>
              </header>

              {notice && (() => {
                const lower = notice.toLowerCase()
                const isWarning = lower.includes('stop') || lower.includes('failed') || lower.includes('error') || lower.includes('select a project')
                const isSuccess = lower.includes('saved') || lower.includes('created') || lower.includes('accepted') || lower.includes('reverted')
                return (
                  <div
                    className={`notice-toast ${isWarning ? 'warning' : isSuccess ? 'success' : 'info'}`}
                    onClick={() => setNotice(null)}
                    title="Click to dismiss"
                  >
                    {isWarning ? (
                      <AlertCircleIcon size={15} className="notice-toast-icon warning" />
                    ) : isSuccess ? (
                      <CheckCircleIcon size={15} className="notice-toast-icon success" />
                    ) : (
                      <InfoIcon size={15} className="notice-toast-icon info" />
                    )}
                    <span>{notice}</span>
                  </div>
                )
              })()}

              {!cwd ? (
                <div className="welcome">
                  <div className="welcome-logo">
                    <AppIcon size={72} />
                  </div>
                  <h1>Anybuff</h1>
                  <p className="welcome-sub">Use any model with a team of specialized sub-agents.</p>
                  <button className="btn primary big" onClick={() => void selectFolder()}>
                    <FolderIcon size={16} /> Select a Project Folder
                  </button>
                  {!hasProvider && (
                    <button className="link-btn" onClick={() => setShowSettings(true)}>
                      No provider configured? Open Settings →
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll}>
                    {!hasProvider && (
                      <div className="provider-warn">
                        <span>No provider configured. Please set up your API key and model in Settings.</span>
                        <button className="btn" onClick={() => setShowSettings(true)}>Open Settings</button>
                      </div>
                    )}

                    {chatItems.length === 0 && historyTask && (
                      <div className="panel-empty history-empty">This conversation has no saved messages yet.</div>
                    )}

                    {chatItems.length === 0 && !historyTask && (
                      <div className="welcome chat-welcome">
                        <div className="welcome-logo">
                          <AppIcon size={72} />
                        </div>
                        <h1>What are we building today?</h1>
                      </div>
                    )}

                    {chatItems.map((item, i) => {
                      if (item.kind === 'user') {
                        const isLastUser = chatItems.slice(i + 1).every((it) => it.kind !== 'user')
                        return (
                          <div key={i} ref={(el) => { msgRefs.current[i] = el }}>
                            <UserBubble
                              text={item.text}
                              onCopy={() => void navigator.clipboard?.writeText(item.text)}
                              onRevert={isLastUser && !viewRunning && !historyTask ? () => void requestRevert() : undefined}
                            />
                          </div>
                        )
                      }
                      if (item.kind === 'assistant') {
                        const isStreaming = streaming && i === chatItems.length - 1
                        return (
                          <div key={i} ref={(el) => { msgRefs.current[i] = el }}>
                            <AssistantBubble
                              text={item.text}
                              reasoning={item.reasoning}
                              streaming={isStreaming}
                              onCopy={() => void navigator.clipboard?.writeText(item.text)}
                            />
                          </div>
                        )
                      }
                      if (item.kind === 'tool') {
                        const isLastTool = i === chatItems.length - 1
                        return (
                          <div key={i} ref={(el) => { msgRefs.current[i] = el }}>
                            <ToolCard tool={item.tool} isLast={isLastTool && running} />
                          </div>
                        )
                      }
                      if (item.kind === 'file-changes') {
                        return (
                          <div key={i} ref={(el) => { msgRefs.current[i] = el }}>
                            <FileChangesSummary files={item.files} />
                          </div>
                        )
                      }
                      if (item.kind === 'compaction') {
                        return (
                          <div key={i} className="msg-row system" ref={(el) => { msgRefs.current[i] = el }}>
                            <span className="system-bubble compaction-note">ℹ {item.text}</span>
                          </div>
                        )
                      }
                      if (
                        item.text.includes('suggest_followups already ended') ||
                        item.text.includes('No more non-terminal tools are available after followups') ||
                        item.text.includes('Invalid parameters for') ||
                        item.text.includes('Raw validation issues:') ||
                        item.text.includes('Stop requested. Waiting for agent to safely halt')
                      ) {
                        return null
                      }
                      return (
                        <div key={i} className="msg-row system" ref={(el) => { msgRefs.current[i] = el }}>
                          <span className="system-bubble">⚠ {item.text}</span>
                        </div>
                      )
                    })}

                    {followups.length > 0 && (
                      <div className="followups">
                        <span className="followups-label">Suggested next steps</span>
                        {followups.map((f, i) => (
                          <button
                            key={i}
                            className="followup-card"
                            disabled={running}
                            onClick={() => setPrompt(f.prompt)}
                            title={f.label && f.label !== f.prompt ? f.prompt : undefined}
                          >
                            {f.label || f.prompt}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {retryNotice && viewRunning && (
                    <div className={`retry-strip reason-${retryNotice.reason ?? 'network'}`}>
                      <span className="spinner-ring retry-spinner" />
                      <span className="resume-text">
                        <span className="resume-text-main">{autoRetryStripText(retryNotice, nowTick)}</span>
                        {retryNotice.detail && (
                          <span className="resume-text-detail" title={retryNotice.detail}>
                            {retryNotice.detail.length > 220 ? `${retryNotice.detail.slice(0, 220)}…` : retryNotice.detail}
                          </span>
                        )}
                      </span>
                    </div>
                  )}

                  {resumeInfo && !viewRunning && (
                    <div className={`resume-banner reason-${resumeInfo.reason ?? 'error'}`}>
                      <span className="resume-icon">{resumeInfo.reason === 'rate-limit' ? '⚠' : '↻'}</span>
                      <span className="resume-text">
                        <span className="resume-text-main">{resumeBannerText(resumeInfo.reason)}</span>
                        {resumeInfo.errorMessage && (
                          <span className="resume-text-detail" title={resumeInfo.errorMessage}>
                            {resumeInfo.errorMessage.length > 220 ? `${resumeInfo.errorMessage.slice(0, 220)}…` : resumeInfo.errorMessage}
                          </span>
                        )}
                      </span>
                      <button className="btn primary small" onClick={() => void resumeRun()}>
                        Resume
                      </button>
                      <button className="btn ghost small" onClick={discardResume} title="Discard the preserved state and start fresh">
                        Discard
                      </button>
                    </div>
                  )}

                  {approvalRequest && (
                    <div className="resume-banner" style={{ border: '1px solid var(--border-warn, #f59e0b)' }}>
                      <span className="resume-icon" style={{ color: '#f59e0b' }}>🛡</span>
                      <span className="resume-text">
                        <strong>Action requires approval:</strong> {approvalRequest.message}
                      </span>
                      <button
                        className="btn primary small"
                        onClick={() => {
                          setApprovalRequest(null)
                          void window.AnyBuff.respondApproval(true)
                        }}
                      >
                        Allow
                      </button>
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          setApprovalRequest(null)
                          void window.AnyBuff.respondApproval(false)
                        }}
                      >
                        Deny
                      </button>
                    </div>
                  )}

                  {pendingAskUser && pendingAskUser.length > 0 && (
                    <AskUserBanner
                      questions={pendingAskUser}
                      onRespond={(payload) => {
                        setPendingAskUser(null)
                        window.AnyBuff.respondAskUser(payload)
                      }}
                    />
                  )}
                  {activeTodos.length > 0 && viewRunning && (
                    <div className="todo-panel-dock">
                      <TodoCard todos={activeTodos} collapsed={todoPanelCollapsed} onToggleCollapse={() => setTodoPanelCollapsed((c) => !c)} />
                    </div>
                  )}

                  <MessageQueuePanel
                    items={queuedMessages}
                    onEdit={(id, text) => void queueEdit(id, text)}
                    onDelete={queueDelete}
                    onMove={queueMove}
                    onSendNext={queueSendNext}
                  />
                  <Composer
                    prompt={prompt}
                    onChange={setPrompt}
                    onSend={() => void send()}
                    onStop={stop}
                    onNewTask={newTask}
                    onInitRequest={openAgentWizard}
                    onSearchRequest={() => setSearchOpen(true)}
                    running={viewRunning}
                    stopping={viewStopping}
                    sendBlocked={busyElsewhere}
                    sendBlockedHint="Another task is still running — wait for it to finish or stop it first."
                    disabled={!hasProvider}
                    attachments={attachments}
                    onAttachFiles={() => void onAttachFiles()}
                    onAttachFilesPath={onAttachFilesPath}
                    onRemoveAttachment={onRemoveAttachment}
                    providers={models}
                    activeModel={settings.activeModel}
                    onModelChange={onModelChange}
                    reasoningEffort={settings.reasoningEffort}
                    onReasoningChange={onReasoningChange}
                    agentMode={agentMode}
                    onAgentModeChange={setAgentMode}
                    tokenUsage={tokenUsage}
                    totalCost={totalCost}
                    fileCandidates={fileCandidates}
                    skills={skills}
                    focusSignal={focusSignal}
                  />
                </>
              )}
            </main>

            <RightPanel
              open={rightOpen}
              tab={rightTab}
              onTab={onRightTab}
              cwd={cwd}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              onOpenFile={(path) => void openFileByPath(path, basenameOf(path))}
              events={events}
              onCloseFile={() => setSelectedFile(null)}
              running={viewRunning}
            />
          </>
        )}
      </div>

      {pendingRevert && (
        <div className="modal-backdrop" onClick={() => setPendingRevert(null)}>
          <div className="modal revert-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Revert this exchange?</h2>
            <p className="hint">
              {pendingRevert.files.length > 0
                ? `This will undo the changes made to ${pendingRevert.files.length} file(s) in this conversation:`
                : 'This will discard this exchange from the conversation.'}
            </p>
            {pendingRevert.files.length > 0 && (
              <div className="revert-file-list">
                {pendingRevert.files.slice(0, 8).map((f) => (
                  <div key={f} className="revert-file">
                    {f}
                  </div>
                ))}
                {pendingRevert.files.length > 8 && (
                  <div className="revert-file more">… and {pendingRevert.files.length - 8} more</div>
                )}
              </div>
            )}
            <p className="hint">Your original message will be restored in the input box as unsent text, so you can edit and resend it.</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setPendingRevert(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void confirmRevert()}>
                Revert
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}