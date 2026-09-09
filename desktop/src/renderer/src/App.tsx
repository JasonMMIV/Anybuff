import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AskUserBanner from './components/AskUserBanner'
import Sidebar, { type ProjectRecord, type TaskRecord, type SearchResult } from './components/Sidebar'
import RightPanel, { type RightTab } from './components/RightPanel'
import SettingsModal from './components/SettingsModal'
import AgentWizardModal from './components/AgentWizardModal'
import ErrorBoundary from './components/ErrorBoundary'
import Composer, { type AgentMode, type AgentMentionInfo, type Attachment, type SkillInfo } from './components/Composer'
import MessageQueuePanel, { type QueuedMessage } from './components/MessageQueuePanel'
import ReviewScopePanel from './components/ReviewScopePanel'
import DiagnosticsModal from './components/DiagnosticsModal'
import RunElapsed from './components/RunElapsed'
import {
  buildInterviewPrompt,
  buildReviewPrompt,
  REVIEW_SCOPE_OPTIONS,
  type ReviewScope
} from './utils/prompt-builders'
import { formatBashContext, type BashCommandResult } from './utils/bash-context'
import {
  isNotificationSoundEnabled,
  playRunFinishedSound,
  playRunInterruptedSound,
  playRunPausedSound,
  setNotificationSoundEnabled
} from './utils/notification-sounds'
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
  UndoIcon,
  WindowMinimizeIcon,
  WindowMaximizeIcon,
  WindowRestoreIcon,
  WindowCloseIcon,
  XIcon
} from './components/Icons'
import type { TreeNode } from './components/FileTree'
import type { UiEvent } from '../../preload'

interface UiSettings {
  providers: { id: string; label: string; models: string[] }[]
  activeModel: string
  reasoningEffort: string
  approvalMode: string
  /** ADR-25 per-model reasoning ladders (qualified + bare-id keys) from host settings. */
  reasoningLadders?: Record<string, string[]>
}

type ChatItem =
  | { kind: 'user'; text: string; ts?: number }
  | { kind: 'assistant'; text: string; reasoning?: string; ts?: number }
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

/** Mobile/WebView cap on in-view conversation items (see the trim effect). */
const MAX_MOBILE_CHAT_ITEMS = 300

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
    case 'context-overflow':
      return 'The conversation exceeded this model’s context limit — history was compressed and the run can be resumed. If it keeps happening, switch models or declare windowTokens in anybuff.json.'
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
  { kind: 'user', text: 'Add zero-division error handling to the divide function', ts: Date.now() - 240_000 },
  {
    kind: 'assistant',
    text: 'Let me look at the current `calculator.js` before planning the change.\n\n```js\n// src/calculator.js\nexport function divide(a, b) {\n  return a / b\n}\n```\n\nThis function divides directly, so it returns `Infinity` when `b` is 0. I\'ll add an explicit zero-division check.',
    ts: Date.now() - 210_000
  },
  { kind: 'tool', tool: { toolName: 'code_search', status: 'done', detail: '12 matches in 4 files', toolInput: { pattern: 'zero\\s+division', flags: '-n -g *.ts', cwd: 'src', maxResults: 15 } } },
  { kind: 'tool', tool: { toolName: 'read_files', status: 'done', detail: '3 files inspected', toolInput: { paths: ['src/config.ts', '.env', 'id_rsa'] }, blockedPaths: ['.env', 'id_rsa'] } },
  { kind: 'tool', tool: { toolName: 'edit_transaction', status: 'done', agentType: 'editor', detail: 'applied 1 edit: src/calculator.js\n+  if (b === 0) {\n+    throw new RangeError(\'Cannot divide by zero\')\n+  }' } },
  {
    kind: 'assistant',
    text: 'Done:\n\n- `divide` now throws a `RangeError` when the divisor is 0\n- The original calculation logic is preserved\n\n```js\nexport function divide(a, b) {\n  if (b === 0) {\n    throw new RangeError(\'Cannot divide by zero\')\n  }\n  return a / b\n}\n```',
    ts: Date.now() - 180_000
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

/**
 * Round 12 (Android theme follow-system): the Android WebView derives
 * prefers-color-scheme from the hosting Activity theme's android:isLightTheme
 * attribute — NOT from the system uiMode/night setting — and with uiMode kept
 * in android:configChanges (deliberately no Activity recreation; recreating
 * would tear down the WebView and re-race the sandbox boot) the media query
 * never live-updates when the system toggles dark mode (Chromium
 * aw_dark_mode.cc / DarkModeHelper.java; Google issuetracker 170328697;
 * react-native-webview#3013). The Kotlin shell therefore injects the TRUE
 * system theme as window.__ANYBUFF_SYSTEM_THEME__ and pushes changes as
 * 'anybuff:system-theme-change' DOM events. On desktop both helpers are
 * inert (no injected global, event never fires) and matchMedia stays the
 * single source — zero desktop behavior change (is-webview discipline).
 */

/** The shell-injected system theme, when present (Android WebView only). */
function getSystemTheme(): 'dark' | 'light' | null {
  const injected = (window as unknown as { __ANYBUFF_SYSTEM_THEME__?: unknown }).__ANYBUFF_SYSTEM_THEME__
  return injected === 'dark' || injected === 'light' ? injected : null
}

/** Subscribe to shell-pushed system theme changes (never fired on desktop). */
function onSystemThemeChange(callback: () => void): () => void {
  window.addEventListener('anybuff:system-theme-change', callback)
  return () => window.removeEventListener('anybuff:system-theme-change', callback)
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

export type ColorTheme = 'default' | 'black' | 'vermillion' | 'amber' | 'teal'

/** #18 OS 深淺色自動跟隨：'system' follows the OS; 'dark'/'light' pin it. */
export type ThemeMode = 'system' | 'dark' | 'light'

export default function App() {
  // Browser preview mode (no Electron preload and no WS host): the UI renders
  // with mock data. Deliberately evaluated INSIDE the component — a module-level
  // check would freeze before main.tsx assigns window.AnyBuff (ES import
  // hoisting evaluates App.tsx first), which sent the Android WebView into demo
  // mode (fake calculator.js attach, mocked state) even though a WS host existed.
  const [isPreview] = useState(() => typeof window.AnyBuff === 'undefined')
  // #18 OS 深淺色自動跟隨：'system' resolves live through matchMedia; legacy
  // 'AnyBuff-theme' values ('dark'/'light') migrate to the pinned modes.
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('AnyBuff-theme-mode')
    if (saved === 'system' || saved === 'dark' || saved === 'light') return saved
    const legacy = localStorage.getItem('AnyBuff-theme')
    return legacy === 'light' ? 'light' : legacy === 'dark' ? 'dark' : 'system'
  })
  /** Resolved dark/light actually applied to the DOM. */
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('AnyBuff-theme-mode')
    const mode = saved === 'dark' || saved === 'light' ? saved : 'system'
    if (mode !== 'system') return mode
    // Round 12: prefer the shell-injected system theme (Android WebView —
    // its media query is pinned to the Activity theme, not the system uiMode);
    // matchMedia remains the source on desktop/preview.
    const injected = getSystemTheme()
    if (injected) return injected
    return typeof window.matchMedia !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() => {
    const saved = localStorage.getItem('AnyBuff-color-theme') as ColorTheme | null
    if (saved === ('grey' as unknown)) return 'default'
    return saved || 'default'
  })
  /**
   * Gentle notification sounds on run finish / interrupt / user-input pause
   * (renderer-local; persisted under the 'AnyBuff-*' localStorage keys).
   */
  const [notificationSound, setNotificationSound] = useState<boolean>(() => isNotificationSoundEnabled())
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

  // Narrow screens (phones) start with the sidebar collapsed; toggling it
  // open pushes the main content (flex layout) rather than overlaying it.
  const [leftOpen, setLeftOpen] = useState(
    () =>
      typeof window.matchMedia !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
        ? false
        : true
  )
  const [rightOpen, setRightOpen] = useState(false)
  const [rightTab, setRightTab] = useState<RightTab>('activity')

  const toggleLeft = useCallback(() => {
    setLeftOpen((v) => {
      const next = !v
      if (next && typeof window.matchMedia !== 'undefined' && window.matchMedia('(max-width: 640px)').matches) {
        setRightOpen(false)
      }
      return next
    })
  }, [])

  const toggleRight = useCallback(() => {
    setRightOpen((v) => {
      const next = !v
      if (next && typeof window.matchMedia !== 'undefined' && window.matchMedia('(max-width: 640px)').matches) {
        setLeftOpen(false)
      }
      return next
    })
  }, [])

  const [showSettings, setShowSettings] = useState(false)
  /** #15：/diagnostics 診斷面板（獨立 Modal，不污染對話串）。 */
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'general' | 'providers' | 'theme' | 'routing' | 'agents' | 'search'>('general')
  const [showAgentWizard, setShowAgentWizard] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** The local engine host (proot/Node) died: WS closed, every call fails fast. */
  const [hostDown, setHostDown] = useState(false)

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [tokenUsage, setTokenUsage] = useState<{ used: number; max: number } | null>(null)
  const [totalCost, setTotalCost] = useState(0)
  // #17 保險絲: per-run step cap (0 = SDK default) + cost mode — persisted via settings.
  const [maxAgentSteps, setMaxAgentSteps] = useState(0)
  const [costMode, setCostMode] = useState<'normal' | 'max' | 'lite'>('normal')
  // #20/ADR-23 agents offered by the @-mention menu — the current MODE root's
  // spawnable agents (.agents/ locals included). Picking one only inserts
  // `@id ` into the draft; the root never changes (upstream semantics).
  const [agentMentions, setAgentMentions] = useState<AgentMentionInfo[]>([])
  /** #9 bash results accumulated since the last prompt send (become context). */
  const pendingBashRef = useRef<BashCommandResult[]>([])

  const [searchOpen, setSearchOpen] = useState(false)
  // #5 第二批：/review scope picker 與 /interview 模式狀態
  const [reviewScopeOpen, setReviewScopeOpen] = useState(false)
  const [interviewArmed, setInterviewArmed] = useState(false)
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
  /** Ticking clock so the retry strip + the #22 elapsed timer stay live. */
  const [nowTick, setNowTick] = useState(() => Date.now())
  /** #22：目前 run 的啟動時間（頂欄 badge / Composer 的即時耗時由此推算）。 */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
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
  // #17: mirrors for stable callbacks without widening dep lists.
  const maxAgentStepsRef = useRef(maxAgentSteps)
  maxAgentStepsRef.current = maxAgentSteps
  const costModeRef = useRef(costMode)
  costModeRef.current = costMode
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const msgRefs = useRef<(HTMLDivElement | null)[]>([])
  // Stable per-row ref: the index is read from data-index, so the callback
  // identity never changes between renders. A fresh `(el) => { msgRefs[i] = el }`
  // per render would force React to detach/reattach every row on every render
  // and defeat the memoized row components below.
  const setMsgRef = useCallback((el: HTMLDivElement | null) => {
    if (el) msgRefs.current[Number(el.dataset.index)] = el
  }, [])

  // #18 Theme mode switch: persist the user choice, resolve 'system' against
  // the OS preference, and keep following live OS changes while in system mode.
  // Round 12 (Android): the WebView's prefers-color-scheme is derived from the
  // Activity theme's android:isLightTheme attribute — NOT the system uiMode —
  // and with uiMode in android:configChanges it never live-updates (Chromium
  // aw_dark_mode.cc / DarkModeHelper.java; Google issuetracker 170328697;
  // react-native-webview#3013). The Kotlin shell therefore injects the true
  // system theme (window.__ANYBUFF_SYSTEM_THEME__) and pushes changes as
  // 'anybuff:system-theme-change' events; when the global is absent (desktop
  // Electron, browser preview) matchMedia remains the single source — zero
  // desktop behavior change.
  useEffect(() => {
    if (typeof window.matchMedia === 'undefined') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      setTheme((prev) => {
        // Shell-injected system theme wins when present (Android WebView).
        const native = getSystemTheme()
        const next = themeMode === 'system' ? (native ?? (mq.matches ? 'dark' : 'light')) : themeMode
        return next === prev ? prev : next
      })
    }
    apply()
    // Chrome/Chromium ≥ 84 supports addEventListener on MediaQueryList.
    mq.addEventListener?.('change', apply)
    // Android shell pushes system dark-mode toggles the WebView media query
    // cannot observe (round 12); never fired on desktop.
    const unsubSystemTheme = onSystemThemeChange(apply)
    return () => {
      mq.removeEventListener?.('change', apply)
      unsubSystemTheme()
    }
  }, [themeMode])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('AnyBuff-theme-mode', themeMode)
    localStorage.setItem('AnyBuff-theme', theme)
    if (!isPreview) window.AnyBuff.setTheme(theme)
  }, [theme, themeMode, isPreview])

  // Color theme switch
  useEffect(() => {
    document.documentElement.dataset.colorTheme = colorTheme
    localStorage.setItem('AnyBuff-color-theme', colorTheme)
  }, [colorTheme])

  // Window maximize state (frameless title bar)
  useEffect(() => {
    if (isPreview) return
    void window.AnyBuff.windowIsMaximized().then(setIsMaximized)
    const unsub = window.AnyBuff.onWindowMaximizeChange(setIsMaximized)
    return unsub
  }, [isPreview])



  const reloadPage = useCallback(() => {
    if (isPreview) return
    window.AnyBuff.windowReload()
  }, [])

  const forceReloadPage = useCallback(() => {
    if (isPreview) return
    window.AnyBuff.windowForceReload()
  }, [])

  const zoomIn = useCallback(() => {
    if (isPreview) return
    setZoomLevel((prev) => {
      const next = Math.min(prev + 10, 300)
      window.AnyBuff.setZoomFactor(next / 100)
      return next
    })
  }, [])

  const zoomOut = useCallback(() => {
    if (isPreview) return
    setZoomLevel((prev) => {
      const next = Math.max(prev - 10, 30)
      window.AnyBuff.setZoomFactor(next / 100)
      return next
    })
  }, [])

  const resetZoom = useCallback(() => {
    if (isPreview) return
    setZoomLevel(100)
    window.AnyBuff.setZoomFactor(1)
  }, [])

  const toggleFullScreen = useCallback(() => {
    if (isPreview) return
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

  // #18: 'system' | 'dark' | 'light' — the Settings modal offers all three.
  const selectThemeMode = useCallback((mode: ThemeMode) => setThemeMode(mode), [])

  const selectNotificationSound = useCallback((on: boolean) => {
    setNotificationSound(on)
    setNotificationSoundEnabled(on)
  }, [])

  /**
   * Cold-start state load (round 12): pulled out of the mount effect so the
   * host-reconnected listener can re-run it. A getState that failed while the
   * WS socket was still CONNECTING (pre-round-12 shim fail-fast, or across a
   * mid-boot engine restart) used to strand the app on the welcome screen
   * with an empty sidebar — the only recovery was opening Settings and back
   * out (its close handler re-fetches state). Behavior is identical to the
   * old inline IIFE.
   */
  const loadInitialState = useCallback(() => {
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
          maxAgentSteps?: number
          costMode?: 'normal' | 'max' | 'lite'
          reasoningLadders?: Record<string, string[]>
        }
      }
      setCwd(state.cwd)
      setRunning(state.running)
      setRunningTaskId((state as { runningTaskId?: string | null }).runningTaskId ?? null)
      // #22：重新載入時若 run 仍在進行，以載入時間為近似起點。
      setRunStartedAt(state.running ? Date.now() : null)
      setHasProvider(state.settings.hasProvider)
      setSettings({
        providers: state.settings.providers,
        activeModel: state.settings.activeModel,
        reasoningEffort: state.settings.reasoningEffort,
        approvalMode: state.settings.approvalMode,
        reasoningLadders: state.settings.reasoningLadders ?? {}
      })
      setProjects(state.settings.projects ?? [])
      // #17 restore persisted run guardrails
      setMaxAgentSteps(typeof state.settings.maxAgentSteps === 'number' ? state.settings.maxAgentSteps : 0)
      setCostMode(state.settings.costMode ?? 'normal')
    })()
  }, [])

  // Initial state
  useEffect(() => {
    if (isPreview) {
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
    loadInitialState()
  }, [isPreview, loadInitialState])

  // Project name, git branch, @-file candidates, skills
  useEffect(() => {
    if (!cwd) return
    if (isPreview) {
      setFileCandidates(['src/calculator.js', 'src/index.js', 'README.md', 'package.json'])
      return
    }
    void window.AnyBuff.projectName(cwd).then(setProjectName)
    void window.AnyBuff.gitBranch(cwd).then(setBranch)
    void window.AnyBuff.listFiles(cwd).then((t) => setFileCandidates(flattenTree(t as TreeNode[], cwd)))
    void window.AnyBuff.listSkills(cwd).then((s) => setSkills(s as SkillInfo[]))
  }, [cwd, isPreview])

  // #20/ADR-23 @-mention menu — the current MODE root's spawnable agents,
  // resolved host-side from the run's own merged agent definitions so the
  // menu can never offer an agent the root cannot spawn (upstream
  // loadLocalAgents(agentMode) semantics; .agents/ locals override bundled
  // ids with the same name). Re-resolves whenever the folder OR the mode
  // changes — Chat/Build/Plan roots have different spawnable sets.
  useEffect(() => {
    if (!cwd) return
    if (isPreview) {
      setAgentMentions([
        { id: 'researcher-web', displayName: 'Web Researcher' },
        { id: 'researcher-docs', displayName: 'Docs Researcher' },
        { id: 'thinker', displayName: 'Thinker' }
      ])
      return
    }
    void window.AnyBuff
      .listMentionAgents(cwd, agentMode)
      // Guard the envelope: a failed dispatch / WS timeout resolves
      // { ok: false, error } (truthy) — without the Array.isArray check the
      // composer's agentMentions.filter would crash on a non-array.
      .then((res) => setAgentMentions(Array.isArray(res) ? (res as AgentMentionInfo[]) : []))
      .catch(() => setAgentMentions([]))
  }, [cwd, agentMode, isPreview])

  // Auto-scroll to bottom — paused while the user has scrolled up to read
  // history; scrolling back near the bottom resumes following the stream.
  useEffect(() => {
    if (!autoScrollRef.current) return
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight })
  }, [chatItems])

  // The WS shim dispatches this when the engine socket closes (host process
  // died / was killed). Surface a restart overlay — otherwise the UI silently
  // freezes: every request times out and no events ever arrive again.
  useEffect(() => {
    if (isPreview) return
    const onDown = (): void => setHostDown(true)
    window.addEventListener('anybuff:host-disconnected', onDown)
    return () => window.removeEventListener('anybuff:host-disconnected', onDown)
  }, [isPreview])

  // Android: a folder picked in SAF while this page was being (re)created — the
  // requesting page died with the old WebView, so the shell stages the guest
  // path and pushes it here once the page can run JS. Applied via
  // applyOpenedFolder (declared below with the other handlers).
  // cwdRef mirrors cwd for the pull below without re-running the effect on
  // every cwd change mid-pick (the pull itself must not re-fire on cwd updates).
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  useEffect(() => {
    if (isPreview) return
    const nativeTakeStagedFolder = (
      window as unknown as { __ANYBUFF_NATIVE__?: { takeStagedFolder?: () => Promise<string | null> } }
    ).__ANYBUFF_NATIVE__?.takeStagedFolder
    const onFolderPending = (ev: Event): void => {
      const path = (ev as CustomEvent<string>).detail
      if (typeof path !== 'string' || !path) return
      // The shell stages EVERY successful SAF copy and may flush it after the
      // live pickFolder() reply already applied the same path (dual delivery
      // by design — the staged copy is the self-healing fallback when the live
      // reply is lost). Deduplicate here: re-applying the folder we are
      // already in would reset the view and wipe an in-progress conversation.
      if (path === cwd) return
      applyOpenedFolderRef.current(path)
      // Mirror selectFolder's persistence so a later reload restores the project.
      void window.AnyBuff.saveCwd?.(path)
      void window.AnyBuff.touchProject?.(path)
      void window.AnyBuff.listProjects().then((p) => setProjects(p as ProjectRecord[]))
    }
    window.addEventListener('anybuff:folder-pending', onFolderPending)
    // PULL the staged pick once this page is ready to apply it. The shell's
    // PUSH (flushPendingFolder, from onPageFinished) can fire before the
    // freshly (re)created page's React app has mounted this listener —
    // onPageFinished races module evaluation — so a reload could silently
    // lose a pick. Pulling closes that hole; the shell delivers single-shot
    // (only the pull clears its holder) and the cwd dedupe above makes a
    // push+pull double delivery harmless.
    if (nativeTakeStagedFolder) {
      void nativeTakeStagedFolder().then((path) => {
        if (typeof path === 'string' && path && path !== cwdRef.current) onFolderPending(
          new CustomEvent('anybuff:folder-pending', { detail: path })
        )
      })
    }
    return () => window.removeEventListener('anybuff:folder-pending', onFolderPending)
  }, [isPreview, cwd])

  // Android shell pushes folder-import progress as DOM events during the SAF
  // copy (a large project can take minutes over DocumentsProvider IPC).
  // Surface it as a notice so silence never reads as "the pick did nothing".
  useEffect(() => {
    if (isPreview) return
    const onProgress = (ev: Event): void => {
      const d = (ev as CustomEvent<{ phase?: string; copied?: number; error?: string }>).detail
      if (!d || typeof d !== 'object') return
      if (d.phase === 'copying') setNotice(`Importing project folder… ${d.copied ?? 0} files copied`)
      else if (d.phase === 'done') setNotice(null)
      else if (d.phase === 'error' && d.error) setNotice(`Folder import failed: ${d.error}`)
    }
    window.addEventListener('anybuff:folder-progress', onProgress)
    return () => window.removeEventListener('anybuff:folder-progress', onProgress)
  }, [isPreview])

  // Mobile/WebView only: cap the in-view conversation so a long session cannot
  // balloon the renderer's DOM past what the device can hold — unbounded growth
  // is the classic trigger for render-process death (the app then white-screens
  // with no clicks). Full history stays in the host; switching tasks reloads it.
  useEffect(() => {
    if (!document.documentElement.classList.contains('is-webview')) return
    if (chatItems.length <= MAX_MOBILE_CHAT_ITEMS) return
    setChatItems((prev) => {
      if (prev.length <= MAX_MOBILE_CHAT_ITEMS) return prev
      const existing = prev.find((i) => i.kind === 'system' && i.text.startsWith('Older messages were trimmed'))
      const keep = prev.slice(-(MAX_MOBILE_CHAT_ITEMS - 1))
      if (existing) return [existing, ...keep]
      return [
        {
          kind: 'system',
          text: 'Older messages were trimmed to keep this device responsive. Full history stays in the sidebar.'
        },
        ...keep
      ]
    })
  }, [chatItems.length])

  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  // Tick while an auto-retry countdown is visible so its seconds stay live.
  // (The #22 elapsed timer is a self-contained component with its own 1s
  // clock — it must not re-render the whole App every second.)
  useEffect(() => {
    if (!retryNotice) return
    const timer = setInterval(() => setNowTick(Date.now()), 500)
    return () => clearInterval(timer)
  }, [retryNotice])

  // SDK events → UI
  useEffect(() => {
    if (isPreview) return
    const unsubscribe = window.AnyBuff.onEvent((event) => {
      /* ── Global lifecycle events (apply regardless of visible conversation) ── */

      // Run ownership lives in the main process; these events keep the global
      // running indicator accurate even when viewing another conversation.
      if (event.type === 'run_status') {
        if (event.status === 'running') {
          setRunning(true)
          if (event.taskId) setRunningTaskId(event.taskId)
          // #22：計時起點。同一 run 的後續 running 事件（L3 retry / resume）
          // 保留第一個起點，避免重新計時。
          setRunStartedAt((prev) => prev ?? Date.now())
        } else {
          setRunning(false)
          setRunningTaskId(null)
          setRunStartedAt(null)
          // Notification cue: a terminal run transition the user may not be
          // watching — 'idle' = finished successfully, 'interrupted' = stopped/errored.
          if (event.status === 'interrupted') playRunInterruptedSound()
          else playRunFinishedSound()
        }
        // Any run transition ends the current retry wait (a new attempt is
        // starting, or the run reached a terminal state).
        setRetryNotice(null)
        return
      }

      // Approval requests pause the single active run wherever it is — always surface.
      if ((event as any).type === 'ask_user') {
        playRunPausedSound()
        const qs = (event as any).raw
        setPendingAskUser(Array.isArray(qs) && qs.length > 0 ? qs : null)
        setAskSelections({})
        setAskOther({})
        return
      }

      if (event.type === 'approval_request') {
        playRunPausedSound()
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
            const last = next[next.length - 1] as { kind: 'assistant'; text: string; reasoning?: string; ts?: number }
            next[next.length - 1] = { kind: 'assistant', text: last.text, reasoning: (last.reasoning ?? '') + delta, ts: last.ts }
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
            const last = next[next.length - 1] as { kind: 'assistant'; text: string; reasoning?: string; ts?: number }
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
              reasoning: last.reasoning,
              ts: last.ts
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
          todos: event.toolName === 'write_todos' && Array.isArray(event.todos) ? event.todos : undefined,
          toolInput: event.toolInput,
          blockedPaths: event.blockedPaths
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
        // #21 訊息 footer 完成時間戳：stamp the assistant message that just finished.
        const completedAt = Date.now()
        setChatItems((prev) => {
          const next = [...prev]
          for (let i = next.length - 1; i >= 0; i--) {
            const item = next[i]
            if (item.kind === 'assistant') {
              next[i] = { ...item, ts: completedAt }
              break
            }
          }
          return next
        })
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
  }, [isPreview])

  // Keep chatItems in a ref for event callbacks
  const chatItemsRef = useRef(chatItems)
  chatItemsRef.current = chatItems

  const refreshProjects = useCallback(() => {
    if (isPreview) return
    void window.AnyBuff.listProjects().then((p) => setProjects(p as ProjectRecord[]))
  }, [isPreview])

  const openAgentWizard = useCallback(() => {
    if (!cwd) {
      setNotice('Select a project folder before creating a custom agent.')
      return
    }
    setShowSettings(false)
    setShowAgentWizard(true)
  }, [cwd])

  /** #15：開啟診斷面板（Settings → About「Diagnostics」快捷按鈕）。 */
  const openDiagnostics = useCallback(() => {
    setShowSettings(false)
    setShowAgentWizard(false)
    setShowDiagnostics(true)
  }, [])

  // The local engine host (proot/Node) died or its socket broke: the WS shim
  // dispatched anybuff:host-disconnected and the recovery overlay is up. The
  // renderer cannot restart the host by itself — the shell tears the sandbox
  // down, boots it again and reloads this page with the fresh WS URL. In
  // shells without a native restart bridge (browser preview), fall back to a
  // page reload: it re-reads the ?ws= URL, and the shim's reconnect loop
  // finishes the job once the host is back.
  const retryEngine = useCallback(() => {
    const native = (window as unknown as { __ANYBUFF_NATIVE__?: { restartEngine?: () => void } }).__ANYBUFF_NATIVE__
    if (native?.restartEngine) {
      native.restartEngine()
      return
    }
    window.location.reload()
  }, [])

  // The shim dispatches this once a reconnect attempt succeeds. Dismiss the
  // overlay instead of trapping the user on it forever — a socket-only break
  // (engine alive) recovers with no reload, and a browser preview recovers
  // automatically when the host comes back up.
  useEffect(() => {
    if (isPreview) return
    const onUp = (): void => {
      setHostDown(false)
      // Round 12 symptom 3 self-heal: a cold-start getState that failed while
      // the socket was still connecting left the app on the welcome screen
      // with an empty sidebar even though the engine came up seconds later.
      // The socket is demonstrably open now — if cwd is STILL unset, re-fetch
      // the state. The null guard keeps an in-progress conversation untouched
      // (mirrors the cwd dedupe discipline of the folder-pending handler).
      // cwdRef (not a cwd dep) avoids re-registering the listener on every
      // project switch.
      if (cwdRef.current == null) loadInitialState()
    }
    window.addEventListener('anybuff:host-reconnected', onUp)
    return () => window.removeEventListener('anybuff:host-reconnected', onUp)
  }, [isPreview, loadInitialState])

  // Shared by selectFolder and the Android folder-pending push: reset the view
  // to a fresh conversation in the newly opened project. The ref lets the
  // folder-pending listener (declared earlier) reach it without a TDZ issue.
  const applyOpenedFolder = useCallback(
    (path: string) => {
      setCwd(path)
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
    },
    [setViewTask],
  )
  const applyOpenedFolderRef = useRef(applyOpenedFolder)
  applyOpenedFolderRef.current = applyOpenedFolder

  const selectFolder = useCallback(async () => {
    if (isPreview) return
    try {
      const path = await window.AnyBuff.selectFolder()
      if (!path) return
      applyOpenedFolder(path as string)
      refreshProjects()
    } catch (err) {
      // Copy failures / picker errors surface instead of silently doing nothing
      // (the folder pick used to fail quiet — UI stayed on "no project yet").
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }, [refreshProjects, setViewTask, applyOpenedFolder])

  // Compose final prompt: resolve @ files, /skills, and attachments
  const buildFinalPrompt = useCallback(
    async (raw: string, extraAttachments?: Attachment[]): Promise<string> => {
      const lines: string[] = []
      let text = raw

      // Resolve /skill:name token
      const skillTokens = text.match(/\/skill:([\w.-]+)/g) ?? []
      for (const token of skillTokens) {
        const name = token.replace('/skill:', '')
        const skill = skills.find((s) => s.name === name)
        if (skill && skill.path && !isPreview) {
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
      const allAttachments = [...(extraAttachments ?? attachments)]
      for (const rel of mentionPaths) {
        if (!allAttachments.some((a) => a.path === rel)) {
          allAttachments.push({ path: rel, name: basenameOf(rel), isDir: false, isRelative: true })
        }
      }

      if (allAttachments.length > 0 && cwd) {
        lines.push('## Attached files')
        for (const att of allAttachments) {
          const full = att.isRelative ? absPath(cwd, att.path) : att.path
          if (isPreview) {
            lines.push(`\n<file path="${att.path}">\n(preview content)\n</file>`)
            continue
          }
          // #4 image attachments ride the multimodal content channel (base64),
          // not the text prompt — recorded here only as a visible marker.
          if (att.isImage) {
            lines.push(`\n<image name="${att.name}">\n[attached image — sent to the model as image content]\n</image>`)
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
      // Re-bake using the attachments snapshot captured at enqueue time — the
      // global strip is cleared after send, so the queue owns its own copy.
      const msg = queuedMessages.find((m) => m.id === id)
      const finalPrompt = await buildFinalPrompt(text, msg?.attachments)
      setQueuedMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text, finalPrompt } : m)))
    },
    [buildFinalPrompt, queuedMessages]
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

  /** #6：/init 的聊天氣泡標題（實際送出的 prompt 固定為 '/init'，用於觸發引擎
   *  內建 initPrompt——'User has typed "init"…'，讓 agent 分析專案後建立/更新
   *  根目錄 knowledge.md）。 */
  const INIT_DISPLAY_TEXT =
    'Initialize project knowledge base — analyze the repo and create/update knowledge.md'

  const send = useCallback(
    async (textOverride?: string, prebuiltPrompt?: string, opts?: { mode?: AgentMode }) => {
      let text = (textOverride ?? prompt).trim()
      if (!text || !cwd) return

      /* ── #6：/init → 專案知識庫初始化（取代舊的「開啟 Agent Workshop」快捷）──
       * 舊版把 bare `/init` 當作建立自訂 agent 精靈（Agent Workshop）的隱藏入口，
       * 與 init=知識庫初始化的概念撞名、易誤導新手（缺口表 #6 備註）；自訂 agent
       * 精靈改由 Settings → Custom Agents 進入。
       * 此處把 bare `/init` 轉成一則 prebuilt prompt 精確為 '/init' 的 run——引擎在
       * loopAgentSteps 偵測到 prompt === '/init' 時會注入 initPrompt，要求 agent
       * 分析專案並建立/更新根目錄 knowledge.md（若已存在則依現況補強）。
       * 寫入 knowledge.md 需要 write_file：非 Build（default）模式時，本輪改用
       * Build root（base2）執行，但不切換 UI 的模式狀態。 */
      let initRun = false
      // 注意：`/init` 執行中送出時會先佇列、稍後由 drain 以 send(標題, '/init')
      // 重新派送——若只認「原始文字恰為 /init」會在 drain 時漏判，Chat/Plan 模式下
      // 就會退回無 write_file 的 root，故 prebuiltPrompt === '/init' 也視為 init。
      if (prebuiltPrompt === '/init' || /^\/init(?:\s|$)/i.test(text)) {
        initRun = true
        if (prebuiltPrompt !== '/init' && !textOverride) {
          // 手打路徑：換成可讀標題，並把 prompt 精確設為 '/init' 以觸發引擎 initPrompt。
          setPrompt('')
          if (text.trim() !== '/init') {
            setNotice('`/init` takes no arguments — starting project knowledge-base init.')
          }
          text = INIT_DISPLAY_TEXT
          prebuiltPrompt = '/init'
        }
        if (agentMode !== 'default') {
          setNotice('`/init` needs file-write access to create/update knowledge.md — running this turn in Build mode.')
        }
      }

      /* ── #9 Bash mode: `!command` runs locally, output becomes context ── */
      if (!textOverride && !prebuiltPrompt && text.startsWith('!')) {
        const command = text.slice(1).trim()
        if (command) {
          setPrompt('')
          // Show the command as a user message immediately.
          setChatItems((prev) => [...prev, { kind: 'user', text: `$ ${command}`, ts: Date.now() }])
          autoScrollRef.current = true
          const result = isPreview
            ? { ok: true, command, cwd, stdout: `(preview output of ${command})`, stderr: '', exitCode: 0 }
            : ((await window.AnyBuff.runBashCommand({ command, cwd })) as {
                ok: boolean
                command: string
                cwd: string
                stdout: string
                stderr: string
                exitCode: number
                errorMessage?: string
              })
          // Surface the output in the transcript (like the upstream CLI's
          // bash tool card) and stash it as context for the NEXT prompt.
          setChatItems((prev) => [
            ...prev,
            {
              kind: 'tool' as const,
              tool: {
                toolName: 'run_terminal_command',
                status: result.ok ? ('done' as const) : ('error' as const),
                detail: [
                  result.stdout ? `stdout:\n${result.stdout}` : '',
                  result.stderr ? `stderr:\n${result.stderr}` : '',
                  result.errorMessage ? `error: ${result.errorMessage}` : ''
                ]
                  .filter(Boolean)
                  .join('\n') || `exit code ${result.exitCode}`,
                toolInput: { command: result.command, cwd: result.cwd, processType: 'SYNC' }
              }
            }
          ])
          pendingBashRef.current = [...pendingBashRef.current, result]
          setNotice(`Bash output captured — it will be attached to your next message (${result.exitCode === 0 ? 'exit 0' : `exit ${result.exitCode}`}).`)
          return
        }
      }

      /* ── #5 第二批：/review 與 /interview 斜線指令 ── */
      let builtPrompt: string | undefined = prebuiltPrompt
      // Bare /review（或從清單選取）→ 開啟範圍選擇面板。
      if (/^\/review\s*$/i.test(text)) {
        setPrompt('')
        setReviewScopeOpen(true)
        return
      }
      const reviewArgs = /^\/review\s+([\s\S]+)$/i.exec(text)
      if (reviewArgs && !prebuiltPrompt) {
        // 直接帶參數：等同 CLI 的 /review foo，自訂焦點立即送出。
        builtPrompt = buildReviewPrompt('custom', reviewArgs[1])
        text = `Code review — custom focus: ${reviewArgs[1].trim()}`
      }
      // Bare /interview → 武裝包裝器，下一則訊息自動套用訪談提示詞。
      if (/^\/interview\s*$/i.test(text)) {
        setPrompt('')
        setInterviewArmed(true)
        return
      }
      const interviewArgs = /^\/interview\s+([\s\S]+)$/i.exec(text)
      let interviewWrap = false
      if (interviewArgs && !prebuiltPrompt) {
        // /interview <request>：立即包裝送出。
        text = interviewArgs[1].trim()
        interviewWrap = true
      } else if (interviewArmed && !textOverride && !builtPrompt) {
        // 已武裝：這則訊息就是訪談對象。
        interviewWrap = true
      }
      if (interviewWrap) setInterviewArmed(false)

      // Bake @file contents etc. in BEFORE queueing so a queued message keeps
      // exactly what was selected when it was written (#2 執行中訊息佇列).
      const bakedBody = await buildFinalPrompt(text)
      // #9: prepend any captured `!command` outputs as <user_terminal_commands>
      // context, then clear the stash (they belong to this turn only).
      const bashContext =
        pendingBashRef.current.length > 0
          ? formatBashContext(pendingBashRef.current)
          : ''
      pendingBashRef.current = []
      const bakedWithContext = bashContext ? `${bashContext}${bakedBody}` : bakedBody
      const finalPrompt = interviewWrap
        ? `${buildInterviewPrompt('')}\n\n${bakedWithContext}`
        : (builtPrompt
            // 引擎 hook 是「prompt 精確等於 '/init'」的 key match——前面若又黏了
            // bash context 會把整串 prompt 弄髒導致 hook 失效；/init 本身就會讀檔
            // 分析專案，不需要帶上回合的 !command 輸出。
            ? (builtPrompt === '/init' ? builtPrompt : `${bashContext}${builtPrompt}`)
            : bakedWithContext)

      if (running) {
        if (isPreview) return
        // A run is in flight → park the message in the execution queue instead
        // of rejecting it; the queue drains automatically when the turn ends.
        setQueuedMessages((prev) => [
          ...prev,
          {
            id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            text,
            finalPrompt,
            // Snapshot so an inline edit re-bakes with the same files.
            attachments
          }
        ])
        setPrompt('')
        // The attachment strip belongs to the turn it was attached in — the
        // queued message already baked its contents into finalPrompt above.
        setAttachments([])
        return
      }

      setPrompt('')
      // Attachments are per-turn: they are baked into finalPrompt above, so once
      // this message is submitted the strip clears instead of persisting into
      // the next turn (or next task).
      setAttachments([])
      changedFilesRef.current = []
      accumulatedFileChangesRef.current = []
      setFollowups([])
      autoScrollRef.current = true
      setChatItems((prev) => [...prev, { kind: 'user', text, ts: Date.now() }, { kind: 'assistant', text: '' }])
      setRunning(true)
      // #22：從送出瞬間開始計時（之後的 run_status running 只會保留這個起點）。
      setRunStartedAt(Date.now())
      setNotice(null)
      setHistoryTask(null)
      setResumeInfo(null)
      // New conversations get their id up front so streamed events route to
      // this view immediately; existing conversations reuse their id.
      if (!currentTaskRef.current && !isPreview) {
        const newId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        setViewTask(newId)
      }
      // Optimistic: this view owns the run until events say otherwise.
      if (!isPreview) setRunningTaskId(currentTaskRef.current)

    if (isPreview) {
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
          setRunStartedAt(null)
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
      const imageContent = buildImageContent(attachments)
      const runPromise = window.AnyBuff.runPrompt({
        cwd,
        prompt: finalPrompt,
        displayText: text,
        taskId: currentTaskRef.current ?? undefined,
        mode: opts?.mode ?? (initRun ? 'default' : agentMode),
        // #4: pasted/attached images ride the multimodal content channel.
        ...(imageContent.length > 0 ? { content: imageContent } : {})
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
      // #22：run 已結束（成功/失敗/中斷皆然），清除計時起點。
      setRunStartedAt(null)
      setStopping(false)
      setRetryNotice(null)
      setApprovalRequest(null)
      setNotice((prev) => (prev && prev.includes('Stop requested') ? null : prev))
    }
  }, [prompt, cwd, running, agentMode, buildFinalPrompt, refreshProjects, setViewTask, interviewArmed, attachments])

  /** #5 第二批：/review 範圍選擇面板的送出入口 —— 以預建提示詞走正常送出流程。 */
  const runReviewScope = useCallback(
    (scope: ReviewScope, customInput?: string) => {
      setReviewScopeOpen(false)
      const option = REVIEW_SCOPE_OPTIONS.find((o) => o.id === scope)
      const display =
        scope === 'custom'
          ? `Code review — custom focus: ${(customInput ?? '').trim()}`
          : `Code review — ${option?.label.toLowerCase() ?? scope}`
      void send(display, buildReviewPrompt(scope, customInput))
    },
    [send]
  )

  /** #6：/init（由 / 清單選取）—— 送出一則 prebuilt prompt '/init' 的 run，引擎
   *  注入 initPrompt 後 agent 會分析專案並建立/更新根目錄 knowledge.md。
   *  知識庫寫檔需要檔案工具：非 Build 模式時本輪強制以 Build root（base2）執行
   *  （不切換 UI 的模式狀態）。 */
  const runInitKnowledge = useCallback(() => {
    setPrompt('')
    if (agentMode !== 'default') {
      setNotice('`/init` needs file-write access to create/update knowledge.md — running this turn in Build mode.')
    }
    void send(INIT_DISPLAY_TEXT, '/init', { mode: 'default' })
  }, [send, agentMode])

  // When the current turn ends, automatically dispatch the first queued message.
  // drainingQueueRef serializes against re-entrant effect runs (StrictMode dev
  // double-invoke included); `send` flips `running` synchronously so the follow-up
  // run sees the in-flight state immediately.
  const drainingQueueRef = useRef(false)
  useEffect(() => {
    if (isPreview) return
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
    if (!isPreview) void window.AnyBuff.abort()
  }, [])

  // Resume an interrupted run from its preserved state (no re-appending the user prompt).
  const resumeRun = useCallback(async () => {
    const info = resumeInfo
    const taskId = currentTaskRef.current
    if (!info || !cwd || running || !taskId) return
    setRunning(true)
    setRunningTaskId(taskId)
    // #22：resume 時重新起算耗時。
    setRunStartedAt(Date.now())
    setNotice(null)
    setResumeInfo(null)
    setChatItems((prev) => [...prev, { kind: 'assistant', text: '' }])
    if (isPreview) {
      setRunning(false)
      setRunStartedAt(null)
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
      // #22：run 已結束，清除計時起點。
      setRunStartedAt(null)
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
    if (!isPreview) {
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
    if (taskId && !isPreview) {
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

  useEffect(() => {
    if (!pendingRevert) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setPendingRevert(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingRevert])

  const openFileByPath = useCallback(async (path: string, name: string) => {
    if (isPreview) {
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
    if (!isPreview) {
      void window.AnyBuff.getState().then((state) => {
        const s = (state as { settings: { activeModel: string; reasoningEffort: string; approvalMode: string; providers: { id: string; label: string; models: string[] }[]; hasProvider?: boolean; reasoningLadders?: Record<string, string[]> } }).settings
        if (s) {
          setHasProvider(Boolean(s.hasProvider))
          setSettings({ providers: s.providers, activeModel: s.activeModel, reasoningEffort: s.reasoningEffort, approvalMode: s.approvalMode, reasoningLadders: s.reasoningLadders ?? {} })
        }
      })
      refreshProjects()
    }
  }, [refreshProjects])

  const onSettingsSaved = useCallback(
    (saved: { hasProvider: boolean }) => {
      setHasProvider(saved.hasProvider)
      if (!isPreview) {
        void window.AnyBuff.getState().then((state) => {
          const s = (state as { settings: { activeModel: string; reasoningEffort: string; approvalMode: string; providers: { id: string; label: string; models: string[] }[]; reasoningLadders?: Record<string, string[]> } }).settings
          if (s) {
            setSettings({ providers: s.providers, activeModel: s.activeModel, reasoningEffort: s.reasoningEffort, approvalMode: s.approvalMode, reasoningLadders: s.reasoningLadders ?? {} })
          }
        })
        refreshProjects()
      }
    },
    [refreshProjects]
  )

  const onModelChange = useCallback((m: string) => {
    setSettings((prev) => ({ ...prev, activeModel: m }))
    if (!isPreview) {
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
    if (!isPreview) {
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

  // #17 保險絲: persist the per-run step cap / cost mode whenever changed.
  const persistRunGuardrails = useCallback((steps: number, mode: 'normal' | 'max' | 'lite') => {
    if (isPreview) return
    void window.AnyBuff.saveSettings({
      providers: settingsRef.current.providers,
      activeModel: settingsRef.current.activeModel,
      reasoningEffort: settingsRef.current.reasoningEffort,
      approvalMode: settingsRef.current.approvalMode,
      apiKeys: {},
      deleteKeys: [],
      maxAgentSteps: steps,
      costMode: mode
    })
  }, [isPreview])

  const onMaxAgentStepsChange = useCallback((steps: number) => {
    setMaxAgentSteps(steps)
    persistRunGuardrails(steps, costModeRef.current)
  }, [persistRunGuardrails])

  const onCostModeChange = useCallback((mode: 'normal' | 'max' | 'lite') => {
    setCostMode(mode)
    persistRunGuardrails(maxAgentStepsRef.current, mode)
  }, [persistRunGuardrails])

  // Attachments (dialog picker + drag & drop both land here as absolute paths)
  const onAttachFilesPaths = useCallback(async (paths: string[]) => {
    if (isPreview) {
      // No preload bridge in browser preview — attach by display name only.
      setAttachments((prev) => {
        const next = [...prev]
        for (const p of paths) {
          if (!next.some((x) => x.path === p)) {
            next.push({ path: p, name: basenameOf(p), isDir: false, isRelative: true })
          }
        }
        return next
      })
      return
    }
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

  const onAttachFiles = useCallback(async () => {
    if (isPreview) {
      setAttachments((prev) => [...prev, { path: 'src/calculator.js', name: 'calculator.js', isDir: false, isRelative: true }])
      return
    }
    const paths = (await window.AnyBuff.selectFiles()) as string[]
    if (paths.length > 0) await onAttachFilesPaths(paths)
  }, [onAttachFilesPaths])

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

  /**
   * #4 圖片附件／剪貼簿貼圖: composer paste lands here as data URLs. The strip
   * shows a thumbnail; on send the data URL is split into the base64 part the
   * SDK's multimodal content channel expects (no file on disk required).
   */
  const onPasteImages = useCallback((images: { dataUrl: string; mediaType: string; name: string }[]) => {
    setAttachments((prev) => {
      const next = [...prev]
      for (const img of images) {
        const key = `clipboard:${img.name}`
        if (next.some((a) => a.path === key)) continue
        next.push({
          path: key,
          name: img.name,
          isDir: false,
          isRelative: false,
          isImage: true,
          previewUrl: img.dataUrl
        })
      }
      return next
    })
  }, [])

  /** #4: turn image attachments into SDK RunImagePart base64 content. */
  const buildImageContent = useCallback(
    (atts: Attachment[]): Array<{ type: 'image'; image: string; mediaType: string }> => {
      const parts: Array<{ type: 'image'; image: string; mediaType: string }> = []
      for (const att of atts) {
        if (!att.isImage || !att.previewUrl) continue
        const commaIdx = att.previewUrl.indexOf(',')
        const meta = /^data:([^;]+);/.exec(att.previewUrl.slice(0, commaIdx >= 0 ? commaIdx : 0))
        const base64 = commaIdx >= 0 ? att.previewUrl.slice(commaIdx + 1) : ''
        if (base64) {
          const semiIdx = att.previewUrl.indexOf(';')
          const fallbackType = semiIdx > 5 ? att.previewUrl.slice(5, semiIdx) : 'image/png'
          parts.push({ type: 'image', image: base64, mediaType: meta?.[1] ?? fallbackType })
        }
      }
      return parts
    },
    []
  )

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
      if (isPreview) {
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
      if (isPreview) return
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
      // Same-project task switches skip onOpenProject's early return, so clear
      // the per-turn attachment strip here too — attachments never follow the
      // user across conversations.
      setAttachments([])
      if (isPreview) {
        setViewTask(task.id)
        setChatItems((task.messages ?? []) as ChatItem[])
        setHistoryTask({ id: task.id, prompt: task.prompt })
        setPrompt('')
        return
      }
      setHistoryTask({ id: task.id, prompt: task.prompt })
      try {
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
        // #21 完成時間戳：歷史 transcript 以 updatedAt（完成）／createdAt（建立）補上 ts。
        const transcript = ((view.ok ? view.transcript ?? [] : []) as (ChatItem & { createdAt?: number; updatedAt?: number })[])
        const items = transcript.map((m) => {
          const ts = m.updatedAt ?? m.createdAt
          if (ts && (m.kind === 'user' || m.kind === 'assistant')) {
            return { ...m, ts }
          }
          return m
        }) as ChatItem[]
        setChatItems(items)
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
      } catch (err) {
        // A malformed or legacy conversation must never white-screen the app:
        // surface the failure in the chat view so it stays navigable.
        console.error('[anybuff] failed to load conversation snapshot', task.id, err)
        setChatItems([{ kind: 'system', text: `Failed to load this conversation: ${String(err)}` }])
        setViewTask(task.id)
        setResumeInfo(null)
      }
      setPrompt('')
    },
    [onOpenProject, setViewTask]
  )

  const onRenameTask = useCallback(
    async (project: ProjectRecord, task: TaskRecord, newPrompt: string) => {
      if (!newPrompt || newPrompt === task.prompt) return
      if (!isPreview) {
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
      if (!isPreview) {
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
      if (!isPreview) {
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
        if (isPreview) {
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

  // True when the shell injected a native restart bridge (Android WebView).
  // Without it (browser preview) the Restart Engine button reloads the page
  // instead, and the hint below explains that reconnect is automatic.
  const hasNativeRestart =
    typeof (window as unknown as { __ANYBUFF_NATIVE__?: { restartEngine?: () => void } }).__ANYBUFF_NATIVE__
      ?.restartEngine === 'function'

  // Index of the last user message — computed once per render instead of a
  // `chatItems.slice(i + 1).every(...)` scan per user row (O(n²) on long chats,
  // re-run on every keystroke while the conversation is open).
  let lastUserIdx = -1
  for (let i = chatItems.length - 1; i >= 0; i--) {
    if (chatItems[i].kind === 'user') {
      lastUserIdx = i
      break
    }
  }

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
        {!isPreview && (
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
            onOpenDiagnostics={openDiagnostics}
            onSaved={onSettingsSaved}
            theme={theme}
            themeMode={themeMode}
            onSelectThemeMode={selectThemeMode}
            colorTheme={colorTheme}
            onSelectColorTheme={setColorTheme}
            notificationSound={notificationSound}
            onSelectNotificationSound={selectNotificationSound}
            initialTab={settingsTab}
            cwd={cwd}
            maxAgentSteps={maxAgentSteps}
            onSelectMaxAgentSteps={onMaxAgentStepsChange}
            costMode={costMode}
            onSelectCostMode={onCostModeChange}
          />
        ) : (
          <>
            {reviewScopeOpen && (
              <ReviewScopePanel onClose={() => setReviewScopeOpen(false)} onRun={runReviewScope} />
            )}
            {showDiagnostics && <DiagnosticsModal onClose={() => setShowDiagnostics(false)} />}
            <Sidebar
              open={leftOpen}
              onClose={() => setLeftOpen(false)}
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

            {(leftOpen || rightOpen) && (
              <div
                className="drawer-backdrop"
                onClick={() => {
                  setLeftOpen(false)
                  setRightOpen(false)
                }}
              />
            )}

            <main className="main">
              <header className="topbar">
                <div className="topbar-left">
                  <button
                    className="btn icon-only panel-toggle"
                    onClick={toggleLeft}
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
                      {runStartedAt && <RunElapsed startedAt={runStartedAt} />}
                    </span>
                  )}
                </div>
                <div className="topbar-right">
                  {!cwd && (
                    <button className="btn primary topbar-select-folder-btn" onClick={() => void selectFolder()} title="Select Folder">
                      <FolderIcon size={14} /> <span className="topbar-btn-text">Select Folder</span>
                    </button>
                  )}
                  {!hasProvider && (
                    <button className="btn warn topbar-set-key-btn" onClick={() => setShowSettings(true)} title="Set API Key">
                      <AlertCircleIcon size={14} /> <span className="topbar-btn-text">Set API Key</span>
                    </button>
                  )}
                  <button
                    className="btn icon-only panel-toggle"
                    onClick={toggleRight}
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

                    {/* key: remount on conversation switch so a stale boundary error never blocks healthy conversations */}
                    <ErrorBoundary key={activeViewTaskId ?? historyTask?.id ?? 'chat'}>
                    {chatItems.map((item, i) => {
                      if (item.kind === 'user') {
                        const isLastUser = i === lastUserIdx
                        return (
                          <div key={i} data-index={i} ref={setMsgRef}>
                            <UserBubble
                              text={item.text ?? ''}
                              ts={item.ts}
                              onRevert={isLastUser && !viewRunning && !historyTask ? () => void requestRevert() : undefined}
                            />
                          </div>
                        )
                      }
                      if (item.kind === 'assistant') {
                        const isStreaming = streaming && i === chatItems.length - 1
                        return (
                          <div key={i} data-index={i} ref={setMsgRef}>
                            <AssistantBubble
                              text={item.text ?? ''}
                              reasoning={item.reasoning}
                              ts={item.ts}
                              streaming={isStreaming}
                            />
                          </div>
                        )
                      }
                      if (item.kind === 'tool' && item.tool) {
                        const isLastTool = i === chatItems.length - 1
                        return (
                          <div key={i} data-index={i} ref={setMsgRef}>
                            <ToolCard tool={item.tool} isLast={isLastTool && running} />
                          </div>
                        )
                      }
                      if (item.kind === 'file-changes') {
                        return (
                          <div key={i} data-index={i} ref={setMsgRef}>
                            <FileChangesSummary files={item.files} />
                          </div>
                        )
                      }
                      if (item.kind === 'compaction') {
                        return (
                          <div key={i} className="msg-row system" data-index={i} ref={setMsgRef}>
                            <span className="system-bubble compaction-note">ℹ {item.text}</span>
                          </div>
                        )
                      }
                      const itemText = (item as { text?: string }).text ?? ''
                      if (
                        itemText.includes('suggest_followups already ended') ||
                        itemText.includes('No more non-terminal tools are available after followups') ||
                        itemText.includes('Invalid parameters for') ||
                        itemText.includes('Raw validation issues:') ||
                        itemText.includes('Stop requested. Waiting for agent to safely halt')
                      ) {
                        return null
                      }
                      return (
                        <div key={i} className="msg-row system" data-index={i} ref={setMsgRef}>
                          <span className="system-bubble"><span className="system-warn">⚠</span> {itemText}</span>
                        </div>
                      )
                    })}
                    </ErrorBoundary>

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
                    <div className="resume-banner">
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
                    onReviewRequest={() => setReviewScopeOpen(true)}
                    onArmInterview={() => setInterviewArmed(true)}
                    onDisarmInterview={() => setInterviewArmed(false)}
                    interviewArmed={interviewArmed}
                    onInitKnowledge={runInitKnowledge}
                    running={viewRunning}
                    stopping={viewStopping}
                    sendBlocked={busyElsewhere}
                    sendBlockedHint="Another task is still running — wait for it to finish or stop it first."
                    disabled={!hasProvider}
                    attachments={attachments}
                    onAttachFiles={() => void onAttachFiles()}
                    onAttachFilesPath={onAttachFilesPath}
                    onAttachFilesPaths={(paths) => void onAttachFilesPaths(paths)}
                    onPasteImages={onPasteImages}
                    onRemoveAttachment={onRemoveAttachment}
                    providers={models}
                    activeModel={settings.activeModel}
                    onModelChange={onModelChange}
                    reasoningEffort={settings.reasoningEffort} reasoningLadders={settings.reasoningLadders ?? {}}
                    onReasoningChange={onReasoningChange}
                    agentMode={agentMode}
                    onAgentModeChange={setAgentMode}
                    tokenUsage={tokenUsage}
                    totalCost={totalCost}
                    fileCandidates={fileCandidates}
                    skills={skills}
                    agentMentions={agentMentions}
                    focusSignal={focusSignal}
                  />
                </>
              )}
            </main>

            <RightPanel
              open={rightOpen}
              onClose={() => setRightOpen(false)}
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
        <div className="modal-backdrop revert-modal-backdrop" onClick={() => setPendingRevert(null)}>
          <div className="modal revert-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="revert-modal-title">
            <div className="revert-modal-header">
              <div className="revert-modal-title" id="revert-modal-title">
                <div className="revert-modal-icon-badge">
                  <UndoIcon size={16} />
                </div>
                <span>Revert this exchange?</span>
              </div>
              <button
                type="button"
                className="mini-btn revert-modal-close-btn"
                onClick={() => setPendingRevert(null)}
                title="Cancel"
                aria-label="Close"
              >
                <XIcon size={14} />
              </button>
            </div>

            <div className="revert-modal-body">
              <p className="revert-modal-desc">
                {pendingRevert.files.length > 0
                  ? `This will undo the changes made to ${pendingRevert.files.length} file${pendingRevert.files.length === 1 ? '' : 's'} in this conversation:`
                  : 'This will discard this exchange from the conversation.'}
              </p>

              {pendingRevert.files.length > 0 && (
                <div className="revert-file-list">
                  {pendingRevert.files.slice(0, 8).map((f) => (
                    <div key={f} className="revert-file">
                      <span className="revert-file-bullet">−</span>
                      <span className="revert-file-path">{f}</span>
                    </div>
                  ))}
                  {pendingRevert.files.length > 8 && (
                    <div className="revert-file more">… and {pendingRevert.files.length - 8} more files</div>
                  )}
                </div>
              )}

              <div className="revert-restore-note">
                <InfoIcon size={14} className="revert-note-icon" />
                <span>Your original message will be restored in the input box as unsent text, so you can edit and resend it.</span>
              </div>
            </div>

            <div className="revert-modal-footer">
              <button type="button" className="btn ghost revert-cancel-btn" onClick={() => setPendingRevert(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-revert-confirm" onClick={() => void confirmRevert()}>
                <UndoIcon size={13} />
                <span>Revert</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {hostDown && (
        <div className="engine-down-overlay">
          <div className="engine-down-card">
            <div className="welcome-logo">
              <AppIcon size={56} />
            </div>
            <h2>Engine connection lost</h2>
            <p className="hint">
              The local engine stopped responding. Your projects and conversations are preserved — restarting the engine brings everything back.
            </p>
            <button className="btn primary big" onClick={retryEngine}>
              Restart Engine
            </button>
            {hasNativeRestart ? (
              <p className="hint engine-down-hint">
                The engine restarts automatically — this screen dismisses itself when it's back.
              </p>
            ) : (
              <p className="hint engine-down-hint">
                This page reconnects automatically as soon as the engine is back.
              </p>
            )}
            <button className="btn engine-down-secondary" onClick={() => window.location.reload()}>
              Reload Page
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
