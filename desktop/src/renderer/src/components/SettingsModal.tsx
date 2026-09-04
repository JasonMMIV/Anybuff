import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ColorTheme } from '../App'
import {
  ActivityIcon,
  AppIcon,
  BoltIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  EditIcon,
  GitHubIcon,
  InfoIcon,
  LayersIcon,
  MoonIcon,
  PaletteIcon,
  PlugIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SparklesIcon,
  SpecialistIcon,
  SunIcon,
  TrashIcon,
  XIcon
} from './Icons'
import CustomSelect from './CustomSelect'

type ProviderType = 'openai-compatible' | 'anthropic-compatible'
type SettingsTab = 'providers' | 'general' | 'theme' | 'routing' | 'agents' | 'search' | 'mcp' | 'about'

type WebSearchProviderId = 'duckduckgo' | 'firecrawl' | 'tinyfish'

interface WebSearchProviderMeta {
  id: WebSearchProviderId
  label: string
  description: string
  requiresKey: boolean
  keyHint: string
}

/* ─── MCP Tools tab types ──────────────────────────────── */

/** Sentinel the main process stores for a DPAPI-encrypted value (see mcp-settings.ts). */
const MCP_SECRET_PLACEHOLDER = '__ANYBUFF_KEEP_SECRET__'

type McpServerType = 'stdio' | 'http' | 'sse'

export interface McpServerView {
  id: string
  name: string
  type: McpServerType
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  params?: Record<string, string>
  enabled: boolean
  targetAgents: string[]
  source: 'app' | 'file'
  filePath?: string
  hasSecrets: boolean
}

interface McpServerDraft {
  id?: string
  name: string
  type: McpServerType
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  params?: Record<string, string>
  enabled: boolean
  targetAgents: string[]
}

interface McpPreset {
  label: string
  description: string
  type: McpServerType
  command?: string
  args?: string[]
  url?: string
  envHint?: { key: string; varName: string; hint: string }[]
  headerHint?: { key: string; varName: string; hint: string }[]
}

/** Quick-fill templates for the Add-MCP form. */
const MCP_PRESETS: McpPreset[] = [
  {
    label: 'Context7 (Docs)',
    description: 'Up-to-date documentation for 4M+ libraries, injected as context.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp']
  },
  {
    label: 'Playwright',
    description: 'Browser automation and end-to-end testing via Playwright.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest']
  },
  {
    label: 'Chrome DevTools',
    description: 'Drive a real Chrome instance (same MCP used by the browser-use agent).',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest']
  },
  {
    label: 'Filesystem',
    description: 'Read/write files outside the project (use with care).',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '~/']
  },
  {
    label: 'Fetch',
    description: 'Fetch and convert URLs to markdown for research.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch']
  },
  {
    label: 'Sequential Thinking',
    description: 'Structured multi-step problem solving.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking']
  },
  {
    label: 'GitHub (official)',
    description: 'Issue/PR/repo operations with a personal access token.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'github-mcp-server'],
    envHint: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', varName: '$GITHUB_PERSONAL_ACCESS_TOKEN', hint: 'GitHub PAT (repo + read:org scopes)' }]
  },
  {
    label: 'Exa Search',
    description: 'Web search API for AI agents.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'exa-mcp-server'],
    envHint: [{ key: 'EXA_API_KEY', varName: '$EXA_API_KEY', hint: 'Exa API key' }]
  },
  {
    label: 'Supabase',
    description: 'Query and manage Supabase projects.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-supabase'],
    envHint: [{ key: 'SUPABASE_ACCESS_TOKEN', varName: '$SUPABASE_ACCESS_TOKEN', hint: 'Supabase access token' }]
  },
  {
    label: 'Custom HTTP (http://)',
    description: 'Remote MCP server over HTTP with optional headers.',
    type: 'http',
    url: 'https://mcp.example.com/mcp'
  }
]

/** Agents offered in the target-agents picker (bundled + local). base-chat is
 *  the Chat-mode root; it can be routed to a model or given MCP tools if the
 *  user wants, but is intentionally NOT in DEFAULT_TARGET_AGENTS below. */
const DEFAULT_AGENT_IDS = ['base2', 'base2-plan', 'base-chat', 'editor', 'researcher-web', 'code-reviewer', 'thinker', 'browser-use', 'file-picker', 'librarian', 'basher']

/** Default agents a new server is exposed to (main conversation agents). */
const DEFAULT_TARGET_AGENTS = ['base2', 'base2-plan']

/** Drop empty-key / empty-value rows before sending a draft over IPC. */
function cleanKv(obj: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!obj) return out
  for (const [k, v] of Object.entries(obj)) {
    if (k.trim() && v !== '') out[k.trim()] = v
  }
  return out
}

/**
 * Serialize a draft to the mcp.json-style server object (name is the key).
 * Used to prefill the raw-JSON editor in the add/edit modal.
 */
function draftToMcpJson(draft: McpServerDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  if (draft.type === 'stdio') {
    payload.command = draft.command ?? ''
    if (draft.args && draft.args.length > 0) payload.args = draft.args
  } else {
    payload.type = draft.type
    payload.url = draft.url ?? ''
  }
  const env = cleanKv(draft.env)
  if (Object.keys(env).length > 0) payload.env = env
  const headers = cleanKv(draft.headers)
  if (Object.keys(headers).length > 0) payload.headers = headers
  const params = cleanKv(draft.params)
  if (Object.keys(params).length > 0) payload.params = params
  return { [draft.name || 'mcp-server']: payload }
}

export interface LocalAgentItem {
  id: string
  displayName: string
  spawnerPrompt: string
  source?: string
  filePath?: string
  scope?: 'project' | 'parent' | 'home'
}

interface ProviderDraft {
  id: string
  label: string
  type: ProviderType
  baseURL: string
  apiKeyEnv: string
  models: string[]
  enableThinking?: boolean
  customBody?: string
}

interface ProviderPreset {
  label: string
  baseURL: string
  type: ProviderType
  apiKeyEnv: string
  description: string
  enableThinking?: boolean
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    type: 'openai-compatible',
    apiKeyEnv: 'OPENAI_API_KEY',
    description: 'GPT-5.5, GPT-5.4, GPT-4.1'
  },
  {
    label: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    type: 'anthropic-compatible',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    description: 'Claude Opus 4.5, Sonnet 4.5'
  },
  {
    label: 'Alibaba Cloud (DashScope)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    type: 'openai-compatible',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    description: 'Qwen 2.5, DeepSeek-R1, QwQ (enable_thinking)',
    enableThinking: true
  },
  {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    type: 'openai-compatible',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    description: 'Unified gateway for 100+ models'
  },
  {
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    type: 'openai-compatible',
    apiKeyEnv: 'GEMINI_API_KEY',
    description: 'Gemini 3.7 / 2.5 Flash & Pro (OpenAI compat)'
  },
  {
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    type: 'openai-compatible',
    apiKeyEnv: 'GROQ_API_KEY',
    description: 'Ultra-fast Llama & DeepSeek inference'
  },
  {
    label: 'Together AI',
    baseURL: 'https://api.together.xyz/v1',
    type: 'openai-compatible',
    apiKeyEnv: 'TOGETHER_API_KEY',
    description: 'Open-source models cloud API'
  },
  {
    label: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    type: 'openai-compatible',
    apiKeyEnv: 'MISTRAL_API_KEY',
    description: 'Mistral Large, Codestral'
  },
  {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    type: 'openai-compatible',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    description: 'DeepSeek V3, DeepSeek R1'
  },
  {
    label: 'Ollama (Local)',
    baseURL: 'http://localhost:11434/v1',
    type: 'openai-compatible',
    apiKeyEnv: 'OLLAMA_API_KEY',
    description: 'Local LLMs via Ollama'
  },
  {
    label: 'LM Studio (Local)',
    baseURL: 'http://localhost:1234/v1',
    type: 'openai-compatible',
    apiKeyEnv: 'LMSTUDIO_API_KEY',
    description: 'Local models running in LM Studio'
  },
  {
    label: 'vLLM (Local)',
    baseURL: 'http://localhost:8000/v1',
    type: 'openai-compatible',
    apiKeyEnv: 'VLLM_API_KEY',
    description: 'High-throughput local vLLM server'
  }
]

interface Props {
  onClose: () => void
  onCreateAgent: () => void
  onSaved?: (s: { hasProvider: boolean }) => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  colorTheme: ColorTheme
  onSelectColorTheme: (theme: ColorTheme) => void
  initialTab?: SettingsTab
  cwd?: string | null
}

const COLOR_THEMES: { id: ColorTheme; label: string; previewColor: string; description: string }[] = [
  { id: 'default', label: 'Pure Blue', previewColor: '#3b82f6', description: 'Vibrant pure sapphire blue with deep, crisp high-contrast surfaces' },
  { id: 'black', label: 'Obsidian Black', previewColor: '#0a0a0a', description: 'Monochrome pure black and white high-contrast theme' },
  { id: 'vermillion', label: 'Vermillion', previewColor: '#ef4444', description: 'Energetic crimson and scarlet with warm ruby-tinted undertones' },
  { id: 'amber', label: 'Amber', previewColor: '#f59e0b', description: 'Warm amber gold with rich honey and terracotta undertones' },
  { id: 'teal', label: 'Teal', previewColor: '#14b8a6', description: 'Clean modern cyan-teal with high-tech marine undertones' }
]

const GITHUB_URL = 'https://github.com/JasonMMIV/Anybuff'

interface UpdateCheckResult {
  ok: boolean
  updateAvailable?: boolean
  currentVersion?: string
  latestVersion?: string
  url?: string
  error?: string
}

type UpdaterStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

/** Flat shape so electron-updater events can merge functionally without losing context. */
interface UpdaterUiState {
  status: UpdaterStatus
  version: string
  percent: number
  message: string
}

import { getReasoningOptionsForModel } from '../utils/reasoning'

let draftSeq = 0
function newProviderId(): string {
  draftSeq += 1
  return `custom-${Date.now().toString(36)}-${draftSeq}`
}

function defaultCustom(): ProviderDraft {
  return {
    id: newProviderId(),
    label: 'OpenAI Compatible',
    type: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    apiKeyEnv: 'ANYBUFF_API_KEY',
    models: []
  }
}

function urlError(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return 'Base URL is required'
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Base URL must start with http:// or https://'
    return null
  } catch {
    return 'Invalid URL — expected e.g. https://api.openai.com/v1'
  }
}

export default function SettingsModal({
  onClose,
  onCreateAgent,
  onSaved,
  theme,
  onToggleTheme,
  colorTheme,
  onSelectColorTheme,
  initialTab,
  cwd: propCwd
}: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'general')
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false)
  const categoryDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab)
    }
  }, [initialTab])

  useEffect(() => {
    if (!categoryDropdownOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (categoryDropdownRef.current && !categoryDropdownRef.current.contains(e.target as Node)) {
        setCategoryDropdownOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCategoryDropdownOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [categoryDropdownOpen])
  const [providers, setProviders] = useState<ProviderDraft[]>([])
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [fetchedModelsMap, setFetchedModelsMap] = useState<Record<string, string[]>>({})
  const [manualModelInput, setManualModelInput] = useState('')
  const [modelSearchFilter, setModelSearchFilter] = useState('')
  const [showPresetPicker, setShowPresetPicker] = useState(false)
  const [providerHasKey, setProviderHasKey] = useState<Record<string, boolean>>({})
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [deleteKeys, setDeleteKeys] = useState<string[]>([])
  const [activeModel, setActiveModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('default')
  const [approvalMode, setApprovalMode] = useState<'balanced' | 'strict' | 'allow-all'>('balanced')
  const [agentRouting, setAgentRouting] = useState<Record<string, { model: string; reasoningEffort: string }>>({})
  const [allAgentIds, setAllAgentIds] = useState<string[]>([])
  const [routeDraftAgent, setRouteDraftAgent] = useState('')
  const [routeDraftModel, setRouteDraftModel] = useState('')
  const [cwd, setCwd] = useState('')
  const activeCwd = propCwd !== undefined ? (propCwd || '') : cwd
  const [localAgents, setLocalAgents] = useState<LocalAgentItem[]>([])
  const [localAgentErrors, setLocalAgentErrors] = useState<{ agentId: string; message: string }[]>([])
  const [loadingAgents, setLoadingAgents] = useState(false)
  const [editingAgent, setEditingAgent] = useState<{ id: string; displayName: string; filePath: string; content: string } | null>(null)
  const [savingAgentCode, setSavingAgentCode] = useState(false)
  const [agentEditError, setAgentEditError] = useState<string | null>(null)
  const [deletingAgent, setDeletingAgent] = useState<{ id: string; displayName: string; filePath: string } | null>(null)
  const [deletingInProgress, setDeletingInProgress] = useState(false)
  const [agentActionNotice, setAgentActionNotice] = useState<string | null>(null)

  const handleCreateAgentClick = () => {
    if (!activeCwd) {
      setAgentEditError('Please open a project folder before creating a custom agent.')
      return
    }
    setAgentEditError(null)
    onCreateAgent()
  }
  // Web Search settings tab
  const [webSearchProvider, setWebSearchProvider] = useState<WebSearchProviderId>('duckduckgo')
  const [webSearchHasKey, setWebSearchHasKey] = useState<Record<string, boolean>>({})
  const [searchApiKeys, setSearchApiKeys] = useState<Record<string, string>>({})
  const [deleteSearchKeys, setDeleteSearchKeys] = useState<WebSearchProviderId[]>([])
  // MCP Tools settings tab
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([])
  const [loadingMcp, setLoadingMcp] = useState(false)
  const [mcpNotice, setMcpNotice] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const [editingMcp, setEditingMcp] = useState<McpServerView | null>(null)
  const [showMcpForm, setShowMcpForm] = useState(false)
  const [showMcpPresetPicker, setShowMcpPresetPicker] = useState(false)
  // Paste/edit raw JSON (mcp.json format) to add a server
  const [showMcpJsonModal, setShowMcpJsonModal] = useState(false)
  const [mcpJsonText, setMcpJsonText] = useState('')
  // Edit mode for the add/edit modal: 'form' (fields) or 'json' (raw textarea)
  const [mcpEditMode, setMcpEditMode] = useState<'form' | 'json'>('form')
  const [mcpJsonDraftText, setMcpJsonDraftText] = useState('')
  const [mcpDraft, setMcpDraft] = useState<McpServerDraft | null>(null)
  const [mcpFormError, setMcpFormError] = useState<string | null>(null)
  const [mcpSaving, setMcpSaving] = useState(false)
  const [mcpTesting, setMcpTesting] = useState(false)
  const [mcpTestResult, setMcpTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [deleteMcpConfirm, setDeleteMcpConfirm] = useState<McpServerView | null>(null)
  const [mcpDeleteInProgress, setMcpDeleteInProgress] = useState(false)
  // Agent options for the target-agents picker (bundled + custom)
  const [mcpAgentOptions, setMcpAgentOptions] = useState<string[]>(DEFAULT_AGENT_IDS)
  const [error, setError] = useState<string | null>(null)
  const [fetchingId, setFetchingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  // electron-updater lifecycle (#3 自動更新)；dev/unpackaged 走舊的 GitHub API 比對。
  const [updater, setUpdater] = useState<UpdaterUiState>({ status: 'idle', version: '', percent: 0, message: '' })
  const [pendingUpdate, setPendingUpdate] = useState<{ latestVersion: string; url: string } | null>(null)

  // App version for the About tab
  useEffect(() => {
    if (typeof window.AnyBuff === 'undefined') return
    void (async () => {
      try {
        const res = (await window.AnyBuff.getAppVersion()) as { version?: string }
        if (res?.version) setAppVersion(res.version)
      } catch {
        // non-critical — leave the version blank rather than blocking Settings
      }
    })()
  }, [])

  // Live updater events (packaged builds): availability, download progress,
  // ready-to-install and errors arrive asynchronously from the main process.
  useEffect(() => {
    if (typeof window.AnyBuff === 'undefined' || !window.AnyBuff.onUpdateEvent) return
    return window.AnyBuff.onUpdateEvent((event) => {
      switch (event.type) {
        case 'checking-for-update':
          setUpdater((prev) => ({ ...prev, status: 'checking', message: '' }))
          break
        case 'update-available':
          setUpdater((prev) => ({ ...prev, status: 'available', version: event.version || prev.version }))
          break
        case 'update-not-available':
          setUpdater((prev) => ({ ...prev, status: 'up-to-date' }))
          break
        case 'download-progress':
          setUpdater((prev) => ({ ...prev, status: 'downloading', percent: typeof event.percent === 'number' ? event.percent : prev.percent }))
          break
        case 'update-downloaded':
          setUpdater((prev) => ({ ...prev, status: 'downloaded', percent: 100 }))
          break
        case 'update-error':
          setUpdater((prev) => ({ ...prev, status: 'error', message: event.message ?? 'Update failed.' }))
          break
      }
    })
  }, [])

  // Load initial settings
  useEffect(() => {
    if (typeof window.AnyBuff === 'undefined') {
      // Browser preview mode
      const previewProvider = { ...defaultCustom(), label: 'OpenAI API', baseURL: 'https://api.openai.com/v1', models: ['gpt-5.5', 'gpt-5.4-mini'] }
      setProviders([previewProvider])
      setActiveModel(`${previewProvider.id}/gpt-5.5`)
      setAgentRouting({
        editor: { model: `${previewProvider.id}/gpt-5.5`, reasoningEffort: 'default' },
        'file-picker': { model: `${previewProvider.id}/gpt-5.4-mini`, reasoningEffort: 'low' }
      })
      setAllAgentIds(['base2', 'code-reviewer', 'editor', 'file-picker', 'planner', 'researcher-web', 'thinker'])
      setLocalAgents([
        { id: 'doc-writer', displayName: 'Doc Writer', spawnerPrompt: 'Writes documentation', scope: 'project', filePath: 'C:/project/.agents/doc-writer.ts' },
        { id: 'qa-agent', displayName: 'QA Agent', spawnerPrompt: 'Runs acceptance checks', scope: 'home', filePath: '~/.agents/qa-agent.ts' }
      ])
      setWebSearchProvider('duckduckgo')
      setMcpServers([
        {
          id: 'mcp-demo-context7',
          name: 'context7',
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          enabled: true,
          targetAgents: ['base2', 'base2-plan'],
          source: 'app',
          hasSecrets: false
        },
        {
          id: 'file:demo',
          name: 'github',
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'github-mcp-server'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '$GITHUB_PERSONAL_ACCESS_TOKEN' },
          enabled: true,
          targetAgents: ['base2'],
          source: 'file',
          filePath: 'C:/project/.agents/mcp.json',
          hasSecrets: false
        }
      ])
      setMcpAgentOptions((prev) => [...new Set([...prev, ...['base2', 'code-reviewer', 'editor', 'file-picker', 'planner', 'researcher-web', 'thinker']])])
      setIsLoaded(true)
      return
    }
    void (async () => {
      const state = (await window.AnyBuff.getState()) as {
        settings?: {
          providers?: ProviderDraft[]
          activeModel?: string
          reasoningEffort?: string
          approvalMode?: 'balanced' | 'strict' | 'allow-all'
          providerHasKey?: Record<string, boolean>
          agentRouting?: Record<string, { model: string; reasoningEffort?: string }>
          webSearchProvider?: WebSearchProviderId
          webSearchHasKey?: Record<string, boolean>
        }
        agentIds?: string[]
      }
      const s = state.settings
      if (s?.providers && s.providers.length > 0) {
        const loaded = s.providers.map((p) => ({ ...p, models: [...(p.models ?? [])] }))
        setProviders(loaded)
      }
      setActiveModel(s?.activeModel ?? '')
      if (s?.reasoningEffort) setReasoningEffort(s.reasoningEffort)
      if (s?.approvalMode) setApprovalMode(s.approvalMode)
      setProviderHasKey(s?.providerHasKey ?? {})
      setAgentRouting(
        Object.fromEntries(
          Object.entries(s?.agentRouting ?? {}).map(([id, r]) => [id, { model: r.model, reasoningEffort: r.reasoningEffort ?? 'default' }])
        )
      )
      setWebSearchProvider(s?.webSearchProvider ?? 'duckduckgo')
      setWebSearchHasKey(s?.webSearchHasKey ?? {})
      setAllAgentIds(state.agentIds ?? [])
      setCwd((state as { cwd?: string }).cwd ?? '')
      if ((state as { cwd?: string }).cwd) {
        void refreshMcpServers((state as { cwd?: string }).cwd ?? null)
        const res = (await window.AnyBuff.listLocalAgents((state as { cwd?: string }).cwd as string)) as {
          agents: LocalAgentItem[]
          validationErrors: { agentId: string; message: string }[]
        }
        setLocalAgents(res.agents ?? [])
        setLocalAgentErrors((res.validationErrors ?? []).map((e) => ({ agentId: e.agentId, message: e.message })))
        const localIds = (res.agents ?? []).map((a) => a.id)
        setAllAgentIds((prev) => [...new Set([...prev, ...localIds])])
        setMcpAgentOptions((prev) => [...new Set([...prev, ...localIds])])
      }
      setIsLoaded(true)
    })()
  }, [])

  // Auto-save logic
  const saveState = useCallback(async () => {
    if (!isLoaded || providers.length === 0) return

    for (const p of providers) {
      if (urlError(p.baseURL)) {
        return // skip auto-saving if invalid URL while typing
      }
    }

    let finalModel = activeModel
    const modelValid = providers.some(
      (p) => finalModel.startsWith(`${p.id}/`) && p.models.some((m) => `${p.id}/${m}` === finalModel)
    )
    if (!modelValid) {
      const first = providers.find((p) => p.models.length > 0)
      if (first) finalModel = `${first.id}/${first.models[0]}`
    }

    if (typeof window.AnyBuff === 'undefined') {
      onSaved?.({ hasProvider: true })
      return
    }

    try {
      const usedEnv = new Set<string>()
      const normalizedProviders = providers.map((p) => {
        let env = p.apiKeyEnv || 'ANYBUFF_API_KEY'
        let i = 1
        while (usedEnv.has(env)) env = `ANYBUFF_API_KEY_${++i}`
        usedEnv.add(env)
        return { ...p, apiKeyEnv: env }
      })

      const result = (await window.AnyBuff.saveSettings({
        providers: normalizedProviders.map((p) => ({
          id: p.id,
          label: p.label,
          type: p.type,
          baseURL: p.baseURL.trim(),
          apiKeyEnv: p.apiKeyEnv || 'ANYBUFF_API_KEY',
          models: p.models,
          enableThinking: p.enableThinking,
          customBody: p.customBody
        })),
        activeModel: finalModel,
        reasoningEffort,
        approvalMode,
        apiKeys: Object.fromEntries(Object.entries(apiKeys).filter(([, v]) => v.trim())),
        deleteKeys,
        agentRouting: Object.fromEntries(Object.entries(agentRouting).filter(([, r]) => r.model.trim())),
        webSearchProvider,
        searchApiKeys: Object.fromEntries(
          Object.entries(searchApiKeys).filter(([provider, v]) => v.trim() && (provider === 'tinyfish' || provider === 'firecrawl'))
        ),
        deleteSearchKeys
      })) as { ok?: boolean; settings?: { hasProvider?: boolean }; error?: string }

      if (result.ok) {
        onSaved?.({ hasProvider: Boolean(result.settings?.hasProvider) })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Settings auto-save failed:', err)
      setError(`Save failed: ${message}`)
    }
  }, [isLoaded, providers, activeModel, reasoningEffort, approvalMode, apiKeys, deleteKeys, agentRouting, webSearchProvider, searchApiKeys, deleteSearchKeys, onSaved])

  const isInitialMount = useRef(true)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false
      return
    }
    if (!isLoaded) return

    const timer = setTimeout(() => {
      void saveState()
    }, 400)
    return () => clearTimeout(timer)
  }, [saveState, isLoaded])

  const refreshLocalAgents = async () => {
    if (typeof window.AnyBuff === 'undefined') {
      setLocalAgents([
        { id: 'doc-writer', displayName: 'Doc Writer', spawnerPrompt: 'Writes documentation', scope: 'project', filePath: 'C:/project/.agents/doc-writer.ts' },
        { id: 'qa-agent', displayName: 'QA Agent', spawnerPrompt: 'Runs acceptance checks', scope: 'home', filePath: '~/.agents/qa-agent.ts' }
      ])
      return
    }
    if (!cwd) return
    setLoadingAgents(true)
    try {
      const res = (await window.AnyBuff.listLocalAgents(cwd)) as {
        agents: LocalAgentItem[]
        validationErrors: { agentId: string; message: string }[]
      }
      setLocalAgents(res.agents ?? [])
      setLocalAgentErrors((res.validationErrors ?? []).map((e) => ({ agentId: e.agentId, message: e.message })))
    } finally {
      setLoadingAgents(false)
    }
  }

  const refreshMcpServers = async (dir: string | null = cwd) => {
    if (typeof window.AnyBuff === 'undefined') return
    setLoadingMcp(true)
    try {
      const res = (await window.AnyBuff.listMcpServers(dir)) as McpServerView[]
      setMcpServers(res ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingMcp(false)
    }
  }

  const openMcpForm = (existing: McpServerView | null = null, preset?: McpPreset) => {
    setMcpFormError(null)
    setMcpTestResult(null)
    setMcpNotice(null)
    setMcpEditMode('form')
    if (existing) {
      setEditingMcp(existing)
      const draft: McpServerDraft = {
        id: existing.id,
        name: existing.name,
        type: existing.type,
        command: existing.command,
        args: existing.args ? [...existing.args] : [],
        url: existing.url,
        env: existing.env ? { ...existing.env } : {},
        headers: existing.headers ? { ...existing.headers } : {},
        params: existing.params ? { ...existing.params } : {},
        enabled: existing.enabled,
        targetAgents: [...existing.targetAgents]
      }
      setMcpDraft(draft)
      setMcpJsonDraftText(JSON.stringify(draftToMcpJson(draft), null, 2))
    } else {
      setEditingMcp(null)
      const draft: McpServerDraft = {
        name: preset?.label ?? '',
        type: preset?.type ?? 'stdio',
        command: preset?.command ?? 'npx',
        args: preset?.args ? [...preset.args] : [],
        url: preset?.url ?? '',
        env: preset?.envHint ? Object.fromEntries(preset.envHint.map((e) => [e.key, e.varName])) : {},
        headers: preset?.headerHint ? Object.fromEntries(preset.headerHint.map((e) => [e.key, e.varName])) : {},
        params: {},
        enabled: true,
        targetAgents: [...DEFAULT_TARGET_AGENTS]
      }
      setMcpDraft(draft)
      setMcpJsonDraftText(JSON.stringify(draftToMcpJson(draft), null, 2))
    }
    setShowMcpForm(true)
    setShowMcpPresetPicker(false)
  }

  /**
   * Parse raw mcp.json-style JSON pasted by the user and open the edit form
   * prefilled. Accepts:
   *  1. A single server object:       { "command": "npx", "args": [...] }
   *  2. A named server object:        { "context7": { "command": ... } }
   *  3. A full mcp.json:              { "mcpServers": { "context7": {...} } }
   * Throws a descriptive Error on invalid JSON / schema.
   */
  const parseMcpJsonToDraft = (raw: string, serverName: string): McpServerDraft => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }

    let servers: Record<string, unknown>
    // Format 3: full mcp.json with a mcpServers map
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>
      if (rec.mcpServers && typeof rec.mcpServers === 'object' && !Array.isArray(rec.mcpServers)) {
        servers = rec.mcpServers as Record<string, unknown>
        // Format 2: a map of name → server object
      } else if (Object.keys(rec).some((k) => rec[k] && typeof rec[k] === 'object' && !Array.isArray(rec[k]))) {
        servers = rec
      } else {
        servers = { [serverName || 'mcp-server']: rec }
      }
    } else {
      throw new Error('Expected a JSON object describing an MCP server or a mcpServers map.')
    }

    const names = Object.keys(servers).filter((k) => k && k !== 'mcpServers')
    if (names.length === 0) {
      throw new Error('No MCP servers found in the JSON. Expected entries under "mcpServers".')
    }
    const name = names[0]
    const cfg = (servers[name] ?? {}) as Record<string, unknown>
    const type = (cfg.type as McpServerType) ?? (cfg.command ? 'stdio' : (cfg.url ? 'http' : undefined))
    if (type !== 'stdio' && type !== 'http' && type !== 'sse') {
      throw new Error('Server config must include "command" (stdio) or "url" + "type" (http/sse).')
    }
    return {
      name,
      type,
      command: cfg.command as string | undefined,
      args: Array.isArray(cfg.args) ? (cfg.args as string[]) : [],
      url: cfg.url as string | undefined,
      env: (cfg.env as Record<string, string> | undefined) ?? {},
      headers: (cfg.headers as Record<string, string> | undefined) ?? {},
      params: (cfg.params as Record<string, string> | undefined) ?? {},
      enabled: true,
      targetAgents: [...DEFAULT_TARGET_AGENTS]
    }
  }

  /** Open the JSON import modal (or prefill from an existing server's config). */
  const openMcpJsonModal = (existing: McpServerView | null = null) => {
    setMcpFormError(null)
    setMcpTestResult(null)
    setMcpNotice(null)
    if (existing) {
      const payload: Record<string, unknown> = {}
      if (existing.type === 'stdio') {
        payload.command = existing.command
        if (existing.args?.length) payload.args = existing.args
      } else {
        payload.type = existing.type
        payload.url = existing.url
      }
      if (existing.env && Object.keys(existing.env).length) payload.env = existing.env
      if (existing.headers && Object.keys(existing.headers).length) payload.headers = existing.headers
      if (existing.params && Object.keys(existing.params).length) payload.params = existing.params
      setMcpJsonText(JSON.stringify({ [existing.name]: payload }, null, 2))
    } else {
      setMcpJsonText('')
    }
    setShowMcpJsonModal(true)
  }

  const handleImportMcpJson = () => {
    try {
      const draft = parseMcpJsonToDraft(mcpJsonText, '')
      setMcpDraft(draft)
      setEditingMcp(null)
      setShowMcpJsonModal(false)
      setMcpJsonText('')
      setShowMcpForm(true)
    } catch (err) {
      setMcpFormError(err instanceof Error ? err.message : String(err))
    }
  }

  const updateMcpDraft = (patch: Partial<McpServerDraft>) => {
    setMcpDraft((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  const addMcpEnvRow = () => {
    updateMcpDraft({ env: { ...(mcpDraft?.env ?? {}), '': '' } })
  }
  const addMcpHeaderRow = () => {
    updateMcpDraft({ headers: { ...(mcpDraft?.headers ?? {}), '': '' } })
  }
  const addMcpParamRow = () => {
    updateMcpDraft({ params: { ...(mcpDraft?.params ?? {}), '': '' } })
  }
  const removeMcpRow = (kind: 'env' | 'headers' | 'params', key: string) => {
    const obj = mcpDraft?.[kind]
    if (!obj) return
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k !== key) next[k] = v
    }
    updateMcpDraft({ [kind]: next } as Partial<McpServerDraft>)
  }
  const renameMcpRow = (kind: 'env' | 'headers' | 'params', oldKey: string, newKey: string) => {
    const obj = mcpDraft?.[kind]
    if (!obj) return
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj)) {
      next[k === oldKey ? newKey : k] = v
    }
    updateMcpDraft({ [kind]: next } as Partial<McpServerDraft>)
  }

  /** Shared validation + persist for a draft (used by form and JSON modes). */
  const persistMcpDraft = async (draft: McpServerDraft): Promise<void> => {
    const name = draft.name.trim()
    if (!name) {
      setMcpFormError('Server name is required.')
      return
    }
    if (draft.type === 'stdio' && !draft.command?.trim()) {
      setMcpFormError('Command is required for stdio servers.')
      return
    }
    if (draft.type !== 'stdio') {
      const url = draft.url?.trim() ?? ''
      if (!url) {
        setMcpFormError('URL is required for remote servers.')
        return
      }
      try {
        const u = new URL(url)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          setMcpFormError('URL must start with http:// or https://')
          return
        }
      } catch {
        setMcpFormError('Invalid URL — expected e.g. https://mcp.example.com/mcp')
        return
      }
    }
    // Empty env/header keys would save as a `'' → value` entry; drop them.
    const cleanedDraft: McpServerDraft = {
      ...draft,
      name,
      env: cleanKv(draft.env),
      headers: cleanKv(draft.headers),
      params: cleanKv(draft.params)
    }
    if (cleanedDraft.targetAgents.length === 0) {
      setMcpFormError('Pick at least one agent to expose this server to.')
      return
    }
    if (typeof window.AnyBuff === 'undefined') {
      setMcpNotice({ id: 'save', text: `Saved ${name} (preview mode)`, ok: true })
      setShowMcpForm(false)
      return
    }
    setMcpSaving(true)
    try {
      const res = (await window.AnyBuff.saveMcpServer(cleanedDraft)) as { ok: boolean; server?: McpServerView; error?: string }
      if (!res.ok || !res.server) {
        setMcpFormError(res.error ?? 'Failed to save MCP server.')
        return
      }
      setMcpNotice({ id: res.server.id, text: `Saved ${res.server.name}`, ok: true })
      setShowMcpForm(false)
      await refreshMcpServers()
    } catch (err) {
      setMcpFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpSaving(false)
    }
  }

  const handleSaveMcp = async () => {
    if (!mcpDraft) return
    setMcpFormError(null)
    // In JSON mode the user edited raw mcp.json syntax — parse it back into
    // the draft (preserving id/enabled/targetAgents from the current draft)
    // before validating, then persist.
    if (mcpEditMode === 'json') {
      try {
        const parsed = parseMcpJsonToDraft(mcpJsonDraftText, mcpDraft.name)
        setMcpDraft({
          ...parsed,
          id: mcpDraft.id,
          enabled: mcpDraft.enabled,
          targetAgents: mcpDraft.targetAgents
        })
        await persistMcpDraft({
          ...parsed,
          id: mcpDraft.id,
          enabled: mcpDraft.enabled,
          targetAgents: mcpDraft.targetAgents
        })
      } catch (err) {
        setMcpFormError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    await persistMcpDraft(mcpDraft)
  }

  const handleToggleMcpEnabled = async (server: McpServerView, enabled: boolean) => {
    setMcpServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled } : s)))
    if (typeof window.AnyBuff === 'undefined') return
    try {
      await window.AnyBuff.updateMcpServerSettings({ cwd, id: server.id, enabled })
      setMcpNotice({ id: server.id, text: `${server.name} ${enabled ? 'enabled' : 'disabled'}`, ok: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setMcpServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled: !enabled } : s)))
    }
  }

  const handleToggleMcpAgent = async (server: McpServerView, agentId: string) => {
    const next = server.targetAgents.includes(agentId)
      ? server.targetAgents.filter((a) => a !== agentId)
      : [...server.targetAgents, agentId]
    setMcpServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, targetAgents: next } : s)))
    if (typeof window.AnyBuff === 'undefined') return
    try {
      await window.AnyBuff.updateMcpServerSettings({ cwd, id: server.id, targetAgents: next })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleTestMcp = async () => {
    if (!mcpDraft) return
    setMcpTestResult(null)
    if (typeof window.AnyBuff === 'undefined') {
      setMcpTestResult({ ok: true, text: 'Connection OK (preview mode)' })
      return
    }
    setMcpTesting(true)
    try {
      const res = (await window.AnyBuff.testMcpServer({ record: mcpDraft })) as {
        ok: boolean
        tools?: { name: string }[]
        error?: string
      }
      if (!res.ok) {
        setMcpTestResult({ ok: false, text: res.error ?? 'Connection failed.' })
        return
      }
      const tools = res.tools ?? []
      setMcpTestResult({
        ok: true,
        text:
          tools.length > 0
            ? `Connected — ${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.map((t) => t.name).slice(0, 8).join(', ')}${tools.length > 8 ? '…' : ''}`
            : 'Connected — server exposes no tools'
      })
    } catch (err) {
      setMcpTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setMcpTesting(false)
    }
  }

  const handleDeleteMcp = async () => {
    if (!deleteMcpConfirm) return
    setMcpDeleteInProgress(true)
    try {
      if (typeof window.AnyBuff === 'undefined') {
        setMcpServers((prev) => prev.filter((s) => s.id !== deleteMcpConfirm.id))
        setMcpNotice({ id: deleteMcpConfirm.id, text: `Deleted ${deleteMcpConfirm.name}`, ok: true })
        setDeleteMcpConfirm(null)
        return
      }
      const res = (await window.AnyBuff.deleteMcpServer({ id: deleteMcpConfirm.id })) as { ok: boolean; error?: string }
      if (!res.ok) {
        setError(res.error ?? 'Failed to delete MCP server.')
        return
      }
      setMcpNotice({ id: deleteMcpConfirm.id, text: `Deleted ${deleteMcpConfirm.name}`, ok: true })
      setDeleteMcpConfirm(null)
      await refreshMcpServers()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpDeleteInProgress(false)
    }
  }

  const handleStartEditAgent = async (agent: LocalAgentItem) => {
    setAgentEditError(null)
    const filePath = agent.filePath || agent.source || ''
    if (!filePath) {
      setAgentEditError('No file path found for this agent.')
      return
    }
    if (typeof window.AnyBuff === 'undefined') {
      setEditingAgent({
        id: agent.id,
        displayName: agent.displayName,
        filePath,
        content: `const definition = {\n  id: ${JSON.stringify(agent.id)},\n  displayName: ${JSON.stringify(agent.displayName)},\n  spawnerPrompt: ${JSON.stringify(agent.spawnerPrompt)},\n  toolNames: ['read_files', 'list_directory'],\n  systemPrompt: 'You are a helpful agent specialist.',\n  instructionsPrompt: '1. Handle the task efficiently.'\n}\n\nexport default definition\n`
      })
      return
    }
    try {
      const res = (await window.AnyBuff.readLocalAgentFile({ filePath })) as { ok: boolean; content?: string; error?: string }
      if (!res.ok || typeof res.content === 'undefined') {
        setAgentEditError(res.error ?? 'Failed to read agent source file.')
        return
      }
      setEditingAgent({
        id: agent.id,
        displayName: agent.displayName,
        filePath,
        content: res.content
      })
    } catch (err) {
      setAgentEditError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSaveAgentCode = async () => {
    if (!editingAgent) return
    setSavingAgentCode(true)
    setAgentEditError(null)
    try {
      if (typeof window.AnyBuff === 'undefined') {
        setAgentActionNotice(`Updated ${editingAgent.displayName}`)
        setEditingAgent(null)
        return
      }
      const res = (await window.AnyBuff.saveLocalAgentFile({ filePath: editingAgent.filePath, content: editingAgent.content })) as { ok: boolean; error?: string }
      if (!res.ok) {
        setAgentEditError(res.error ?? 'Failed to save agent file.')
        return
      }
      setAgentActionNotice(`Successfully updated ${editingAgent.displayName}`)
      setEditingAgent(null)
      await refreshLocalAgents()
    } catch (err) {
      setAgentEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingAgentCode(false)
    }
  }

  const handleConfirmDeleteAgent = async () => {
    if (!deletingAgent) return
    setDeletingInProgress(true)
    try {
      if (typeof window.AnyBuff === 'undefined') {
        setLocalAgents((prev) => prev.filter((a) => a.id !== deletingAgent.id))
        setAgentActionNotice(`Deleted ${deletingAgent.displayName}`)
        setDeletingAgent(null)
        return
      }
      const res = (await window.AnyBuff.deleteLocalAgent({ cwd, filePath: deletingAgent.filePath, id: deletingAgent.id })) as { ok: boolean; error?: string }
      if (!res.ok) {
        setError(res.error ?? 'Failed to delete agent.')
        return
      }
      setAgentActionNotice(`Successfully deleted ${deletingAgent.displayName}`)
      setDeletingAgent(null)
      await refreshLocalAgents()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingInProgress(false)
    }
  }

  const handleCheckForUpdates = async () => {
    if (typeof window.AnyBuff === 'undefined') {
      setUpdater({ status: 'error', version: '', percent: 0, message: 'Update check is unavailable in browser preview mode.' })
      return
    }
    setUpdater((prev) => ({ ...prev, status: 'checking', message: '' }))
    try {
      // Packaged installs go through electron-updater (auto-download kicks in
      // main-side); dev runs fall back to the plain GitHub API check.
      if (typeof window.AnyBuff.updateCheck === 'function') {
        const res = (await window.AnyBuff.updateCheck()) as UpdateCheckResult
        if (!res.ok) {
          setUpdater({ status: 'error', version: '', percent: 0, message: res.error ?? 'Failed to check for updates.' })
          return
        }
        if (res.updateAvailable) {
          setUpdater({ status: 'available', version: res.latestVersion ?? '', percent: 0, message: '' })
          void window.AnyBuff.updateDownload?.()
        } else {
          setUpdater({ status: 'up-to-date', version: res.currentVersion ?? '', percent: 0, message: '' })
        }
        return
      }
      const res = (await window.AnyBuff.checkForUpdates()) as UpdateCheckResult
      if (!res.ok) {
        setUpdater({ status: 'error', version: '', percent: 0, message: res.error ?? 'Failed to check for updates.' })
        return
      }
      if (res.updateAvailable && res.latestVersion && res.url) {
        setPendingUpdate({ latestVersion: res.latestVersion, url: res.url })
        setUpdater({ status: 'idle', version: '', percent: 0, message: '' })
      } else {
        setUpdater({ status: 'up-to-date', version: res.currentVersion ?? '', percent: 0, message: '' })
      }
    } catch (err) {
      setUpdater({ status: 'error', version: '', percent: 0, message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Quit and apply a downloaded update (NSIS silent install handoff). */
  const handleInstallUpdate = async () => {
    try {
      await window.AnyBuff.updateInstall()
    } catch (err) {
      setUpdater({ status: 'error', version: '', percent: 0, message: err instanceof Error ? err.message : String(err) })
    }
  }

  const updateProvider = (id: string, patch: Partial<ProviderDraft>) => {
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const addProvider = () => {
    const newP = defaultCustom()
    setProviders((prev) => [...prev, newP])
    setEditingProviderId(newP.id)
  }

  const applyPreset = (preset: ProviderPreset) => {
    const newId = `preset-${preset.label.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now().toString(36)}`
    const newP: ProviderDraft = {
      id: newId,
      label: preset.label,
      type: preset.type,
      baseURL: preset.baseURL,
      apiKeyEnv: preset.apiKeyEnv || 'ANYBUFF_API_KEY',
      models: [],
      enableThinking: preset.enableThinking
    }
    setProviders((prev) => [...prev, newP])
    setEditingProviderId(newId)
    setShowPresetPicker(false)
  }

  const removeProvider = (id: string) => {
    setProviders((prev) => {
      const next = prev.filter((p) => p.id !== id)
      if (editingProviderId === id) {
        setEditingProviderId(null)
      }
      return next
    })
    setDeleteKeys((prev) => [...prev, id])
    const modelPrefix = `${id}/`
    if (activeModel.startsWith(modelPrefix)) {
      setActiveModel('')
    }
  }

  const toggleModel = (providerId: string, modelName: string) => {
    setProviders((prev) =>
      prev.map((p) => {
        if (p.id !== providerId) return p
        const exists = p.models.includes(modelName)
        const nextModels = exists ? p.models.filter((m) => m !== modelName) : [...p.models, modelName]
        return { ...p, models: nextModels }
      })
    )
    if (activeModel === `${providerId}/${modelName}`) {
      setActiveModel('')
    }
  }

  const selectAllModels = (providerId: string) => {
    const p = providers.find((pr) => pr.id === providerId)
    if (!p) return
    const candidates = Array.from(new Set([...(fetchedModelsMap[providerId] || []), ...p.models]))
    updateProvider(providerId, { models: candidates })
  }

  const deselectAllModels = (providerId: string) => {
    updateProvider(providerId, { models: [] })
    if (activeModel.startsWith(`${providerId}/`)) {
      setActiveModel('')
    }
  }

  const deleteModelFromCandidate = (providerId: string, modelName: string) => {
    setProviders((prev) =>
      prev.map((p) => (p.id === providerId ? { ...p, models: p.models.filter((m) => m !== modelName) } : p))
    )
    setFetchedModelsMap((prev) => ({
      ...prev,
      [providerId]: (prev[providerId] || []).filter((m) => m !== modelName)
    }))
    if (activeModel === `${providerId}/${modelName}`) {
      setActiveModel('')
    }
  }

  const handleManualAddModel = (providerId: string) => {
    const m = manualModelInput.trim()
    if (!m) return
    setProviders((prev) =>
      prev.map((p) => (p.id === providerId && !p.models.includes(m) ? { ...p, models: [...p.models, m] } : p))
    )
    setFetchedModelsMap((prev) => ({
      ...prev,
      [providerId]: Array.from(new Set([...(prev[providerId] || []), m]))
    }))
    setManualModelInput('')
  }

  const testConnection = async (p: ProviderDraft) => {
    setError(null)
    setTestMsg(null)
    const ue = urlError(p.baseURL)
    if (ue) {
      setError(`Connection test: ${ue}`)
      return
    }
    if (typeof window.AnyBuff === 'undefined') {
      setTestMsg({ id: p.id, text: 'Connection OK (preview mode)', ok: true })
      return
    }
    setTestingId(p.id)
    try {
      const result = (await window.AnyBuff.fetchModels({
        baseURL: p.baseURL.trim(),
        apiKey: (apiKeys[p.id] ?? '').trim(),
        providerId: p.id,
        providerType: 'custom'
      })) as { ok: boolean; models?: string[]; error?: string }
      if (!result.ok) {
        setTestMsg({ id: p.id, text: `Connection failed: ${result.error ?? 'Unknown error'}`, ok: false })
        return
      }
      setTestMsg({ id: p.id, text: `Connection OK — ${result.models?.length ?? 0} models found`, ok: true })
    } catch (err) {
      setTestMsg({ id: p.id, text: `Connection failed: ${String(err)}`, ok: false })
    } finally {
      setTestingId(null)
    }
  }

  const fetchModels = async (p: ProviderDraft) => {
    setError(null)
    setTestMsg(null)
    const ue = urlError(p.baseURL)
    if (ue) {
      setError(`Fetch models: ${ue}`)
      return
    }
    if (typeof window.AnyBuff === 'undefined') {
      const previewList = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-4.1', 'gpt-4o', 'o3-mini']
      setFetchedModelsMap((prev) => ({ ...prev, [p.id]: previewList }))
      return
    }
    setFetchingId(p.id)
    try {
      const result = (await window.AnyBuff.fetchModels({
        baseURL: p.baseURL.trim(),
        apiKey: (apiKeys[p.id] ?? '').trim(),
        providerId: p.id,
        providerType: 'custom'
      })) as { ok: boolean; models?: string[]; error?: string }
      if (!result.ok) {
        setError(`Failed to fetch models: ${result.error ?? 'Unknown error'}`)
        return
      }
      const fetched = result.models ?? []
      setFetchedModelsMap((prev) => ({ ...prev, [p.id]: fetched }))
    } catch (err) {
      setError(`Failed to fetch models: ${String(err)}`)
    } finally {
      setFetchingId(null)
    }
  }

  const selectedProvider = providers.find((p) => p.id === editingProviderId) ?? null

  const candidateModels = useMemo(() => {
    if (!selectedProvider) return []
    const fetched = fetchedModelsMap[selectedProvider.id] || []
    return Array.from(new Set([...fetched, ...selectedProvider.models]))
  }, [selectedProvider, fetchedModelsMap])

  const filteredCandidates = useMemo(() => {
    if (!modelSearchFilter.trim()) return candidateModels
    const q = modelSearchFilter.trim().toLowerCase()
    return candidateModels.filter((m) => m.toLowerCase().includes(q))
  }, [candidateModels, modelSearchFilter])

  const NAV_ITEMS: { id: SettingsTab; label: string; icon: React.ReactNode; badge?: number | string }[] = [
    {
      id: 'general',
      label: 'General',
      icon: <SettingsIcon size={16} />
    },
    {
      id: 'theme',
      label: 'Theme',
      icon: <PaletteIcon size={16} />
    },
    {
      id: 'providers',
      label: 'Providers & Models',
      icon: <SparklesIcon size={16} />
    },
    {
      id: 'search',
      label: 'Web Search',
      icon: <SearchIcon size={16} />
    },
    {
      id: 'mcp',
      label: 'MCP Tools',
      icon: <PlugIcon size={16} />
    },
    {
      id: 'routing',
      label: 'Agent Routing',
      icon: <ActivityIcon size={16} />
    },
    {
      id: 'agents',
      label: 'Custom Agents',
      icon: <SpecialistIcon size={16} />
    },
    {
      id: 'about',
      label: 'About',
      icon: <InfoIcon size={16} />
    }
  ]

  return (
    <div className="settings-page">
      {/* Mobile Topbar with Category Dropdown */}
      <header className="settings-mobile-topbar">
        <button
          type="button"
          className="settings-back-btn"
          onClick={() => {
            if (editingProviderId) {
              setEditingProviderId(null)
              setError(null)
              setTestMsg(null)
            } else {
              onClose()
            }
          }}
          title={editingProviderId ? 'Back to providers' : 'Back to workspace'}
        >
          <ChevronLeftIcon size={16} />
        </button>

        <div className="settings-category-selector" ref={categoryDropdownRef}>
          <button
            type="button"
            className="settings-category-btn"
            onClick={() => setCategoryDropdownOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={categoryDropdownOpen}
          >
            <span className="settings-category-icon">
              {NAV_ITEMS.find((n) => n.id === activeTab)?.icon}
            </span>
            <span className="settings-category-name">
              {editingProviderId
                ? 'Provider Configuration'
                : (NAV_ITEMS.find((n) => n.id === activeTab)?.label ?? 'Settings')}
            </span>
            <ChevronDownIcon size={12} className={`settings-category-chevron ${categoryDropdownOpen ? 'open' : ''}`} />
          </button>

          {categoryDropdownOpen && (
            <div className="settings-category-dropdown" role="listbox">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={activeTab === item.id && !editingProviderId}
                  className={`settings-category-dropdown-item ${activeTab === item.id && !editingProviderId ? 'active' : ''}`}
                  onClick={() => {
                    setError(null)
                    setActiveTab(item.id)
                    setEditingProviderId(null)
                    if (item.id === 'mcp') setMcpNotice(null)
                    setCategoryDropdownOpen(false)
                  }}
                >
                  <span className="sc-item-icon">{item.icon}</span>
                  <span className="sc-item-label">{item.label}</span>
                  {activeTab === item.id && !editingProviderId && (
                    <span className="sc-item-check">✓</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className="icon-btn settings-close-btn"
          onClick={onClose}
          title="Close Settings"
        >
          <XIcon size={16} />
        </button>
      </header>

      {/* Left Category Sidebar (desktop) */}
      <aside className="settings-page-sidebar">
        <div className="settings-page-sidebar-header">
          <button type="button" className="settings-back-btn" onClick={onClose} title="Back to workspace">
            <ChevronLeftIcon size={15} />
            <span>Back</span>
          </button>
        </div>

        <div className="settings-page-sidebar-title" style={{ marginTop: '16px', marginBottom: '-4px' }}>
          <span>Settings</span>
        </div>

        <nav className="settings-modal-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-modal-nav-item ${activeTab === item.id ? 'active' : ''}`}
              onClick={() => {
                setError(null)
                setActiveTab(item.id)
                if (item.id === 'mcp') setMcpNotice(null)
                if (item.id !== 'providers') {
                  setEditingProviderId(null)
                }
              }}
            >
              <span className="settings-modal-nav-icon">{item.icon}</span>
              <span className="settings-modal-nav-label">{item.label}</span>
              {item.badge !== undefined && <span className="settings-modal-nav-badge">{item.badge}</span>}
            </button>
          ))}
        </nav>
      </aside>

      {/* Right Main Content Panel */}
      <section className="settings-page-main">
        {/* Header */}
        <header className="settings-page-header">
          <div>
            <h2>
              {activeTab === 'providers' && (editingProviderId ? 'Provider Configuration' : 'Providers & Models')}
              {activeTab === 'general' && 'General'}
              {activeTab === 'theme' && 'Theme & Appearance'}
              {activeTab === 'routing' && 'Agent Routing'}
              {activeTab === 'agents' && 'Custom Agents'}
              {activeTab === 'search' && 'Web Search'}
              {activeTab === 'mcp' && 'MCP Tools'}
              {activeTab === 'about' && 'About'}
            </h2>
            <p className="hint">
              {activeTab === 'providers' &&
                (editingProviderId
                  ? 'Configure API endpoint parameters, encryption keys, and active models for this provider.'
                  : 'Manage AI model providers and endpoints. Changes are saved automatically.')}
              {activeTab === 'general' &&
                'Set your default model, reasoning effort, and tool approval mode.'}
              {activeTab === 'theme' &&
                'Customize the appearance mode and color scheme palette of AnyBuff.'}
              {activeTab === 'routing' &&
                'Route specific agent roles to different models and customize reasoning effort per agent.'}
              {activeTab === 'agents' &&
                'Manage local agents loaded from .agents/ directories in your project or home.'}
              {activeTab === 'search' &&
                'Choose which provider the web_search tool uses. DuckDuckGo needs no key; Firecrawl works keyless; Tinyfish requires an API key.'}
              {activeTab === 'mcp' &&
                'Connect Model Context Protocol servers and choose which agents can use their tools. Inline secrets are stored encrypted (DPAPI); $VAR references resolve at runtime.'}
            </p>
          </div>
        </header>

        {/* Body */}
        <div className="settings-page-body">
          {error && <div className="error settings-page-error">{error}</div>}

          {/* 1. Providers Tab */}
          {activeTab === 'providers' && (
            <div className="settings-tab-content">
              {!editingProviderId || !selectedProvider ? (
                /* View 1: Provider Cards / List */
                <div className="provider-list-view">
                  <div className="provider-list-view-header">
                    <div>
                      <h3>Providers</h3>
                      <p className="hint">Click a provider to configure its endpoint and models.</p>
                    </div>
                    <div className="provider-list-view-actions">
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => setShowPresetPicker(true)}
                        title="Add from preset templates"
                      >
                        <LayersIcon size={13} /> Add from Preset
                      </button>
                      <button
                        type="button"
                        className="btn accent small"
                        onClick={addProvider}
                        title="Add a custom OpenAI/Anthropic compatible provider"
                      >
                        <PlusIcon size={13} /> Add Custom Provider
                      </button>
                    </div>
                  </div>

                  {providers.length === 0 ? (
                    <div className="settings-empty-card">
                      <p>No providers configured yet.</p>
                      <div className="settings-empty-actions">
                        <button type="button" className="btn accent small" onClick={() => setShowPresetPicker(true)}>
                          <LayersIcon size={13} /> Add from Preset
                        </button>
                        <button type="button" className="btn ghost small" onClick={addProvider}>
                          <PlusIcon size={13} /> Add Custom Provider
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="provider-cards-grid">
                      {providers.map((p) => {
                        const hasKey = Boolean(providerHasKey[p.id] || apiKeys[p.id])
                        const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(p.baseURL)
                        return (
                          <div
                            key={p.id}
                            className="provider-summary-card"
                            onClick={() => {
                              setEditingProviderId(p.id)
                              setError(null)
                              setTestMsg(null)
                              setModelSearchFilter('')
                            }}
                          >
                            <div className="provider-summary-head">
                              <div className="provider-summary-title-wrap">
                                <span className="provider-summary-name">{p.label || 'Unnamed Provider'}</span>
                                <span className="provider-summary-type">
                                  {p.type === 'anthropic-compatible' ? 'Anthropic' : 'OpenAI'}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="mini-btn danger"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  removeProvider(p.id)
                                }}
                                title="Remove provider"
                              >
                                <TrashIcon size={13} />
                              </button>
                            </div>
                            <div className="provider-summary-url" title={p.baseURL}>
                              {p.baseURL}
                            </div>
                            <div className="provider-summary-footer">
                              <span className="provider-summary-badge">
                                {p.models.length} {p.models.length === 1 ? 'model' : 'models'}
                              </span>
                              <span
                                className={`provider-list-key-tag ${
                                  isLocal ? 'local' : hasKey ? 'saved' : 'missing'
                                }`}
                              >
                                {isLocal ? 'Local' : hasKey ? 'Key Set' : 'No Key'}
                              </span>
                              <span className="provider-summary-arrow">Configure →</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ) : (
                /* View 2: Provider Detail & Models Configuration */
                <div className="provider-detail-view">
                  <div className="provider-detail-top-nav">
                    <button
                      type="button"
                      className="btn ghost small back-to-list-btn"
                      onClick={() => {
                        setEditingProviderId(null)
                        setError(null)
                        setTestMsg(null)
                      }}
                    >
                      <ChevronLeftIcon size={14} /> Back to Providers
                    </button>
                    <span className="provider-detail-heading">{selectedProvider.label || 'Provider'} Settings</span>
                  </div>

                  {/* Section 1: Provider Config */}
                  <div className="provider-detail-section">
                    <div className="provider-detail-section-head">
                      <span className="provider-detail-section-title">Endpoint & Credentials</span>
                    </div>

                    <div className="provider-fields-grid">
                      <div className="settings-field-group">
                        <label className="settings-field-label">Provider Name</label>
                        <input
                          value={selectedProvider.label}
                          onChange={(e) => updateProvider(selectedProvider.id, { label: e.target.value })}
                          placeholder="e.g. OpenAI API, DeepSeek"
                        />
                      </div>

                      <div className="settings-field-group">
                        <label className="settings-field-label">API Type</label>
                        <CustomSelect
                          value={selectedProvider.type}
                          onChange={(val) =>
                            updateProvider(selectedProvider.id, { type: val as ProviderType })
                          }
                          size="medium"
                          options={[
                            { value: 'openai-compatible', label: 'OpenAI Compatible' },
                            { value: 'anthropic-compatible', label: 'Anthropic Compatible' }
                          ]}
                        />
                      </div>
                    </div>

                    <div className="settings-field-group">
                      <label className="settings-field-label">Base URL</label>
                      <div className="url-row">
                        <input
                          value={selectedProvider.baseURL}
                          onChange={(e) => updateProvider(selectedProvider.id, { baseURL: e.target.value })}
                          placeholder="https://api.openai.com/v1"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => void testConnection(selectedProvider)}
                          disabled={testingId === selectedProvider.id}
                          title="Test connection to provider endpoint"
                        >
                          {testingId === selectedProvider.id ? 'Testing…' : 'Test Connection'}
                        </button>
                      </div>
                      {testMsg?.id === selectedProvider.id && (
                        <div className={`test-msg ${testMsg.ok ? 'ok' : 'fail'}`}>{testMsg.text}</div>
                      )}
                    </div>

                    <div className="settings-field-group">
                      <label className="settings-field-label">
                        API Key{' '}
                        {providerHasKey[selectedProvider.id] && (
                          <span className="hint-inline">(saved securely in OS keychain, leave empty to keep)</span>
                        )}
                      </label>
                      <input
                        type="password"
                        value={apiKeys[selectedProvider.id] ?? ''}
                        onChange={(e) =>
                          setApiKeys((prev) => ({ ...prev, [selectedProvider.id]: e.target.value }))
                        }
                        placeholder={
                          providerHasKey[selectedProvider.id]
                            ? '••••••••••••••••'
                            : 'sk-… (optional for local endpoints)'
                        }
                        spellCheck={false}
                      />
                    </div>
                  </div>

                  {/* Section 2: Models Selection */}
                  <div className="provider-detail-section provider-models-section">
                    <div className="provider-detail-section-head">
                      <div className="provider-models-title-wrap">
                        <span className="provider-detail-section-title">Model List</span>
                        <span className="provider-models-count-badge">
                          {selectedProvider.models.length} active
                        </span>
                      </div>
                      <div className="provider-models-toolbar">
                        <button
                          type="button"
                          className="btn ghost small fetch-models-btn"
                          onClick={() => void fetchModels(selectedProvider)}
                          disabled={fetchingId === selectedProvider.id}
                          title="Discover models from the provider endpoint"
                        >
                          <RefreshIcon
                            size={12}
                            className={fetchingId === selectedProvider.id ? 'spin-icon' : ''}
                          />
                          {fetchingId === selectedProvider.id ? 'Fetching…' : 'Fetch Models'}
                        </button>
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => selectAllModels(selectedProvider.id)}
                          disabled={candidateModels.length === 0}
                          title="Select all candidate models"
                        >
                          Select All
                        </button>
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => deselectAllModels(selectedProvider.id)}
                          disabled={selectedProvider.models.length === 0}
                          title="Deselect all models"
                        >
                          Deselect All
                        </button>
                      </div>
                    </div>

                    {/* Search filter if model candidates > 6 */}
                    {candidateModels.length > 6 && (
                      <div className="model-search-box">
                        <SearchIcon size={13} className="model-search-icon" />
                        <input
                          type="text"
                          placeholder="Filter models..."
                          value={modelSearchFilter}
                          onChange={(e) => setModelSearchFilter(e.target.value)}
                          className="model-search-input"
                        />
                        {modelSearchFilter && (
                          <button
                            type="button"
                            className="mini-btn model-search-clear"
                            onClick={() => setModelSearchFilter('')}
                            title="Clear filter"
                          >
                            <XIcon size={11} />
                          </button>
                        )}
                      </div>
                    )}

                    {/* Checkbox Candidate List */}
                    <div className="model-checkbox-container">
                      {filteredCandidates.length === 0 ? (
                        <div className="model-checkbox-empty">
                          {candidateModels.length === 0 ? (
                            <p>
                              No models loaded yet. Click <strong>Fetch Models</strong> above or add a model
                              manually below.
                            </p>
                          ) : (
                            <p>No models match &ldquo;{modelSearchFilter}&rdquo;</p>
                          )}
                        </div>
                      ) : (
                        filteredCandidates.map((m) => {
                          const isChecked = selectedProvider.models.includes(m)
                          const isDefault = activeModel === `${selectedProvider.id}/${m}`
                          return (
                            <label key={m} className={`model-checkbox-row ${isChecked ? 'is-checked' : ''}`}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleModel(selectedProvider.id, m)}
                              />
                              <span className="model-checkbox-label" title={m}>
                                {m}
                              </span>
                              {isDefault && <span className="model-active-badge">Default</span>}
                              <button
                                type="button"
                                className="mini-btn model-remove-btn"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  deleteModelFromCandidate(selectedProvider.id, m)
                                }}
                                title="Remove model from candidates"
                              >
                                <XIcon size={10} />
                              </button>
                            </label>
                          )
                        })
                      )}
                    </div>

                    {/* Manual Add Model */}
                    <div className="model-manual-row">
                      <input
                        value={manualModelInput}
                        onChange={(e) => setManualModelInput(e.target.value)}
                        placeholder="Add model manually (e.g. gpt-4o, claude-3-7-sonnet)..."
                        spellCheck={false}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleManualAddModel(selectedProvider.id)
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => handleManualAddModel(selectedProvider.id)}
                        disabled={!manualModelInput.trim()}
                      >
                        <PlusIcon size={12} /> Add Model
                      </button>
                    </div>
                  </div>

                  {/* Section 3: Advanced Parameters */}
                  {selectedProvider.type === 'openai-compatible' && (
                    <div className="provider-detail-section">
                      <div className="provider-detail-section-head">
                        <span className="provider-detail-section-title">Advanced Parameters</span>
                      </div>

                      <div className="settings-field-group">
                        <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                          <input
                            type="checkbox"
                            checked={selectedProvider.enableThinking ?? false}
                            onChange={(e) => updateProvider(selectedProvider.id, { enableThinking: e.target.checked ? true : undefined })}
                          />
                          <span style={{ fontSize: '13px', fontWeight: 500 }}>
                            Enable Extended Thinking (<code>enable_thinking: true</code>)
                          </span>
                        </label>
                        <p className="hint">
                          Required by Alibaba Cloud DashScope (Qwen 2.5, DeepSeek-R1, QwQ) to stream reasoning / thought tokens over OpenAI-compatible endpoints.
                        </p>
                      </div>

                      <div className="settings-field-group" style={{ marginTop: '14px' }}>
                        <label className="settings-field-label">Custom Request Body (JSON)</label>
                        <textarea
                          rows={3}
                          value={selectedProvider.customBody ?? ''}
                          onChange={(e) => updateProvider(selectedProvider.id, { customBody: e.target.value })}
                          placeholder='e.g. {"chat_template_args": {"enable_thinking": true}}'
                          spellCheck={false}
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '12.5px',
                            resize: 'vertical'
                          }}
                        />
                        <p className="hint">
                          Optional JSON object merged directly into the request body for all requests to this provider.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 2. General Tab */}
          {activeTab === 'general' && (
            <div className="settings-tab-content">
              <div className="settings-section-card">
                <div className="settings-field-group">
                  <label className="settings-field-label">Default Model</label>
                  <CustomSelect
                    value={activeModel}
                    onChange={setActiveModel}
                    fullWidth
                    placeholder={providers.every((p) => p.models.length === 0) ? 'Add models to a provider first' : 'Select default model'}
                    options={providers.flatMap((p) =>
                      p.models.map((m) => ({
                        value: `${p.id}/${m}`,
                        label: `${p.label} / ${m}`
                      }))
                    )}
                  />
                  <p className="hint">Used for primary reasoning and all agents without custom routing rules.</p>
                </div>

                <div className="settings-field-group">
                  <label className="settings-field-label">Reasoning Level</label>
                  <CustomSelect
                    value={reasoningEffort}
                    onChange={setReasoningEffort}
                    fullWidth
                    options={getReasoningOptionsForModel(activeModel).map((r) => ({
                      value: r,
                      label: r === 'default' ? 'Default' : r.charAt(0).toUpperCase() + r.slice(1).replace('-', ' ')
                    }))}
                  />
                  <p className="hint">Controls extended thinking effort for models supporting reasoning tokens.</p>
                </div>

                <div className="settings-field-group">
                  <label className="settings-field-label">Approval Mode</label>
                  <CustomSelect
                    value={approvalMode}
                    onChange={(val) => setApprovalMode(val as typeof approvalMode)}
                    fullWidth
                    options={[
                      { value: 'balanced', label: 'Balanced — high-impact actions require approval' },
                      { value: 'strict', label: 'Strict — approve all changes' },
                      { value: 'allow-all', label: 'Allow all — auto-approve everything' }
                    ]}
                  />
                  <p className="hint">Determines when AnyBuff requires confirmation before modifying files or running commands.</p>
                </div>
              </div>
            </div>
          )}

          {/* 3. Theme Tab */}
          {activeTab === 'theme' && (
            <div className="settings-tab-content">
              <div className="settings-field-group settings-theme-group">
                <div className="settings-theme-info">
                  <label className="settings-field-label">Appearance Mode</label>
                  <p className="hint">Switch between Dark and Light interface themes.</p>
                </div>
                <button className="btn ghost small" onClick={onToggleTheme}>
                  {theme === 'dark' ? <SunIcon size={14} /> : <MoonIcon size={14} />}
                  {theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                </button>
              </div>

              <div className="settings-field-group">
                <label className="settings-field-label">Color Scheme</label>
                <p className="hint">
                  Choose a color palette. Backgrounds and interface accents will adapt dynamically.
                </p>
                <div className="color-theme-grid">
                  {COLOR_THEMES.map((ct) => (
                    <button
                      key={ct.id}
                      type="button"
                      className={`color-theme-card ${colorTheme === ct.id ? 'active' : ''}`}
                      onClick={() => onSelectColorTheme(ct.id)}
                    >
                      <div className="color-theme-header">
                        <span
                          className="color-theme-swatch"
                          style={{ backgroundColor: ct.previewColor }}
                        />
                        <span className="color-theme-name">{ct.label}</span>
                      </div>
                      <span className="color-theme-desc">{ct.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 4. Agent Routing Tab */}
          {activeTab === 'routing' && (
            <div className="settings-tab-content">
              <div className="settings-section-head">
                <span>Configured Agent Routes</span>
              </div>
              <p className="hint">
                Route specific agents to different models (e.g. a cheap/fast model for <code>file-picker</code>, a powerful one for <code>editor</code>). Agents without a route use the global default model.
              </p>

              {Object.keys(agentRouting).length === 0 ? (
                <div className="settings-empty-card">
                  <p>No per-agent routes configured. All agents use the default model.</p>
                </div>
              ) : (
                <div className="route-list">
                  {Object.entries(agentRouting).map(([agentId, route]) => (
                    <div key={agentId} className="route-row">
                      <span className="route-agent" title={agentId}>
                        {agentId}
                      </span>
                      <CustomSelect
                        value={route.model}
                        onChange={(val) =>
                          setAgentRouting((prev) => ({
                            ...prev,
                            [agentId]: { ...prev[agentId], model: val }
                          }))
                        }
                        size="small"
                        placeholder={providers.every((p) => p.models.length === 0) ? 'Add models to a provider first' : 'Select model'}
                        options={providers.flatMap((p) =>
                          p.models.map((m) => ({
                            value: `${p.id}/${m}`,
                            label: `${p.label} / ${m}`
                          }))
                        )}
                        title="Model for this agent"
                        className="flex-1"
                      />
                      <CustomSelect
                        value={route.reasoningEffort}
                        onChange={(val) =>
                          setAgentRouting((prev) => ({
                            ...prev,
                            [agentId]: { ...prev[agentId], reasoningEffort: val }
                          }))
                        }
                        size="small"
                        options={getReasoningOptionsForModel(route.model).map((r) => ({
                          value: r,
                          label: r === 'default' ? 'Default' : r.charAt(0).toUpperCase() + r.slice(1).replace('-', ' ')
                        }))}
                        title="Reasoning effort for this agent"
                        className="flex-1"
                      />
                      <button
                        className="mini-btn danger"
                        onClick={() => {
                          setAgentRouting((prev) => {
                            const next = { ...prev }
                            delete next[agentId]
                            return next
                          })
                        }}
                        title="Remove routing"
                      >
                        <XIcon size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="settings-section-head" style={{ marginTop: '16px' }}>
                <span>Add Route Rule</span>
              </div>
              <div className="route-add-row">
                <CustomSelect
                  value={routeDraftAgent}
                  onChange={setRouteDraftAgent}
                  size="small"
                  placeholder={allAgentIds.length === 0 ? 'No agents available' : 'Select agent…'}
                  options={allAgentIds
                    .filter((id) => !(id in agentRouting))
                    .map((id) => ({
                      value: id,
                      label: id
                    }))}
                  title="Agent to route"
                  className="flex-1"
                />
                <CustomSelect
                  value={routeDraftModel}
                  onChange={setRouteDraftModel}
                  disabled={!routeDraftAgent}
                  size="small"
                  placeholder="Model…"
                  options={providers.flatMap((p) =>
                    p.models.map((m) => ({
                      value: `${p.id}/${m}`,
                      label: `${p.label} / ${m}`
                    }))
                  )}
                  title="Model for this agent"
                  className="flex-1"
                />
                <button
                  className="btn ghost small"
                  disabled={!routeDraftAgent || !routeDraftModel}
                  onClick={() => {
                    setAgentRouting((prev) => ({
                      ...prev,
                      [routeDraftAgent]: { model: routeDraftModel, reasoningEffort: 'default' }
                    }))
                    setRouteDraftAgent('')
                    setRouteDraftModel('')
                  }}
                >
                  <PlusIcon size={12} /> Add Route
                </button>
              </div>
            </div>
          )}

          {/* 5. Custom Agents Tab */}
          {activeTab === 'agents' && (
            <div className="settings-tab-content">
              <div className="settings-section-head">
                <span>Project & Home Agents</span>
                <div className="settings-section-actions">
                  <button
                    className="btn ghost small"
                    onClick={handleCreateAgentClick}
                    title={activeCwd ? 'Create a custom agent' : 'Requires an open project folder'}
                  >
                    <PlusIcon size={12} /> Create Agent
                  </button>
                  <button
                    className="btn ghost small"
                    onClick={() => void refreshLocalAgents()}
                    disabled={loadingAgents || !activeCwd}
                    title="Reload agents from .agents directories"
                  >
                    <RefreshIcon size={12} className={loadingAgents ? 'spin-icon' : ''} />
                    {loadingAgents ? 'Loading…' : 'Reload'}
                  </button>
                </div>
              </div>
              <p className="hint">
                Custom agents are loaded from <code>.agents/</code> in your project or home directory. Files can be <code>.ts</code>, <code>.js</code>, <code>.mjs</code> or <code>.cjs</code> and are merged over the bundled agents.
              </p>

              {!activeCwd && (
                <div className="test-msg fail" style={{ marginBottom: '8px' }}>
                  No project folder opened. Open a project folder first to create custom agents.
                </div>
              )}

              {agentActionNotice && (
                <div className="test-msg success" style={{ marginBottom: '8px' }}>
                  {agentActionNotice}
                </div>
              )}

              {agentEditError && !editingAgent && (
                <div className="test-msg fail" style={{ marginBottom: '8px' }}>
                  {agentEditError}
                </div>
              )}

              {localAgents.length === 0 && !loadingAgents ? (
                <div className="settings-empty-card">
                  <p>
                    {activeCwd
                      ? 'No custom agents found in .agents/.'
                      : 'No project folder opened. Open a project folder to create or manage custom agents.'}
                  </p>
                  <button className="btn accent small" onClick={handleCreateAgentClick}>
                    <PlusIcon size={12} /> Create Custom Agent
                  </button>
                </div>
              ) : (
                <div className="local-agent-list">
                  {localAgents.map((a) => (
                    <div key={a.id} className="local-agent-card">
                      <div className="local-agent-card-header">
                        <div className="local-agent-title-box">
                          <div className="local-agent-icon-mark">
                            <SpecialistIcon size={16} />
                          </div>
                          <div>
                            <div className="local-agent-name-row">
                              <strong className="local-agent-name">{a.displayName}</strong>
                              <span className="route-agent">{a.id}</span>
                              <span className={`local-agent-scope-badge ${a.scope === 'home' ? 'global' : a.scope === 'parent' ? 'parent' : 'project'}`}>
                                {a.scope === 'home' ? 'Global' : a.scope === 'parent' ? 'Parent' : 'Project'}
                              </span>
                            </div>
                            {a.spawnerPrompt && <p className="local-agent-desc">{a.spawnerPrompt}</p>}
                          </div>
                        </div>
                        <div className="local-agent-card-actions">
                          <button
                            type="button"
                            className="btn ghost small"
                            onClick={() => void handleStartEditAgent(a)}
                            title="Edit agent code definition"
                          >
                            <EditIcon size={12} />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            className="btn ghost danger-hover small"
                            onClick={() => setDeletingAgent({ id: a.id, displayName: a.displayName, filePath: a.filePath || a.source || '' })}
                            title="Delete agent file"
                          >
                            <TrashIcon size={12} />
                            <span>Delete</span>
                          </button>
                        </div>
                      </div>
                      {a.filePath && (
                        <div className="local-agent-card-footer">
                          <span className="local-agent-path-label">File:</span>
                          <code className="local-agent-filepath">{a.filePath}</code>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {localAgentErrors.length > 0 && (
                <div className="local-agent-errors">
                  {localAgentErrors.map((e, i) => (
                    <div key={i} className="test-msg fail">
                      <strong>{e.agentId || 'Agent'}:</strong> {e.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 6. Web Search Tab */}
          {activeTab === 'search' && (
            <div className="settings-tab-content">
              <div className="settings-section-card">
                <div className="settings-section-head">
                  <span>Search Provider</span>
                </div>
                <p className="hint">
                  Pick which backend the <code>web_search</code> tool uses for the agent. Deep research
                  workloads can trip DuckDuckGo rate limits — Firecrawl and Tinyfish are alternatives.
                </p>

                <div className="websearch-provider-list">
                  {[
                    {
                      id: 'duckduckgo' as WebSearchProviderId,
                      label: 'DuckDuckGo',
                      description: 'No API key needed. Free but rate-limited under heavy usage.',
                      requiresKey: false
                    },
                    {
                      id: 'firecrawl' as WebSearchProviderId,
                      label: 'Firecrawl (Keyless)',
                      description: 'Free per-IP daily credits with no key. Add a key for higher limits.',
                      requiresKey: false
                    },
                    {
                      id: 'tinyfish' as WebSearchProviderId,
                      label: 'Tinyfish',
                      description: 'Free tier: 30 req/min, 500 req/hour. Requires an API key.',
                      requiresKey: true
                    }
                  ].map((p) => {
                    const isActive = webSearchProvider === p.id
                    const hasKey = Boolean(webSearchHasKey[p.id] || searchApiKeys[p.id])
                    return (
                      <div
                        key={p.id}
                        className={`websearch-provider-card ${isActive ? 'active' : ''}`}
                        onClick={() => setWebSearchProvider(p.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setWebSearchProvider(p.id)
                          }
                        }}
                      >
                        <div className="websearch-provider-head">
                          <span className="websearch-provider-name">{p.label}</span>
                          {p.requiresKey ? (
                            <span className={`provider-list-key-tag ${hasKey ? 'saved' : 'missing'}`}>
                              {hasKey ? 'Key Set' : 'Key Required'}
                            </span>
                          ) : (
                            <span className="provider-list-key-tag local">No Key Needed</span>
                          )}
                        </div>
                        <div className="websearch-provider-desc">{p.description}</div>
                        {isActive && (
                          <div className="websearch-provider-active">
                            <CheckCircleIcon size={12} /> Active provider
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              {(webSearchProvider === 'tinyfish' || webSearchProvider === 'firecrawl') && (
                <div className="settings-section-card" style={{ marginTop: '14px' }}>
                  <div className="settings-section-head">
                    <span>
                      {webSearchProvider === 'tinyfish' ? 'Tinyfish API Key' : 'Firecrawl API Key (Optional)'}
                    </span>
                  </div>
                  {webSearchProvider === 'tinyfish' ? (
                    <p className="hint">
                      Get a free key at{' '}
                      <a
                        href="https://agent.tinyfish.ai/api-keys"
                        target="_blank"
                        rel="noreferrer"
                        className="about-link"
                      >
                        agent.tinyfish.ai/api-keys
                      </a>
                      . Stored encrypted in your OS keychain (DPAPI).
                    </p>
                  ) : (
                    <p className="hint">
                      Optional. Keyless mode works but shares Firecrawl's free per-IP daily credits. Add a key
                      for higher rate limits. Stored encrypted in your OS keychain (DPAPI).
                    </p>
                  )}
                  <div className="settings-field-group">
                    <div className="url-row">
                      <input
                        type="password"
                        value={searchApiKeys[webSearchProvider] ?? ''}
                        onChange={(e) =>
                          setSearchApiKeys((prev) => ({ ...prev, [webSearchProvider]: e.target.value }))
                        }
                        placeholder={
                          webSearchHasKey[webSearchProvider]
                            ? '•••••••••••••••• (leave empty to keep)'
                            : webSearchProvider === 'tinyfish'
                              ? 'Enter Tinyfish API key…'
                              : 'Optional Firecrawl API key…'
                        }
                        spellCheck={false}
                      />
                      {webSearchHasKey[webSearchProvider] && (
                        <button
                          type="button"
                          className="btn ghost danger-hover small"
                          onClick={() => {
                            setDeleteSearchKeys((prev) =>
                              prev.includes(webSearchProvider)
                                ? prev
                                : [...prev, webSearchProvider]
                            )
                            setSearchApiKeys((prev) => ({ ...prev, [webSearchProvider]: '' }))
                          }}
                          title="Remove the stored key"
                        >
                          <TrashIcon size={12} />
                          <span>Remove</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 7. MCP Tools Tab */}
          {activeTab === 'mcp' && (
            <div className="settings-tab-content">
              <div className="settings-section-head">
                <span>Installed MCP Servers</span>
                <div className="settings-section-actions">
                  <button
                    className="btn ghost small"
                    onClick={() => void refreshMcpServers()}
                    disabled={loadingMcp}
                    title="Reload servers from app settings and .agents/mcp.json"
                  >
                    <RefreshIcon size={12} className={loadingMcp ? 'spin-icon' : ''} />
                    {loadingMcp ? 'Loading…' : 'Reload'}
                  </button>
                  <button
                    className="btn ghost small"
                    onClick={() => setShowMcpPresetPicker(true)}
                    title="Add a server from a template"
                  >
                    <LayersIcon size={12} /> Add from Preset
                  </button>
                  <button
                    className="btn ghost small"
                    onClick={() => openMcpJsonModal()}
                    title="Paste or edit raw mcp.json JSON"
                  >
                    <BoltIcon size={12} /> Import JSON
                  </button>
                  <button
                    className="btn accent small"
                    onClick={() => openMcpForm()}
                    title="Add a custom MCP server"
                  >
                    <PlusIcon size={12} /> Add Server
                  </button>
                </div>
              </div>
              <p className="hint">
                Servers here are connected automatically when a run starts. Servers discovered in{' '}
                <code>.agents/mcp.json</code> (project or home) appear read-only — toggle their enabled
                state and target agents from here.
              </p>

              {mcpNotice && (
                <div className={`test-msg ${mcpNotice.ok ? 'success' : 'fail'}`} style={{ marginBottom: '8px' }}>
                  {mcpNotice.text}
                </div>
              )}

              {loadingMcp && mcpServers.length === 0 ? (
                <div className="settings-empty-card">
                  <p>Loading MCP servers…</p>
                </div>
              ) : mcpServers.length === 0 ? (
                <div className="settings-empty-card">
                  <p>No MCP servers installed yet.</p>
                  <div className="settings-empty-actions">
                    <button type="button" className="btn ghost small" onClick={() => setShowMcpPresetPicker(true)}>
                      <LayersIcon size={12} /> Add from Preset
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => openMcpJsonModal()}>
                      <BoltIcon size={12} /> Import JSON
                    </button>
                    <button type="button" className="btn accent small" onClick={() => openMcpForm()}>
                      <PlusIcon size={12} /> Add Server
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mcp-server-list">
                  {mcpServers.map((server) => {
                    const isApp = server.source === 'app'
                    const typeLabel = server.type.toUpperCase()
                    return (
                      <div key={server.id} className={`mcp-server-card ${server.enabled ? '' : 'disabled'}`}>
                        <div className="mcp-server-card-main">
                          <label className="mcp-server-toggle">
                            <input
                              type="checkbox"
                              checked={server.enabled}
                              onChange={(e) => void handleToggleMcpEnabled(server, e.target.checked)}
                              title={server.enabled ? 'Disable this server' : 'Enable this server'}
                            />
                            <span className="mcp-toggle-track" />
                          </label>
                          <div className="mcp-server-icon">
                            <ServerIcon size={17} />
                          </div>
                          <div className="mcp-server-info">
                            <div className="mcp-server-name-row">
                              <strong className="mcp-server-name">{server.name}</strong>
                              <span className={`mcp-type-badge ${server.type}`}>{typeLabel}</span>
                              {!isApp && <span className="mcp-source-badge">mcp.json</span>}
                              {server.hasSecrets && <span className="mcp-secrets-badge">🔒 keys stored</span>}
                            </div>
                            <div className="mcp-server-detail" title={server.type === 'stdio' ? server.command : server.url}>
                              {server.type === 'stdio'
                                ? `${server.command}${server.args && server.args.length > 0 ? ' ' + server.args.join(' ') : ''}`
                                : server.url}
                            </div>
                            {!isApp && server.filePath && (
                              <div className="mcp-server-filepath">
                                <code>{server.filePath}</code>
                              </div>
                            )}
                            <div className="mcp-agent-row">
                              <span className="mcp-agent-label">Agents:</span>
                              {mcpAgentOptions
                                .filter((id) => server.targetAgents.includes(id))
                                .map((id) => (
                                  <span key={id} className="mcp-agent-chip">{id}</span>
                                ))}
                              {server.targetAgents.filter((a) => !mcpAgentOptions.includes(a)).map((id) => (
                                <span key={id} className="mcp-agent-chip custom">{id}</span>
                              ))}
                            </div>
                          </div>
                          <div className="mcp-server-card-actions">
                            {isApp ? (
                              <>
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  onClick={() => openMcpForm(server)}
                                  title="Edit this server"
                                >
                                  <EditIcon size={12} /> Edit
                                </button>
                                <button
                                  type="button"
                                  className="btn ghost danger-hover small"
                                  onClick={() => setDeleteMcpConfirm(server)}
                                  title="Delete this server"
                                >
                                  <TrashIcon size={12} /> Delete
                                </button>
                              </>
                            ) : (
                              <span className="mcp-readonly-note" title="Defined in .agents/mcp.json — edit the file to change it">
                                Read-only
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* 8. About Tab */}
          {activeTab === 'about' && (
            <div className="settings-tab-content">
              <div className="settings-section-card about-card">
                <div className="about-hero">
                  <AppIcon size={64} className="about-logo" />
                  <div className="about-name">Anybuff</div>
                  {appVersion && <span className="about-version-badge">v{appVersion}</span>}
                  <p className="hint">Use any model with a team of specialized sub-agents.</p>
                </div>

                <div className="about-row">
                  <span className="settings-field-label">GitHub</span>
                  <a
                    className="about-link"
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noreferrer"
                    title="Open the Anybuff repository on GitHub"
                  >
                    <GitHubIcon size={13} />
                    <span>JasonMMIV/Anybuff</span>
                  </a>
                </div>

                <div className="about-row about-update-row">
                  <div className="about-update-info">
                    <span className="settings-field-label">Updates</span>
                    {updater.status === 'up-to-date' && (
                      <span className="about-status up-to-date">
                        <CheckCircleIcon size={13} /> You&rsquo;re up to date
                      </span>
                    )}
                    {updater.status === 'error' && <span className="about-status fail">{updater.message}</span>}
                    {(updater.status === 'idle' || updater.status === 'checking') && (
                      <span className="hint-inline">
                        {updater.status === 'checking' ? 'Checking…' : 'Background checks run every 4 hours.'}
                      </span>
                    )}
                    {updater.status === 'available' && (
                      <span className="hint-inline">
                        v{updater.version} available — downloading in background…
                      </span>
                    )}
                    {updater.status === 'downloading' && (
                      <span className="hint-inline">
                        Downloading v{updater.version}… {Math.round(updater.percent)}%
                      </span>
                    )}
                    {updater.status === 'downloaded' && (
                      <span className="about-status up-to-date">
                        <CheckCircleIcon size={13} /> v{updater.version || 'New version'} ready to install
                      </span>
                    )}
                  </div>
                  {updater.status === 'downloaded' ? (
                    <button
                      type="button"
                      className="btn primary small"
                      onClick={() => void handleInstallUpdate()}
                      title="Quit AnyBuff and install the downloaded update"
                    >
                      Restart &amp; Install
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => void handleCheckForUpdates()}
                      disabled={updater.status === 'checking'}
                      title="Check GitHub for a newer release"
                    >
                      <RefreshIcon size={12} className={updater.status === 'checking' ? 'spin-icon' : ''} />
                      {updater.status === 'checking' ? 'Checking…' : 'Check Update'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Edit Custom Agent Modal */}
      {editingAgent && (
        <div className="modal-backdrop agent-editor-backdrop" onClick={() => !savingAgentCode && setEditingAgent(null)}>
          <div className="modal agent-editor-modal" onClick={(e) => e.stopPropagation()}>
            <div className="agent-editor-header">
              <div className="agent-editor-header-info">
                <div className="agent-editor-header-title">
                  <SpecialistIcon size={18} />
                  <span>Edit Custom Agent</span>
                  <span className="route-agent">{editingAgent.id}</span>
                </div>
                <code className="agent-editor-filepath">{editingAgent.filePath}</code>
              </div>
              <button
                type="button"
                className="mini-btn"
                onClick={() => !savingAgentCode && setEditingAgent(null)}
                title="Close"
              >
                <XIcon size={15} />
              </button>
            </div>

            <div className="agent-editor-body">
              {agentEditError && <div className="test-msg fail">{agentEditError}</div>}
              <div className="agent-editor-code-container">
                <textarea
                  className="agent-editor-textarea"
                  value={editingAgent.content}
                  onChange={(e) => setEditingAgent({ ...editingAgent, content: e.target.value })}
                  placeholder="// TypeScript Agent Definition"
                  spellCheck={false}
                  autoFocus
                />
              </div>
            </div>

            <div className="agent-editor-footer">
              <span className="hint">Changes take effect immediately upon saving and reloading.</span>
              <div className="agent-editor-footer-actions">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setEditingAgent(null)}
                  disabled={savingAgentCode}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void handleSaveAgentCode()}
                  disabled={savingAgentCode}
                >
                  {savingAgentCode ? 'Saving…' : 'Save Agent'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Agent Confirmation Modal */}
      {deletingAgent && (
        <div className="modal-backdrop" onClick={() => !deletingInProgress && setDeletingAgent(null)}>
          <div className="modal agent-delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="agent-delete-header">
              <div className="agent-delete-title">
                <TrashIcon size={18} />
                <span>Delete Custom Agent</span>
              </div>
              <button
                type="button"
                className="mini-btn"
                onClick={() => !deletingInProgress && setDeletingAgent(null)}
                title="Cancel"
              >
                <XIcon size={14} />
              </button>
            </div>
            <div className="agent-delete-body">
              <p>Are you sure you want to delete <strong>{deletingAgent.displayName}</strong> (<code>{deletingAgent.id}</code>)?</p>
              <p className="hint">This will permanently delete the agent definition file from your disk:</p>
              <code className="agent-delete-path">{deletingAgent.filePath}</code>
            </div>
            <div className="agent-delete-footer">
              <button
                type="button"
                className="btn ghost"
                onClick={() => setDeletingAgent(null)}
                disabled={deletingInProgress}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => void handleConfirmDeleteAgent()}
                disabled={deletingInProgress}
              >
                {deletingInProgress ? 'Deleting…' : 'Delete Agent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preset Picker Modal */}
      {showPresetPicker && (
        <div className="modal-backdrop preset-modal-backdrop" onClick={() => setShowPresetPicker(false)}>
          <div className="preset-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="preset-modal-header">
              <div className="preset-modal-title">
                <LayersIcon size={16} />
                <span>Choose Provider Preset</span>
              </div>
              <button
                type="button"
                className="mini-btn"
                onClick={() => setShowPresetPicker(false)}
                title="Close"
              >
                <XIcon size={14} />
              </button>
            </div>
            <p className="preset-modal-hint">
              Select a provider template to instantly preconfigure the Base URL, API type, and environment settings.
            </p>
            <div className="preset-grid">
              {PROVIDER_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="preset-card"
                  onClick={() => applyPreset(preset)}
                >
                  <div className="preset-card-head">
                    <span className="preset-card-label">{preset.label}</span>
                    <span className="preset-card-type">
                      {preset.type === 'anthropic-compatible' ? 'Anthropic' : 'OpenAI'}
                    </span>
                  </div>
                  <div className="preset-card-url" title={preset.baseURL}>
                    {preset.baseURL}
                  </div>
                  {preset.description && <div className="preset-card-desc">{preset.description}</div>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MCP Server Add/Edit Modal */}
      {showMcpForm && mcpDraft && (
        <div className="modal-backdrop mcp-modal-backdrop" onClick={() => !mcpSaving && setShowMcpForm(false)}>
          <div className="modal mcp-form-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mcp-form-header">
              <div className="mcp-form-title">
                <PlugIcon size={17} />
                <span>{editingMcp ? 'Edit MCP Server' : 'Add MCP Server'}</span>
                {editingMcp && <span className="route-agent">{editingMcp.name}</span>}
              </div>
              <div className="mcp-form-mode-toggle">
                <button
                  type="button"
                  className={`mcp-mode-btn ${mcpEditMode === 'form' ? 'active' : ''}`}
                  onClick={() => {
                    setMcpFormError(null)
                    // If the user edited JSON, re-parse it back into the form fields
                    if (mcpEditMode === 'json') {
                      try {
                        const parsed = parseMcpJsonToDraft(mcpJsonDraftText, mcpDraft.name)
                        setMcpDraft({
                          ...parsed,
                          id: mcpDraft.id,
                          enabled: mcpDraft.enabled,
                          targetAgents: mcpDraft.targetAgents
                        })
                      } catch (err) {
                        setMcpFormError(err instanceof Error ? err.message : String(err))
                        return // stay in JSON mode so the user can fix it
                      }
                    }
                    setMcpEditMode('form')
                  }}
                  title="Edit with fields"
                >
                  Form
                </button>
                <button
                  type="button"
                  className={`mcp-mode-btn ${mcpEditMode === 'json' ? 'active' : ''}`}
                  onClick={() => {
                    setMcpFormError(null)
                    // Keep the raw JSON editor in sync with the form fields
                    setMcpJsonDraftText(JSON.stringify(draftToMcpJson(mcpDraft), null, 2))
                    setMcpEditMode('json')
                  }}
                  title="Edit as raw mcp.json JSON"
                >
                  JSON
                </button>
              </div>
              <button
                type="button"
                className="mini-btn"
                onClick={() => setShowMcpForm(false)}
                title="Close"
              >
                <XIcon size={15} />
              </button>
            </div>

            <div className="mcp-form-body">
              {mcpFormError && <div className="test-msg fail">{mcpFormError}</div>}

              {mcpEditMode === 'json' ? (
                <div className="settings-field-group">
                  <label className="settings-field-label">Raw mcp.json (JSON)</label>
                  <p className="hint">
                    Paste or edit the server definition in mcp.json syntax — the same format Claude
                    Code / Cursor use. The first server in the object is used.
                  </p>
                  <textarea
                    className="mcp-json-textarea"
                    value={mcpJsonDraftText}
                    onChange={(e) => setMcpJsonDraftText(e.target.value)}
                    spellCheck={false}
                    placeholder={'{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "@upstash/context7-mcp"]\n  }\n}'}
                  />
                </div>
              ) : (
                <>

              <div className="settings-field-group">
                <label className="settings-field-label">Server Name</label>
                <input
                  value={mcpDraft.name}
                  onChange={(e) => updateMcpDraft({ name: e.target.value })}
                  placeholder="e.g. context7, github"
                  spellCheck={false}
                />
              </div>

              <div className="settings-field-group">
                <label className="settings-field-label">Transport</label>
                <CustomSelect
                  value={mcpDraft.type}
                  onChange={(val) => updateMcpDraft({ type: val as McpServerType })}
                  fullWidth
                  options={[
                    { value: 'stdio', label: 'stdio — local command (npx / uvx / node)' },
                    { value: 'http', label: 'HTTP — remote URL' },
                    { value: 'sse', label: 'SSE — remote URL' }
                  ]}
                />
              </div>

              {mcpDraft.type === 'stdio' ? (
                <>
                  <div className="settings-field-group">
                    <label className="settings-field-label">Command</label>
                    <input
                      value={mcpDraft.command ?? ''}
                      onChange={(e) => updateMcpDraft({ command: e.target.value })}
                      placeholder="npx / uvx / node"
                      spellCheck={false}
                    />
                  </div>
                  <div className="settings-field-group">
                    <label className="settings-field-label">Arguments</label>
                    <input
                      value={(mcpDraft.args ?? []).join(' ')}
                      onChange={(e) =>
                        updateMcpDraft({
                          args: e.target.value.split(/\s+/).filter(Boolean)
                        })
                      }
                      placeholder="-y @upstash/context7-mcp"
                      spellCheck={false}
                    />
                  </div>
                </>
              ) : (
                <div className="settings-field-group">
                  <label className="settings-field-label">URL</label>
                  <input
                    value={mcpDraft.url ?? ''}
                    onChange={(e) => updateMcpDraft({ url: e.target.value })}
                    placeholder="https://mcp.example.com/mcp"
                    spellCheck={false}
                  />
                </div>
              )}

              {/* env / headers / params rows */}
              {mcpDraft.type === 'stdio' && (
                <McpKvEditor
                  label="Environment Variables"
                  hint="Use $VAR_NAME to reference an environment variable; any other value is stored encrypted (DPAPI)."
                  values={mcpDraft.env ?? {}}
                  onAdd={addMcpEnvRow}
                  onRename={(oldK, newK) => renameMcpRow('env', oldK, newK)}
                  onValue={(k, v) => updateMcpDraft({ env: { ...(mcpDraft.env ?? {}), [k]: v } })}
                  onRemove={(k) => removeMcpRow('env', k)}
                />
              )}
              {mcpDraft.type !== 'stdio' && (
                <McpKvEditor
                  label="Headers"
                  hint="HTTP headers, e.g. Authorization. Use $VAR_NAME for env refs; other values are stored encrypted."
                  values={mcpDraft.headers ?? {}}
                  onAdd={addMcpHeaderRow}
                  onRename={(oldK, newK) => renameMcpRow('headers', oldK, newK)}
                  onValue={(k, v) => updateMcpDraft({ headers: { ...(mcpDraft.headers ?? {}), [k]: v } })}
                  onRemove={(k) => removeMcpRow('headers', k)}
                />
              )}
              {mcpDraft.type !== 'stdio' && (
                <McpKvEditor
                  label="Query Params"
                  hint="Optional URL query parameters."
                  values={mcpDraft.params ?? {}}
                  onAdd={addMcpParamRow}
                  onRename={(oldK, newK) => renameMcpRow('params', oldK, newK)}
                  onValue={(k, v) => updateMcpDraft({ params: { ...(mcpDraft.params ?? {}), [k]: v } })}
                  onRemove={(k) => removeMcpRow('params', k)}
                />
              )}
                </>
              )}

              <div className="settings-field-group">
                <label className="settings-field-label">Expose to Agents</label>
                <p className="hint">
                  The server's tools become available to the selected agents (as{' '}
                  <code>{'<server>__<tool>'}</code>).
                </p>
                <div className="mcp-agent-picker">
                  {mcpAgentOptions.map((id) => (
                    <label
                      key={id}
                      className={`mcp-agent-option ${mcpDraft.targetAgents.includes(id) ? 'selected' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={mcpDraft.targetAgents.includes(id)}
                        onChange={() =>
                          updateMcpDraft({
                            targetAgents: mcpDraft.targetAgents.includes(id)
                              ? mcpDraft.targetAgents.filter((a) => a !== id)
                              : [...mcpDraft.targetAgents, id]
                          })
                        }
                      />
                      <span>{id}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="mcp-form-footer">
              {mcpTestResult && (
                <span className={`mcp-test-result ${mcpTestResult.ok ? 'ok' : 'fail'}`}>
                  {mcpTestResult.text}
                </span>
              )}
              <button
                type="button"
                className="btn ghost"
                onClick={() => void handleTestMcp()}
                disabled={mcpTesting}
                title="Try connecting to this server and list its tools"
              >
                <BoltIcon size={13} />
                {mcpTesting ? 'Testing…' : 'Test'}
              </button>
              <button type="button" className="btn ghost" onClick={() => setShowMcpForm(false)} disabled={mcpSaving}>
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={() => void handleSaveMcp()} disabled={mcpSaving}>
                {mcpSaving ? 'Saving…' : editingMcp ? 'Save Changes' : 'Add Server'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MCP Preset Picker Modal */}
      {showMcpPresetPicker && (
        <div className="modal-backdrop preset-modal-backdrop" onClick={() => setShowMcpPresetPicker(false)}>
          <div className="preset-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="preset-modal-header">
              <div className="preset-modal-title">
                <LayersIcon size={16} />
                <span>Add MCP Server from Template</span>
              </div>
              <button
                type="button"
                className="mini-btn"
                onClick={() => setShowMcpPresetPicker(false)}
                title="Close"
              >
                <XIcon size={14} />
              </button>
            </div>
            <p className="preset-modal-hint">
              Pick a template to prefill the server config, then adjust before saving.
            </p>
            <div className="preset-grid">
              {MCP_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="preset-card"
                  onClick={() => openMcpForm(null, preset)}
                >
                  <div className="preset-card-head">
                    <span className="preset-card-label">{preset.label}</span>
                    <span className="preset-card-type">{preset.type.toUpperCase()}</span>
                  </div>
                  {preset.type === 'stdio' ? (
                    <div className="preset-card-url" title={`${preset.command} ${(preset.args ?? []).join(' ')}`}>
                      {preset.command} {(preset.args ?? []).join(' ')}
                    </div>
                  ) : (
                    <div className="preset-card-url" title={preset.url}>
                      {preset.url}
                    </div>
                  )}
                  {preset.description && <div className="preset-card-desc">{preset.description}</div>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MCP JSON Import Modal */}
      {showMcpJsonModal && (
        <div className="modal-backdrop mcp-modal-backdrop" onClick={() => setShowMcpJsonModal(false)}>
          <div className="modal mcp-json-import-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mcp-form-header">
              <div className="mcp-form-title">
                <BoltIcon size={17} />
                <span>Import MCP Server from JSON</span>
              </div>
              <button
                type="button"
                className="mini-btn"
                onClick={() => setShowMcpJsonModal(false)}
                title="Close"
              >
                <XIcon size={15} />
              </button>
            </div>
            <div className="mcp-form-body">
              {mcpFormError && <div className="test-msg fail">{mcpFormError}</div>}
              <p className="hint">
                Paste mcp.json syntax — a single server, a named server object, or a full{' '}
                <code>mcpServers</code> map. The first server found opens the edit form.
              </p>
              <textarea
                className="mcp-json-textarea"
                value={mcpJsonText}
                onChange={(e) => setMcpJsonText(e.target.value)}
                spellCheck={false}
                placeholder={'{\n  "context7": {\n    "command": "npx",\n    "args": ["-y", "@upstash/context7-mcp"]\n  }\n}'}
                autoFocus
              />
            </div>
            <div className="mcp-form-footer">
              <button type="button" className="btn ghost" onClick={() => setShowMcpJsonModal(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void handleImportMcpJson()}
                disabled={!mcpJsonText.trim()}
              >
                <BoltIcon size={13} /> Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete MCP Server Confirmation Modal */}
      {deleteMcpConfirm && (
        <div className="modal-backdrop" onClick={() => !mcpDeleteInProgress && setDeleteMcpConfirm(null)}>
          <div className="modal agent-delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="agent-delete-header">
              <div className="agent-delete-title">
                <TrashIcon size={18} />
                <span>Delete MCP Server</span>
              </div>
              <button
                type="button"
                className="mini-btn"
                onClick={() => !mcpDeleteInProgress && setDeleteMcpConfirm(null)}
                title="Cancel"
              >
                <XIcon size={14} />
              </button>
            </div>
            <div className="agent-delete-body">
              <p>
                Are you sure you want to remove <strong>{deleteMcpConfirm.name}</strong>?
              </p>
              {deleteMcpConfirm.hasSecrets && (
                <p className="hint">Stored API keys for this server will also be deleted.</p>
              )}
            </div>
            <div className="agent-delete-footer">
              <button
                type="button"
                className="btn ghost"
                onClick={() => setDeleteMcpConfirm(null)}
                disabled={mcpDeleteInProgress}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => void handleDeleteMcp()}
                disabled={mcpDeleteInProgress}
              >
                {mcpDeleteInProgress ? 'Deleting…' : 'Delete Server'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Update Available Modal */}
      {pendingUpdate && (
        <div className="modal-backdrop" onClick={() => setPendingUpdate(null)}>
          <div className="modal update-modal" onClick={(e) => e.stopPropagation()}>
            <div className="update-modal-header">
              <SparklesIcon size={18} />
              <span>Update Available</span>
            </div>
            <div className="update-modal-body">
              <p>
                A new version <strong>v{pendingUpdate.latestVersion}</strong> is available
                {appVersion && (
                  <>
                    {' '}(current: <code>v{appVersion}</code>)
                  </>
                )}
                .
              </p>
              <p className="hint">
                Update now opens the GitHub release page in your browser, where you can download the
                latest installer.
              </p>
            </div>
            <div className="update-modal-footer">
              <button type="button" className="btn ghost" onClick={() => setPendingUpdate(null)}>
                Later
              </button>
              <a
                className="btn primary"
                href={pendingUpdate.url}
                target="_blank"
                rel="noreferrer"
                onClick={() => setPendingUpdate(null)}
              >
                <GitHubIcon size={13} /> Update now
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Key/value row editor for MCP env/headers/params (add, rename, remove). */
function McpKvEditor({
  label,
  hint,
  values,
  onAdd,
  onRename,
  onValue,
  onRemove
}: {
  label: string
  hint: string
  values: Record<string, string>
  onAdd: () => void
  onRename: (oldKey: string, newKey: string) => void
  onValue: (key: string, value: string) => void
  onRemove: (key: string) => void
}) {
  const entries = Object.entries(values)
  return (
    <div className="settings-field-group mcp-kv-editor">
      <div className="mcp-kv-head">
        <label className="settings-field-label">{label}</label>
        <button type="button" className="mini-btn" onClick={onAdd} title={`Add ${label.toLowerCase()} row`}>
          <PlusIcon size={11} />
        </button>
      </div>
      <p className="hint">{hint}</p>
      {entries.length === 0 && <p className="hint">No entries.</p>}
      {entries.map(([k, v]) => (
        <div key={k} className="mcp-kv-row">
          <div className="mcp-kv-inputs">
            <input
              className="mcp-kv-key"
              value={k}
              onChange={(e) => onRename(k, e.target.value)}
              placeholder="Key"
              spellCheck={false}
            />
            <input
              className="mcp-kv-value"
              type={v === MCP_SECRET_PLACEHOLDER ? 'password' : 'text'}
              // The stored secret never reaches the renderer: the sentinel value
              // stays in the draft (so save keeps it) while the field shows an
              // empty password input with an explanatory placeholder. Typing a
              // replacement value swaps in the new plaintext to be re-encrypted.
              value={v === MCP_SECRET_PLACEHOLDER ? '' : v}
              onChange={(e) => onValue(k, e.target.value)}
              placeholder={v === MCP_SECRET_PLACEHOLDER ? '•••••••• (stored — type to replace)' : 'value or $ENV_VAR'}
              spellCheck={false}
            />
          </div>
          <button type="button" className="mini-btn danger mcp-kv-del-btn" onClick={() => onRemove(k)} title="Remove row">
            <XIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
