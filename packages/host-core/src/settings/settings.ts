import { writeFileAtomic } from '../files/atomic-write'
import { existsSync, mkdirSync, promises as fsPromises, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { McpServerRecord, McpServerOverride } from '../mcp/mcp-settings'
import { hostPaths, hostSecrets, hostKeyOverrides, hostKeyPersistence } from '../env'
import {
  findVerifiedReasoningLadder,
  getVerifiedReasoningLadderRows,
  getVerifiedReasoningLadders,
  providerConfigFileSchema,
} from '@codebuff/sdk'

/**
 * Provider settings management (multi-provider).
 * - Each provider can have multiple models; any number of OpenAI-compatible providers can be added.
 * - API keys are encrypted via the host SecretStore seam (Electron safeStorage /
 *   DPAPI on Windows, ADR-11; in-memory Keystore-backed store on Android) and
 *   stored per-provider in the host data dir.
 * - Provider settings are written as anybuff.json (SDK provider config format),
 *   referenced via the ANYBUFF_PROVIDER_CONFIG environment variable.
 */

export type ProviderType = 'openai-compatible' | 'anthropic-compatible'
/**
 * ADR-27 (MC-0.2b): the selected-effort domain is OPEN — any non-empty
 * string a ladder declares is a legal pick ('xhigh', vendor-specific rungs).
 * The literal members stay for autocomplete; 'default' remains the host-menu
 * sentinel that is never sent on the wire (writeProviderConfigFile skips it).
 */
export type ReasoningEffort =
  | 'default'
  | 'high'
  | 'medium'
  | 'low'
  | 'minimal'
  | 'none'
  | 'extra-high'
  | 'max'
  | (string & {})
export type ApprovalMode = 'balanced' | 'strict' | 'allow-all'

/** #17 run-options guardrails: max steps per run (loop fuse) and cost mode.
 *  maxAgentSteps 0 = use the SDK default (200); costMode 'normal' is default. */
export type RunMaxAgentSteps = number // 0 (default) or 1..100000
export type RunCostMode = 'normal' | 'max' | 'lite'

export interface ProviderConfig {
  id: string
  label: string
  type: ProviderType
  baseURL: string
  apiKeyEnv: string
  models: string[]
  enableThinking?: boolean
  customBody?: Record<string, unknown> | string
  /** Per-model capability metadata (windowTokens/outputTokens) learned from
   *  overflow errors (A2) or lazy catalog hydration (P1 B1d). Written into
   *  the generated anybuff.json so the SDK reads it; never set by hand here —
   *  explicit anybuff.json entries still win at resolution time. */
  modelCapabilities?: Record<string, {
    context?: { windowTokens?: number; outputTokens?: number }
    /** ADR-25: declared reasoning ladders flow through to anybuff.json and
     * the Desktop menus (explicit declarations win over the SDK seed table). */
    reasoning?: {
      supported?: boolean
      efforts?: string[]
      defaultEffort?: string
      /** ADR-27 (§3.2/MC-0.5): per-model non-enum reasoning params riding
       * the effort pick (e.g. DashScope thinking_budget). Mirrors the SDK slot. */
      params?: Record<string, string | number | boolean>
    }
  }>
}

import type { FileChange, TaskMessage, TodoItem } from '../contracts/types'
/**
 * Transcript-message / file-change / todo shapes — canonical contract types
 * (ADR-21 single source of truth, see contracts/types.ts). Re-exported here so
 * existing `from './settings'` imports across host-core keep typechecking.
 */
export type { FileChange, TaskMessage, TodoItem } from '../contracts/types'

export interface TaskRecord {
  id: string
  prompt: string
  createdAt: number
  updatedAt?: number
}

export interface ProjectRecord {
  path: string
  name: string
  tasks: TaskRecord[]
}

/** Per-agent model route: `${providerId}/${model}` plus an optional reasoning effort. */
export interface AgentRoute {
  model: string
  reasoningEffort?: ReasoningEffort
}

/** Selectable web search providers (mirrors the SDK's WebSearchProviderId). */
export type WebSearchProviderId = 'duckduckgo' | 'firecrawl' | 'tinyfish'

export interface AppSettings {
  providers: ProviderConfig[]
  activeModel: string // `${providerId}/${model}`
  reasoningEffort: ReasoningEffort
  approvalMode: ApprovalMode
  cwd: string | null
  hasProvider: boolean
  providerHasKey: Record<string, boolean>
  projects: ProjectRecord[]
  /** Per-agent model routing overrides, keyed by agent ID. Empty = use the global default model. */
  agentRouting: Record<string, AgentRoute>
  /** Active web search provider for the web_search tool. */
  webSearchProvider: WebSearchProviderId
  /** Whether a Tinyfish/Firecrawl search key is stored (DPAPI). */
  webSearchHasKey: Record<WebSearchProviderId, boolean>
  /** #17 max agent steps per run (0 = SDK default). Drives the loop fuse. */
  maxAgentSteps: number
  /** #17 cost mode flag forwarded to the SDK run. */
  costMode: RunCostMode
  /** ADR-25 per-model reasoning-effort ladders for the UI menus: keys are
   * provider-qualified `${providerId}/${model}` (explicit declarations,
   * which win for that route) or bare model ids (SDK-verified seed ladders). */
  reasoningLadders: Record<string, string[]>
}

const SETTINGS_FILE = 'AnyBuff-app-settings.json'

interface PersistedSettings {
  providers: ProviderConfig[]
  activeModel: string
  reasoningEffort: ReasoningEffort
  approvalMode: ApprovalMode
  cwd?: string
  encryptedKeys?: Record<string, string> // providerId -> base64 encrypted key
  projects?: ProjectRecord[]
  agentRouting?: Record<string, AgentRoute>
  /** Active web search provider (default duckduckgo). */
  webSearchProvider?: WebSearchProviderId
  /** #17 max agent steps per run (0 = SDK default; omitted = legacy). */
  maxAgentSteps?: number
  /** #17 SDK cost mode ('normal' | 'max' | 'lite'). */
  costMode?: RunCostMode
  /** App-managed MCP servers (Settings → MCP Tools). */
  mcpServers?: McpServerRecord[]
  /** App-level overrides for mcp.json-discovered servers, keyed by opaque file id. */
  mcpOverrides?: Record<string, McpServerOverride>
}

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'openai',
    label: 'OpenAI API',
    type: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.2', 'gpt-5.2-codex', 'gpt-4.1', 'gpt-4.1-mini']
  },
  {
    id: 'anthropic',
    label: 'Anthropic API',
    type: 'anthropic-compatible',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4-0']
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: ['anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.1', 'anthropic/claude-haiku-4.5', 'openai/gpt-5.5', 'openai/gpt-4.1']
  }
]

function settingsPath(): string {
  return join(hostPaths().dataDir, SETTINGS_FILE)
}

/** Automatically migrate settings, keys, and tasks from legacy 'openbuff-windows' directory if present. */
function migrateLegacyUserData(): void {
  try {
    const currentDir = hostPaths().dataDir
    const currentSettings = join(currentDir, SETTINGS_FILE)

    const appData = hostPaths().appDataDir
    const legacyDir = join(appData, 'openbuff-windows')
    const legacySettings = join(legacyDir, SETTINGS_FILE)
    if (!existsSync(legacySettings)) return

    // Check if current settings is missing or essentially empty (no projects and no keys)
    let shouldMigrateSettings = true
    if (existsSync(currentSettings)) {
      try {
        const currentData = JSON.parse(readFileSync(currentSettings, 'utf-8')) as PersistedSettings
        const hasKeys = currentData.encryptedKeys && Object.keys(currentData.encryptedKeys).length > 0
        const hasProjects = Array.isArray(currentData.projects) && currentData.projects.length > 0
        if (hasKeys || hasProjects) {
          shouldMigrateSettings = false
        }
      } catch {
        shouldMigrateSettings = true
      }
    }

    mkdirSync(currentDir, { recursive: true })

    if (shouldMigrateSettings) {
      writeFileSync(currentSettings, readFileSync(legacySettings, 'utf-8'), 'utf-8')

      const legacyOpenbuffJson = join(legacyDir, 'openbuff.json')
      if (existsSync(legacyOpenbuffJson)) {
        writeFileSync(join(currentDir, 'anybuff.json'), readFileSync(legacyOpenbuffJson, 'utf-8'), 'utf-8')
      }

      const legacyWindowState = join(legacyDir, 'window-state.json')
      if (existsSync(legacyWindowState)) {
        writeFileSync(join(currentDir, 'window-state.json'), readFileSync(legacyWindowState, 'utf-8'), 'utf-8')
      }
    }

    // Always copy any missing task transcripts
    const legacyTasksDir = join(legacyDir, 'tasks')
    if (existsSync(legacyTasksDir)) {
      const currentTasksDir = join(currentDir, 'tasks')
      mkdirSync(currentTasksDir, { recursive: true })
      const files = readdirSync(legacyTasksDir)
      for (const f of files) {
        try {
          const src = join(legacyTasksDir, f)
          const dst = join(currentTasksDir, f)
          if (statSync(src).isFile() && !existsSync(dst)) {
            writeFileSync(dst, readFileSync(src))
          }
        } catch {
          // ignore single file copy error
        }
      }
    }
  } catch {
    // ignore migration failure
  }
}

function defaultSettings(): PersistedSettings {
  return {
    providers: DEFAULT_PROVIDERS.map((p) => ({ ...p, models: [...p.models] })),
    activeModel: 'openai/gpt-5.5',
    reasoningEffort: 'default',
    approvalMode: 'balanced',
    projects: [],
    webSearchProvider: 'duckduckgo',
    maxAgentSteps: 0,
    costMode: 'normal'
  }
}

export function loadSettings(): PersistedSettings {
  migrateLegacyUserData()
  const file = settingsPath()
  if (!existsSync(file)) return defaultSettings()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<PersistedSettings>
    const base = defaultSettings()
    // Migrate legacy format (single provider) → new multi-provider format
    const legacy = parsed as unknown as Record<string, unknown>
    if (Array.isArray(parsed.providers) && parsed.providers.length > 0) {
      base.providers = parsed.providers
    } else if (typeof legacy.providerType === 'string' && legacy.baseURL !== undefined) {
      const id = String(legacy.providerType)
      const models = Array.isArray(legacy.models)
        ? (legacy.models as string[])
        : legacy.model
          ? [String(legacy.model)]
          : []
      base.providers = [
        {
          id,
          label: id,
          type: id === 'anthropic' ? 'anthropic-compatible' : 'openai-compatible',
          baseURL: String(legacy.baseURL ?? ''),
          apiKeyEnv: id === 'anthropic' ? 'ANTHROPIC_API_KEY' : id === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY',
          models
        }
      ]
      if (typeof legacy.model === 'string' && legacy.model) {
        base.activeModel = `${id}/${legacy.model}`
      }
    }
    if (typeof parsed.activeModel === 'string' && parsed.activeModel) base.activeModel = parsed.activeModel
    if (parsed.reasoningEffort) base.reasoningEffort = parsed.reasoningEffort
    if (parsed.approvalMode) base.approvalMode = parsed.approvalMode
    if (typeof parsed.cwd === 'string') base.cwd = parsed.cwd
    if (parsed.encryptedKeys && typeof parsed.encryptedKeys === 'object') base.encryptedKeys = parsed.encryptedKeys
    if (Array.isArray(parsed.projects)) base.projects = parsed.projects
    if (parsed.agentRouting && typeof parsed.agentRouting === 'object') {
      base.agentRouting = Object.fromEntries(
        Object.entries(parsed.agentRouting).filter(([, v]) => v && typeof v.model === 'string' && v.model.trim())
      )
    }
    // Web search provider (default duckduckgo; validate against the known set)
    if (parsed.webSearchProvider === 'firecrawl' || parsed.webSearchProvider === 'tinyfish' || parsed.webSearchProvider === 'duckduckgo') {
      base.webSearchProvider = parsed.webSearchProvider
    }
    // #17 run guardrails (clamped so a corrupt settings file can never send
    // a runaway or negative step cap into the SDK).
    if (typeof parsed.maxAgentSteps === 'number' && Number.isFinite(parsed.maxAgentSteps)) {
      const steps = Math.floor(parsed.maxAgentSteps)
      base.maxAgentSteps = steps <= 0 ? 0 : Math.min(steps, 100_000)
    }
    if (parsed.costMode === 'max' || parsed.costMode === 'lite' || parsed.costMode === 'normal') {
      base.costMode = parsed.costMode
    }
    if (Array.isArray(parsed.mcpServers)) base.mcpServers = parsed.mcpServers
    if (parsed.mcpOverrides && typeof parsed.mcpOverrides === 'object') base.mcpOverrides = parsed.mcpOverrides
    // Legacy single-key migration
    if (!base.encryptedKeys && typeof legacy.encryptedApiKey === 'string') {
      const first = base.providers[0]
      if (first) base.encryptedKeys = { [first.id]: legacy.encryptedApiKey as string }
    }
    return base
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(settings: PersistedSettings): void {
  writeFileAtomic(settingsPath(), JSON.stringify(settings, null, 2))
}


/** Mark a task as recently active (drives sidebar newest-first sorting). */
function touchTaskUpdated(taskId: string): void {
  try {
    const s = loadSettings()
    for (const p of s.projects ?? []) {
      const t = p.tasks.find((x) => x.id === taskId)
      if (t) {
        t.updatedAt = Date.now()
        saveSettings(s)
        return
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * ADR-25: per-model reasoning-effort ladders for the UI menus. Merges the
 * SDK-verified seed table (bare model ids — vendor-documented native levels,
 * variant-tolerant) with provider-declared `modelCapabilities` (qualified
 * `${providerId}/${model}` keys, which win for that route). Pure — no
 * host-env seams — so it is unit-testable without installing a host.
 */
export function buildReasoningLadders(
  providers: ProviderConfig[]
): Record<string, string[]> {
  const ladders: Record<string, string[]> = {}
  for (const [bareModel, efforts] of Object.entries(
    getVerifiedReasoningLadders()
  )) {
    ladders[bareModel] = [...efforts]
  }
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      const declared = provider.modelCapabilities?.[model]?.reasoning?.efforts
      const efforts = declared?.length
        ? declared
        : findVerifiedReasoningLadder(model)?.efforts
      if (efforts?.length) {
        ladders[`${provider.id}/${model}`] = [...efforts]
      }
    }
  }
  return ladders
}

/** ADR-27 (MC-0.4): provenance for a resolved ladder — every menu value must
 * answer "who says so" (§2.5): verified seed (with verifiedAt/source), a
 * user's explicit declaration, or unknown (no ladder anywhere — the Desktop
 * menu shows its conservative fallback). */
export type ReasoningLadderSource = 'verified' | 'declared' | 'unknown'

export interface ReasoningLadderInfo {
  /** Effective rungs, exactly what the menu shows. Empty for 'unknown'. */
  efforts: string[]
  /** Where the effective efforts came from. */
  source: ReasoningLadderSource
  /** Seed provenance — present iff source === 'verified'. */
  verifiedAt?: string
  verifiedBy?: string
  /** The user's declaration — present iff source === 'declared'. */
  declared?: {
    efforts?: string[]
    defaultEffort?: string
    supported?: boolean
    /** ADR-27 (MC-1.5): declared per-model reasoning params. */
    params?: Record<string, string | number | boolean>
  }
  /** The seed row this declaration overrides — present iff source ===
   * 'declared' AND a seed exists for the model (P1 "restore to seed"). */
  overriddenSeed?: { efforts: string[]; verifiedAt: string }
  /** Per-model context overrides when present in settings. */
  context?: { windowTokens?: number; outputTokens?: number }
  /** The declared or seed default rung, when one exists. */
  defaultEffort?: string
}

/**
 * The full capabilities listing surface for the P1 UI (§3.4): one row per
 * configured provider model (plus the bare seed ids), each carrying its
 * source badge and provenance. Effort literals pass through VERBATIM —
 * `xhigh` and `extra-high` are different wire strings (§2.1).
 */
export function buildReasoningLadderInfos(
  providers: ProviderConfig[]
): Record<string, ReasoningLadderInfo> {
  const infos: Record<string, ReasoningLadderInfo> = {}
  for (const [bareModel, row] of Object.entries(
    getVerifiedReasoningLadderRows()
  )) {
    infos[bareModel] = {
      efforts: [...row.efforts],
      source: 'verified',
      verifiedAt: row.verifiedAt,
      verifiedBy: row.source,
      defaultEffort: row.defaultEffort,
    }
  }
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      const cap = provider.modelCapabilities?.[model]
      const declaredEfforts = cap?.reasoning?.efforts
      const seed = findVerifiedReasoningLadder(model)
      const key = `${provider.id}/${model}`
      if (declaredEfforts?.length) {
        infos[key] = {
          efforts: [...declaredEfforts],
          source: 'declared',
          declared: {
            efforts: [...declaredEfforts],
            defaultEffort: cap?.reasoning?.defaultEffort,
            supported: cap?.reasoning?.supported,
            ...(cap?.reasoning?.params !== undefined
              ? { params: { ...cap.reasoning.params } }
              : {}),
          },
          // The seed this declaration overrides (P1's "restore to seed"
          // button needs to know one exists underneath).
          ...(seed
            ? { overriddenSeed: { efforts: [...seed.efforts], verifiedAt: seed.verifiedAt } }
            : {}),
          context: cap?.context,
          defaultEffort: cap?.reasoning?.defaultEffort,
        }
      } else if (seed) {
        infos[key] = {
          efforts: [...seed.efforts],
          source: 'verified',
          verifiedAt: seed.verifiedAt,
          verifiedBy: seed.source,
          defaultEffort: cap?.reasoning?.defaultEffort ?? seed.defaultEffort,
          context: cap?.context,
        }
      } else {
        infos[key] = { efforts: [], source: 'unknown', context: cap?.context }
      }
    }
  }
  return infos
}

export function getAppSettings(): AppSettings {
  const s = loadSettings()

  // Self-heal Gemini-style model ids persisted with a "models/" prefix:
  // /chat/completions expects the bare id, and selectors should render clean
  // names. Normalize providers' lists and activeModel in one pass.
  let dirty = false
  for (const p of s.providers) {
    if (Array.isArray(p.models) && p.models.some((m) => m.startsWith('models/'))) {
      p.models = [...new Set(p.models.map((m) => m.replace(/^models\//, '')))]
      dirty = true
    }
  }
  if (typeof s.activeModel === 'string' && s.activeModel.includes('/models/')) {
    s.activeModel = s.activeModel.replace(/\/models\//, '/')
    dirty = true
  }
  if (dirty) saveSettings(s)

  const activeProviderId = s.activeModel.split('/')[0] ?? ''
  const activeProvider = s.providers.find((p) => p.id === activeProviderId) ?? s.providers[0]
  const hasKey = activeProvider ? getProviderApiKey(activeProvider.id) !== undefined : false
  const isLocal = activeProvider ? /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(activeProvider.baseURL) : false
  const providerHasKey: Record<string, boolean> = {}
  for (const p of s.providers) {
    providerHasKey[p.id] = getProviderApiKey(p.id) !== undefined
  }
  return {
    providers: s.providers,
    activeModel: s.activeModel,
    reasoningEffort: s.reasoningEffort,
    approvalMode: s.approvalMode,
    cwd: s.cwd ?? null,
    hasProvider: Boolean(activeProvider) && (hasKey || isLocal),
    providerHasKey,
    projects: s.projects ?? [],
    agentRouting: s.agentRouting ?? {},
    webSearchProvider: s.webSearchProvider ?? 'duckduckgo',
    maxAgentSteps: s.maxAgentSteps ?? 0,
    costMode: s.costMode ?? 'normal',
    reasoningLadders: buildReasoningLadders(s.providers),
    webSearchHasKey: {
      duckduckgo: false,
      firecrawl: getSearchApiKey('firecrawl') !== undefined,
      tinyfish: getSearchApiKey('tinyfish') !== undefined
    }
  }
}

/** Search-provider key storage id (DPAPI, ADR-11). Distinct from model keys. */
function searchKeyId(provider: WebSearchProviderId): string | null {
  if (provider === 'firecrawl') return 'search-firecrawl'
  if (provider === 'tinyfish') return 'search-tinyfish'
  return null
}

/**
 * Save a web search provider's API key (Tinyfish / Firecrawl). Empty string
 * deletes it. DPAPI is mandatory (ADR-11) — identical policy to model keys.
 */
export function saveSearchApiKey(provider: WebSearchProviderId, apiKey: string): void {
  const id = searchKeyId(provider)
  if (!id) return
  // Android headless host: the shell's Keystore is the durable store (the
  // renderer mirrors the key into it via the native bridge under this same
  // vault-key id, ADR-17); the host only refreshes the live in-memory overlay.
  const persistence = hostKeyPersistence()
  if (persistence) {
    if (apiKey) persistence.save(id, apiKey)
    else persistence.remove(id)
    const overlays = hostKeyOverrides()
    if (apiKey) overlays[id] = apiKey
    else delete overlays[id]
    return
  }
  const s = loadSettings()
  s.encryptedKeys = s.encryptedKeys ?? {}
  if (!apiKey) {
    delete s.encryptedKeys[id]
  } else if (hostSecrets().isEncryptionAvailable()) {
    s.encryptedKeys[id] = hostSecrets().encryptString(apiKey).toString('base64')
  } else {
    throw new Error(
      'OS credential encryption (DPAPI) is unavailable, so the search API key cannot be stored safely. Set the key as an environment variable instead.'
    )
  }
  saveSettings(s)
}

/** Decrypt a stored web search provider API key (undefined when absent). */
export function getSearchApiKey(provider: WebSearchProviderId): string | undefined {
  const id = searchKeyId(provider)
  if (!id) return undefined
  // In-memory overlay first (Android: Keystore values hydrated at boot, or
  // freshly-saved keys relayed over saveSettings — same precedence as
  // getProviderApiKey).
  const overlay = hostKeyOverrides()[id]
  if (overlay !== undefined) return overlay
  const s = loadSettings()
  const enc = s.encryptedKeys?.[id]
  if (!enc) return undefined
  if (enc.startsWith('plain:')) {
    console.warn(`[anybuff] stored search key for '${provider}' is legacy plaintext; re-entry required`)
    return undefined
  }
  try {
    return hostSecrets().decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return undefined
  }
}

/** Generic DPAPI vault helper (ADR-11) — used by MCP server inline secrets. Empty value deletes. */
export function saveSecret(key: string, value: string): void {
  const s = loadSettings()
  s.encryptedKeys = s.encryptedKeys ?? {}
  if (!value) {
    delete s.encryptedKeys[key]
  } else if (hostSecrets().isEncryptionAvailable()) {
    s.encryptedKeys[key] = hostSecrets().encryptString(value).toString('base64')
  } else {
    throw new Error(
      'OS credential encryption (DPAPI) is unavailable, so the secret cannot be stored safely. Use a $ENV_VAR reference instead.'
    )
  }
  saveSettings(s)
}

/** Decrypt a stored vault entry (undefined when absent or legacy plaintext). */
export function getSecret(key: string): string | undefined {
  const s = loadSettings()
  const enc = s.encryptedKeys?.[key]
  if (!enc || enc.startsWith('plain:')) return undefined
  try {
    return hostSecrets().decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return undefined
  }
}

/**
 * Build the per-run webSearch option for the SDK. Keys travel via the
 * run-options channel (ADR-12) and never enter process.env.
 */
export function getWebSearchConfig(): {
  provider: WebSearchProviderId
  tinyfishApiKey?: string
  firecrawlApiKey?: string
} {
  const s = loadSettings()
  const provider = s.webSearchProvider ?? 'duckduckgo'
  // Always forward both stored keys, not just the active provider's: the
  // DuckDuckGo 403/429 auto-fallback runs through Firecrawl, so a saved
  // Firecrawl key must be available even when the primary provider is DDG.
  return {
    provider,
    tinyfishApiKey: getSearchApiKey('tinyfish'),
    firecrawlApiKey: getSearchApiKey('firecrawl')
  }
}

/** Set the active web search provider. */
export function setWebSearchProvider(provider: WebSearchProviderId): void {
  const s = loadSettings()
  s.webSearchProvider = provider
  saveSettings(s)
}

/** #17: persist run guardrails (maxAgentSteps 0 = SDK default). */
export function updateRunGuardrails(maxAgentSteps: number, costMode: RunCostMode): void {
  const s = loadSettings()
  const steps = Math.floor(Number(maxAgentSteps) || 0)
  s.maxAgentSteps = steps <= 0 ? 0 : Math.min(steps, 100_000)
  s.costMode = costMode === 'max' || costMode === 'lite' ? costMode : 'normal'
  saveSettings(s)
}

export function saveCwd(cwd: string): void {
  const s = loadSettings()
  s.cwd = cwd
  saveSettings(s)
}

/** Update the provider list and preferences (does not touch API keys). */
export function updateProviders(
  providers: ProviderConfig[],
  activeModel: string,
  reasoningEffort: ReasoningEffort,
  approvalMode: ApprovalMode
): void {
  const s = loadSettings()
  s.providers = providers
  s.activeModel = activeModel || s.activeModel
  s.reasoningEffort = reasoningEffort
  s.approvalMode = approvalMode
  saveSettings(s)
}

/** Replace the per-agent model routing table (empty values are dropped). */
export function updateAgentRouting(routing: Record<string, AgentRoute>): void {
  const s = loadSettings()
  s.agentRouting = Object.fromEntries(
    Object.entries(routing).filter(([, v]) => v && typeof v.model === 'string' && v.model.trim())
  )
  saveSettings(s)
}

/** Save a single provider's API key; empty string deletes that provider's key.
 * ADR-11: DPAPI is mandatory — when safeStorage is unavailable we refuse to
 * store the key rather than silently downgrading to reversible plaintext.
 * The UI surfaces the error and directs the user to an env-var workflow.
 *
 * Android (Phase B): when the shell installs a keyPersistence seam, the key is
 * handed to the shell for Keystore storage + re-hydration instead of being
 * disk-encrypted by the (decrypt-only) in-memory SecretStore. */
export function saveProviderApiKey(providerId: string, apiKey: string): void {
  const persistence = hostKeyPersistence()
  if (persistence) {
    if (apiKey) persistence.save(providerId, apiKey)
    else persistence.remove(providerId)
    // The in-memory overlay is the live read path on Android; refresh it so
    // the UI and the next run see the change immediately.
    const overlays = hostKeyOverrides()
    if (apiKey) overlays[providerId] = apiKey
    else delete overlays[providerId]
    return
  }
  const s = loadSettings()
  s.encryptedKeys = s.encryptedKeys ?? {}
  if (!apiKey) {
    delete s.encryptedKeys[providerId]
  } else if (hostSecrets().isEncryptionAvailable()) {
    s.encryptedKeys[providerId] = hostSecrets().encryptString(apiKey).toString('base64')
  } else {
    throw new Error(
      'OS credential encryption (DPAPI) is unavailable, so the API key cannot be stored safely. Set the key as an environment variable instead.'
    )
  }
  saveSettings(s)
}

export function getProviderApiKey(providerId: string): string | undefined {
  // In-memory overlay first (Android Keystore hydration / dev secrets); the
  // shell decrypts before host-core runs so plaintext never sits on disk.
  const overlay = hostKeyOverrides()[providerId]
  if (overlay !== undefined) return overlay
  const s = loadSettings()
  const enc = s.encryptedKeys?.[providerId]
  if (!enc) return undefined
  // ADR-11: legacy plaintext entries are never silently reused — the user
  // must re-enter the key so it can be stored encrypted.
  if (enc.startsWith('plain:')) {
    console.warn(`[anybuff] stored key for '${providerId}' is legacy plaintext; re-entry required`)
    return undefined
  }
  try {
    return hostSecrets().decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return undefined
  }
}

/** ADR-12: build the per-run keyMap for the SDK injection channel. Keys stay
 * inside the main process; they are never written to process.env, so
 * agent-spawned child processes cannot read them. */
export function getProviderApiKeyOverrides(): Record<string, string> {
  // In-memory overlay entries take precedence over (and include) disk keys.
  const overrides: Record<string, string> = { ...hostKeyOverrides() }
  const s = loadSettings()
  for (const p of s.providers) {
    if (overrides[p.id]) continue
    const key = getProviderApiKey(p.id)
    if (key) overrides[p.id] = key
  }
  return overrides
}

/**
 * Persist a learned/hydrated context window for a provider model (P1 B1d).
 * Accepts either a bare model id or a routable `${providerId}/${model}`
 * string; the routable form wins when it names a known provider. Only fills
 * gaps — an explicit capability recorded here before (or a model with no
 * matching provider entry) is left untouched. Best-effort: never throws.
 */
export function recordProviderModelCapability(params: {
  providerId?: string
  model: string
  windowTokens?: number
  outputTokens?: number
  /**
   * ADR-27 (MC-0.5): learned reasoning metadata — an efforts ladder and/or
   * per-model reasoning params. Explicit declarations are never overridden
   * (same rule as the A2 context write-back), and a learned context write
   * never blocks a reasoning write (each field is guarded independently).
   */
  reasoning?: {
    efforts?: string[]
    params?: Record<string, string | number | boolean>
  }
}): void {
  try {
    const { providerId: explicitProviderId, model, windowTokens, outputTokens, reasoning } = params
    const validWindow = windowTokens !== undefined && Number.isFinite(windowTokens) && windowTokens > 0
    const validOutput = outputTokens !== undefined && Number.isFinite(outputTokens) && outputTokens > 0
    const efforts = reasoning?.efforts?.filter(
      (effort) => typeof effort === 'string' && effort.length > 0 && effort !== 'default'
    )
    const reasoningParams = reasoning?.params
      ? Object.fromEntries(
          Object.entries(reasoning.params).filter(
            ([key, value]) =>
              key.length > 0 &&
              (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
          )
        )
      : undefined
    const hasReasoning =
      (efforts !== undefined && efforts.length > 0) ||
      (reasoningParams !== undefined && Object.keys(reasoningParams).length > 0)
    if (!validWindow && !validOutput && !hasReasoning) return
    const s = loadSettings()
    // Resolve provider: explicit id first, then the routable prefix, then any
    // provider whose model list contains the bare model id.
    const bareModel = model.includes('/') ? model.split('/').pop()! : model
    const provider =
      (explicitProviderId ? s.providers.find((p) => p.id === explicitProviderId) : undefined) ??
      (model.includes('/')
        ? s.providers.find((p) => p.id === model.split('/')[0])
        : undefined) ??
      s.providers.find((p) => p.models.includes(bareModel))
    if (!provider) return
    const modelId = provider.models.includes(bareModel)
      ? bareModel
      : model.includes('/')
        ? model.slice(model.indexOf('/') + 1)
        : model

    provider.modelCapabilities ??= {}
    const existing = provider.modelCapabilities[modelId]
    // Same write-back rule as A2: never override an explicit entry — per
    // field, so one guarded write never drops a learnable sibling field.
    const context: { windowTokens?: number; outputTokens?: number } = {
      ...existing?.context,
    }
    if (validWindow && existing?.context?.windowTokens === undefined) context.windowTokens = windowTokens
    if (validOutput && existing?.context?.outputTokens === undefined) context.outputTokens = outputTokens
    const nextReasoning: {
      supported?: boolean
      efforts?: string[]
      defaultEffort?: string
      params?: Record<string, string | number | boolean>
    } = { ...existing?.reasoning }
    if (efforts !== undefined && efforts.length > 0 && !existing?.reasoning?.efforts?.length) {
      nextReasoning.efforts = [...efforts]
    }
    if (reasoningParams !== undefined && Object.keys(reasoningParams).length > 0) {
      const mergedParams: Record<string, string | number | boolean> = {
        ...existing?.reasoning?.params,
      }
      for (const [key, value] of Object.entries(reasoningParams)) {
        if (mergedParams[key] === undefined) mergedParams[key] = value
      }
      if (Object.keys(mergedParams).length > 0) nextReasoning.params = mergedParams
    }
    provider.modelCapabilities[modelId] = {
      ...existing,
      ...(Object.keys(context).length > 0 ? { context } : {}),
      ...(Object.keys(nextReasoning).length > 0 ? { reasoning: nextReasoning } : {}),
    }
    saveSettings(s)
  } catch {
    // Best-effort persistence — never break a run over bookkeeping.
  }
}

export function hasAnyApiKey(): boolean {
  if (Object.keys(hostKeyOverrides()).length > 0) return true
  const s = loadSettings()
  return Object.values(s.encryptedKeys ?? {}).some(Boolean)
}

/* ─── ADR-27 model-capability maintenance (MC-1.3) ─────────────────────── */

/** A single capability declaration for one model on one provider. All fields
 * optional — omitted fields simply don't change the stored entry. */
export interface ModelCapabilityUpsert {
  providerId: string
  model: string
  /** Explicit clear: delete the whole stored entry (the field-merge never
   * clears on its own — an absent field means "keep", not "remove"). */
  clear?: boolean
  reasoning?: {
    supported?: boolean
    efforts?: string[]
    defaultEffort?: string
    params?: Record<string, string | number | boolean>
  }
  context?: { windowTokens?: number; outputTokens?: number }
}

/** Per-line validation result for the Import channel (§2.4: a bad line
 * never blocks the good ones; each line reports independently). */
export interface ModelCapabilityImportLine {
  model: string
  ok: boolean
  error?: string
}

/** Normalize one upsert's fields; returns an error string for invalid
 * shapes so callers can report per-line instead of throwing (§2.4). */
function validateCapabilityUpsert(upsert: ModelCapabilityUpsert): string | undefined {
  if (!upsert?.providerId || typeof upsert.providerId !== 'string') return 'missing providerId'
  if (!upsert?.model || typeof upsert.model !== 'string') return 'missing model'
  const reasoning = upsert.reasoning
  if (reasoning !== undefined) {
    if (typeof reasoning !== 'object' || Array.isArray(reasoning)) return 'reasoning must be an object'
    if (
      reasoning.supported !== undefined &&
      typeof reasoning.supported !== 'boolean'
    ) {
      return 'reasoning.supported must be a boolean'
    }
    if (
      reasoning.efforts !== undefined &&
      (!Array.isArray(reasoning.efforts) ||
        reasoning.efforts.some(
          (e) => typeof e !== 'string' || e.length === 0 || e === 'default',
        ))
    ) {
      return "reasoning.efforts must be non-empty strings ('default' is a menu sentinel, not a rung)"
    }
    if (
      reasoning.defaultEffort !== undefined &&
      (typeof reasoning.defaultEffort !== 'string' ||
        reasoning.defaultEffort.length === 0 ||
        reasoning.defaultEffort === 'default')
    ) {
      return 'reasoning.defaultEffort must be a non-empty string'
    }
    if (reasoning.params !== undefined) {
      if (typeof reasoning.params !== 'object' || Array.isArray(reasoning.params)) {
        return 'reasoning.params must be an object'
      }
      for (const [key, value] of Object.entries(reasoning.params)) {
        if (
          key.length === 0 ||
          (typeof value !== 'string' &&
            typeof value !== 'number' &&
            typeof value !== 'boolean')
        ) {
          return 'reasoning.params values must be string/number/boolean with non-empty keys'
        }
      }
    }
  }
  const context = upsert.context
  if (context !== undefined) {
    if (typeof context !== 'object' || Array.isArray(context)) return 'context must be an object'
    if (
      context.windowTokens !== undefined &&
      (typeof context.windowTokens !== 'number' ||
        !Number.isFinite(context.windowTokens) ||
        context.windowTokens <= 0 ||
        !Number.isInteger(context.windowTokens))
    ) {
      return 'context.windowTokens must be a positive integer'
    }
    if (
      context.outputTokens !== undefined &&
      (typeof context.outputTokens !== 'number' ||
        !Number.isFinite(context.outputTokens) ||
        context.outputTokens <= 0 ||
        !Number.isInteger(context.outputTokens))
    ) {
      return 'context.outputTokens must be a positive integer'
    }
  }
  return undefined
}

/**
 * Merge one upsert into the provider's modelCapabilities (MC-1.3): a single
 * model entry, field-by-field — never a wholesale provider overwrite. The
 * whole resulting anybuff.json must still parse (MC-0.6 gate re-runs on the
 * next run), and a save followed by a re-read keeps the declaration.
 */
export function saveModelCapability(upsert: ModelCapabilityUpsert): boolean {
  const problem = validateCapabilityUpsert(upsert)
  if (problem) throw new Error(problem)
  try {
    const s = loadSettings()
    const provider = s.providers.find((p) => p.id === upsert.providerId)
    if (!provider) return false
    provider.modelCapabilities ??= {}
    // Explicit clear (ADR-27 review round 1): the field-merge below preserves
    // every stored field an upsert omits — "absent" means "keep", never
    // "remove" — so deleting is an explicit opt-in, never an accident.
    if (upsert.clear) {
      delete provider.modelCapabilities[upsert.model]
      saveSettings(s)
      return true
    }
    const existing = provider.modelCapabilities[upsert.model]
    const reasoning = { ...existing?.reasoning }
    if (upsert.reasoning) {
      if (upsert.reasoning.supported !== undefined) reasoning.supported = upsert.reasoning.supported
      if (upsert.reasoning.efforts !== undefined) reasoning.efforts = [...upsert.reasoning.efforts]
      if (upsert.reasoning.defaultEffort !== undefined) {
        reasoning.defaultEffort = upsert.reasoning.defaultEffort
      }
      if (upsert.reasoning.params !== undefined) {
        reasoning.params = { ...upsert.reasoning.params }
      }
    }
    const context = { ...existing?.context }
    if (upsert.context?.windowTokens !== undefined) context.windowTokens = upsert.context.windowTokens
    if (upsert.context?.outputTokens !== undefined) context.outputTokens = upsert.context.outputTokens
    const hasReasoning = Object.keys(reasoning).length > 0
    const hasContext = Object.keys(context).length > 0
    if (hasReasoning || hasContext) {
      provider.modelCapabilities[upsert.model] = {
        ...existing,
        ...(hasReasoning ? { reasoning } : {}),
        ...(hasContext ? { context } : {}),
      }
    }
    saveSettings(s)
    return true
  } catch {
    return false
  }
}

/**
 * Import a JSON fragment of capability declarations (MC-1.4): every line is
 * validated and applied INDEPENDENTLY — one bad line is reported, never
 * blocking the rest (§2.4). Only the `modelCapabilities` subtree is
 * touched; provider transport fields (baseURL/keys) are never writable here
 * (§2.2: a rewritten baseURL would receive DPAPI-decrypted keys).
 */
export function importModelCapabilities(payload: {
  providerId: string
  models: Record<string, unknown>
}): { ok: boolean; lines: ModelCapabilityImportLine[]; error?: string } {
  if (!payload || typeof payload !== 'object') return { ok: false, lines: [], error: 'invalid payload' }
  if (!payload.providerId || typeof payload.providerId !== 'string') {
    return { ok: false, lines: [], error: 'missing providerId' }
  }
  if (!payload.models || typeof payload.models !== 'object' || Array.isArray(payload.models)) {
    return { ok: false, lines: [], error: 'missing models map' }
  }
  const lines: ModelCapabilityImportLine[] = []
  for (const [model, rawValue] of Object.entries(payload.models)) {
    if (!model) {
      lines.push({ model, ok: false, error: 'empty model id' })
      continue
    }
    const entry =
      rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
        ? (rawValue as Record<string, unknown>)
        : {}
    const hasNested = 'reasoning' in entry || 'context' in entry
    const shorthand = !hasNested && looksLikeReasoningShorthand(entry)
    const candidate: ModelCapabilityUpsert = hasNested
      ? {
          providerId: payload.providerId,
          model,
          ...(entry.reasoning !== undefined
            ? { reasoning: entry.reasoning as ModelCapabilityUpsert['reasoning'] }
            : {}),
          ...(entry.context !== undefined
            ? { context: entry.context as ModelCapabilityUpsert['context'] }
            : {}),
        }
      : shorthand
        ? {
            providerId: payload.providerId,
            model,
            reasoning: entry as ModelCapabilityUpsert['reasoning'],
          }
        : { providerId: payload.providerId, model }
    // Review round 1: an entry with no recognizable fields is a silent no-op
    // otherwise — report it instead of claiming success (§2.5: the user
    // must always know what actually happened).
    if (
      !hasNested &&
      !shorthand &&
      Object.keys(entry).length > 0 &&
      !('clear' in entry)
    ) {
      lines.push({ model, ok: false, error: 'unrecognized entry shape (expected reasoning/context keys or a bare efforts ladder)' })
      continue
    }
    const problem = validateCapabilityUpsert(candidate)
    if (problem) {
      lines.push({ model, ok: false, error: problem })
      continue
    }
    const saved = saveModelCapability(candidate)
    lines.push({ model, ok: saved, error: saved ? undefined : 'provider not found' })
  }
  return { ok: lines.every((l) => l.ok), lines }
}

/** Bare { efforts, defaultEffort, supported, params } at the model level is
 * accepted as the reasoning block (the LLM-maintainer prompt emits this). */
function looksLikeReasoningShorthand(entry: Record<string, unknown>): boolean {
  return (
    'efforts' in entry ||
    'defaultEffort' in entry ||
    ('supported' in entry && !('windowTokens' in entry) && !('outputTokens' in entry))
  )
}

/** Generate the anybuff.json used by the SDK (provider config + routing); returns the file path */
export function writeProviderConfigFile(): string {
  const s = loadSettings()
  const providers: Record<string, unknown> = {}
  for (const p of s.providers) {
    if (!p.baseURL) continue
    if (p.type === 'anthropic-compatible') {
      providers[p.id] = {
        type: 'anthropic-compatible',
        baseURL: p.baseURL,
        apiKeyEnv: sanitizeApiKeyEnv(p.apiKeyEnv),
        models: p.models,
        compatibility: {
          stripCacheControl: false,
          stringifyTextContent: false,
          supportsTools: true,
          supportsRequiredToolChoice: true,
          supportsStopSequences: true,
          stripProviderMetadata: false
        }
      }
    } else {
      const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(p.baseURL)
      let customBodyObj: Record<string, unknown> | undefined = undefined
      if (typeof p.customBody === 'string' && p.customBody.trim()) {
        try {
          customBodyObj = JSON.parse(p.customBody)
        } catch {
          // ignore invalid JSON
        }
      } else if (p.customBody && typeof p.customBody === 'object') {
        customBodyObj = p.customBody as Record<string, unknown>
      }

      providers[p.id] = {
        type: 'openai-compatible',
        baseURL: p.baseURL,
        apiKeyEnv: sanitizeApiKeyEnv(p.apiKeyEnv),
        models: p.models,
        supportsStructuredOutputs: !isLocal,
        ...(p.enableThinking !== undefined ? { enableThinking: p.enableThinking } : {}),
        ...(customBodyObj ? { customBody: customBodyObj } : {}),
        ...(isLocal
          ? {
              compatibility: {
                stripCacheControl: true,
                stringifyTextContent: true,
                supportsTools: true,
                supportsRequiredToolChoice: true,
                supportsStopSequences: false,
                stripProviderMetadata: true
              }
            }
          : {})
      }
    }
  }
  const config: Record<string, unknown> = {
    defaultModel: s.activeModel,
    providers,
    approvalMode: s.approvalMode
  }
  if (s.reasoningEffort && s.reasoningEffort !== 'default') {
    config.defaultReasoningEffort = s.reasoningEffort
  }
  // P1 B1d: emit learned capability metadata so the SDK resolves hydrated
  // windows synchronously without refetching catalogs.
  for (const p of s.providers) {
    if (!p.baseURL || !p.modelCapabilities) continue
    const caps = Object.fromEntries(
      Object.entries(p.modelCapabilities).filter(([, v]) => v && typeof v === 'object')
    )
    const target = providers[p.id]
    if (Object.keys(caps).length > 0 && target && typeof target === 'object') {
      ;(target as Record<string, unknown>).modelCapabilities = caps
    }
  }
  // Per-agent model routing: agents[agentId] = model (string), agentReasoningEfforts[agentId] = effort
  const agentRouting = s.agentRouting ?? {}
  const routed = Object.fromEntries(Object.entries(agentRouting).filter(([, r]) => r && r.model.trim()))
  if (Object.keys(routed).length > 0) {
    config.agents = Object.fromEntries(Object.entries(routed).map(([id, r]) => [id, r.model.trim()]))
    const efforts = Object.fromEntries(
      Object.entries(routed).filter(([, r]) => r.reasoningEffort && r.reasoningEffort !== 'default').map(([id, r]) => [id, r.reasoningEffort])
    )
    if (Object.keys(efforts).length > 0) config.agentReasoningEfforts = efforts
  }
  const file = join(hostPaths().dataDir, 'anybuff.json')
  // ADR-27 (MC-0.6): validate against the SDK schema BEFORE replacing the
  // file. A structurally-invalid anybuff.json fails at config load — every
  // request, every run (§2.4) — so a rejected write keeps the previous file
  // (writeFileAtomic never pre-deletes; ADR-13) and reports loudly. The old
  // file stays self-consistent, so runs continue on the last valid settings.
  // (With NO previous file — a first run — the SDK config loader then
  // fail-louds on the missing path: preferable to a poisoned file.)
  // safeParse can still THROW when a refinement itself crashes (e.g.
  // new URL() on a garbage baseURL) — that is also a rejection, never a
  // pass-through write.
  let rejection: string | undefined
  try {
    const check = providerConfigFileSchema.safeParse(config)
    if (!check.success) {
      rejection = check.error.issues
        .map(
          (issue: { path: PropertyKey[]; message: string }) =>
            `${issue.path.join('.') || '<root>'}: ${issue.message}`,
        )
        .join('; ')
    }
  } catch (error) {
    rejection = error instanceof Error ? error.message : String(error)
  }
  if (rejection !== undefined) {
    console.error(
      `[anybuff-settings] rejected an invalid anybuff.json — kept the previous file (${rejection})`,
    )
    return file
  }
  writeFileAtomic(file, JSON.stringify(config, null, 2))
  return file
}

/** Apply saved settings to process.env (call before each run) */
export function applySettingsToEnv(): void {
  const s = loadSettings()
  // ADR-12: decrypted keys are NO LONGER written into process.env — they
  // reach the SDK through the per-run apiKeyOverrides channel instead, so
  // agent-spawned child processes never inherit plaintext credentials.
  // Point the SDK at the provider config
  process.env.ANYBUFF_PROVIDER_CONFIG = writeProviderConfigFile()
}

/* ─── Project & task history ─────────────────────────── */

export function listProjects(): ProjectRecord[] {
  const s = loadSettings()
  const projects = s.projects ?? []
  // Migrate legacy inline transcripts (pre per-task-file format) into per-task files
  let migrated = false
  for (const p of projects) {
    for (const t of p.tasks) {
      const inline = (t as TaskRecord & { messages?: TaskMessage[] }).messages
      if (inline && inline.length > 0) {
        saveTaskTranscript(t.id, inline)
        delete (t as unknown as Record<string, unknown>).messages
        migrated = true
      }
    }
  }
  if (migrated) saveSettings(s)
    // Bug 3: newest-first — projects by latest task activity, tasks by recency
  const stampedProjects = projects.map((p) => ({
    ...p,
    tasks: [...p.tasks].sort(
      (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
    ),
  }))
  stampedProjects.sort((a, b) => {
    const am = Math.max(
      ...a.tasks.map((t) => t.updatedAt ?? t.createdAt),
      0,
    )
    const bm = Math.max(
      ...b.tasks.map((t) => t.updatedAt ?? t.createdAt),
      0,
    )
    if (bm !== am) return bm - am
    return a.name.localeCompare(b.name)
  })
  return stampedProjects
}

function isValidTaskId(taskId: string): boolean {
  return typeof taskId === 'string' && /^[a-z0-9_-]+$/i.test(taskId)
}

function transcriptPath(taskId: string): string | null {
  if (!isValidTaskId(taskId)) return null
  return join(hostPaths().dataDir, 'tasks', `${taskId}.json`)
}

function runStatePath(taskId: string): string | null {
  if (!isValidTaskId(taskId)) return null
  return join(hostPaths().dataDir, 'tasks', `${taskId}.runstate.json`)
}

function checkpointPath(taskId: string): string | null {
  if (!isValidTaskId(taskId)) return null
  return join(hostPaths().dataDir, 'tasks', `${taskId}.checkpoint.json`)
}

/** Save a task's full conversation transcript to its own file (unbounded). */
export function saveTaskTranscript(taskId: string, messages: TaskMessage[]): boolean {
  try {
    const file = transcriptPath(taskId)
    if (!file) return false
    mkdirSync(dirname(file), { recursive: true })
    writeFileAtomic(file, JSON.stringify(messages))
    touchTaskUpdated(taskId)
    return true
  } catch {
    return false
  }
}

/** Persist the SDK run state so a historical conversation can be resumed with full context. */
export function saveTaskRunState(taskId: string, runState: unknown): boolean {
  try {
    const file = runStatePath(taskId)
    if (!file) return false
    mkdirSync(dirname(file), { recursive: true })
    writeFileAtomic(file, JSON.stringify(runState))
    touchTaskUpdated(taskId)
    return true
  } catch {
    return false
  }
}

/** Load a task's saved run state; returns null when unavailable. */
export function loadTaskRunState(taskId: string): unknown | null {
  try {
    const file = runStatePath(taskId)
    if (!file || !existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/** Persist a mid-turn checkpoint (main agent state snapshot) for crash recovery. */
export function saveTaskCheckpoint(taskId: string, agentState: unknown): boolean {
  try {
    const file = checkpointPath(taskId)
    if (!file) return false
    const dir = join(hostPaths().dataDir, 'tasks')
    mkdirSync(dir, { recursive: true })
    // PLAN 9.5: unique temp + fsync + rename-replace without pre-delete;
    // on unrecoverable lock contention the previous checkpoint survives.
    writeFileAtomic(file, JSON.stringify(agentState))
    return true
  } catch {
    return false
  }
}

/** Load a task's last mid-turn checkpoint; returns null when unavailable. */
export function loadTaskCheckpoint(taskId: string): unknown | null {
  try {
    const file = checkpointPath(taskId)
    if (!file || !existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/** Delete a task's mid-turn checkpoint file (called after a turn completes successfully). */
export function deleteTaskCheckpoint(taskId: string): void {
  if (!isValidTaskId(taskId)) return
  const file = checkpointPath(taskId)
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch {
    // best-effort cleanup
  }
}

export interface RecoveryFileInfo {
  runStateMtime: number | null
  checkpointMtime: number | null
}

/** Modification times of the persisted recovery files, for staleness comparison. */
export function getRecoveryFileInfo(taskId: string): RecoveryFileInfo {
  const info: RecoveryFileInfo = { runStateMtime: null, checkpointMtime: null }
  if (!isValidTaskId(taskId)) return info
  const rs = runStatePath(taskId)
  if (rs) {
    try {
      info.runStateMtime = statSync(rs).mtimeMs
    } catch {
      // missing file
    }
  }
  const cp = checkpointPath(taskId)
  if (cp) {
    try {
      info.checkpointMtime = statSync(cp).mtimeMs
    } catch {
      // missing file
    }
  }
  return info
}

/** Load a task's transcript; returns null when the task has no transcript. */
export function loadTaskTranscript(taskId: string): TaskMessage[] | null {
  try {
    const file = transcriptPath(taskId)
    if (!file || !existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as TaskMessage[]) : null
  } catch {
    return null
  }
}

/** Remove a task from history along with its transcript and runState files. */
export function deleteTask(taskId: string): void {
  if (!isValidTaskId(taskId)) return
  const s = loadSettings()
  s.projects = s.projects ?? []
  for (const p of s.projects) {
    p.tasks = p.tasks.filter((t) => t.id !== taskId)
  }
  saveSettings(s)
  const tp = transcriptPath(taskId)
  if (tp) {
    try {
      rmSync(tp, { force: true })
    } catch {
      // ignore
    }
  }
  const rp = runStatePath(taskId)
  if (rp) {
    try {
      rmSync(rp, { force: true })
    } catch {
      // ignore
    }
  }
  const cp = checkpointPath(taskId)
  if (cp) {
    try {
      rmSync(cp, { force: true })
    } catch {
      // ignore
    }
  }
}

/** Rename a task's prompt in history. */
export function renameTask(taskId: string, newPrompt: string): boolean {
  if (!isValidTaskId(taskId) || !newPrompt.trim()) return false
  const s = loadSettings()
  s.projects = s.projects ?? []
  let found = false
  for (const p of s.projects) {
    const t = p.tasks.find((task) => task.id === taskId)
    if (t) {
      t.prompt = newPrompt.trim()
      found = true
      break
    }
  }
  if (found) {
    saveSettings(s)
  }
  return found
}

/**
 * Create a task record for a conversation, or return the existing one when
 * called with an id that already exists (one record per conversation, not per message).
 */
export function ensureProjectTask(cwd: string, title: string, taskId?: string): TaskRecord {
  const s = loadSettings()
  s.projects = s.projects ?? []
  const name = cwd.split(/[\\/]/).pop() || cwd
  let project = s.projects.find((p) => p.path === cwd)
  if (!project) {
    project = { path: cwd, name, tasks: [] }
    s.projects.unshift(project)
  } else {
    // Move to the front (most recently used)
    s.projects = s.projects.filter((p) => p.path !== cwd)
    s.projects.unshift(project)
    if (taskId) {
      const existing = project.tasks.find((t) => t.id === taskId)
      if (existing) return existing
    }
  }
  const task: TaskRecord = { id: taskId || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, prompt: title.slice(0, 300), createdAt: Date.now() }
  project.tasks.unshift(task)
  if (project.tasks.length > 100) project.tasks = project.tasks.slice(0, 100)
  saveSettings(s)
  return task
}

export function touchProject(cwd: string): void {
  const s = loadSettings()
  s.projects = s.projects ?? []
  const existing = s.projects.find((p) => p.path === cwd)
  if (existing) {
    s.projects = s.projects.filter((p) => p.path !== cwd)
    s.projects.unshift(existing)
    saveSettings(s)
  }
}

/** Remove a project and all its task files from history. */
export function removeProject(projectPath: string): boolean {
  if (!projectPath) return false
  const s = loadSettings()
  s.projects = s.projects ?? []
  const target = s.projects.find((p) => p.path === projectPath)
  if (!target) return false
  for (const t of target.tasks ?? []) {
    deleteTask(t.id)
  }
  const s2 = loadSettings()
  s2.projects = (s2.projects ?? []).filter((p) => p.path !== projectPath)
  saveSettings(s2)
  return true
}

export interface HistorySearchResult {
  taskId: string
  taskPrompt: string
  projectPath: string
  projectName: string
  messageIndex: number
  kind: 'user' | 'assistant'
  snippet: string
  createdAt: number
}

/** Asynchronously search across all historical task transcripts for user and assistant messages only. */
export async function searchHistory(query: string): Promise<HistorySearchResult[]> {
  if (!query || !query.trim()) return []
  const q = query.trim().toLowerCase()
  const s = loadSettings()
  const projects = s.projects ?? []
  const results: HistorySearchResult[] = []

  // Collect all task descriptors across all projects
  const tasksToSearch: { project: ProjectRecord; task: TaskRecord }[] = []
  for (const p of projects) {
    for (const t of p.tasks ?? []) {
      tasksToSearch.push({ project: p, task: t })
    }
  }

  // Read all transcripts in parallel asynchronously to avoid blocking the main event loop
  const transcripts = await Promise.all(
    tasksToSearch.map(async ({ project, task }) => {
      try {
        const file = transcriptPath(task.id)
        if (!file || !existsSync(file)) return null
        const content = await fsPromises.readFile(file, 'utf-8')
        const parsed = JSON.parse(content)
        if (!Array.isArray(parsed)) return null
        return { project, task, messages: parsed as TaskMessage[] }
      } catch {
        return null
      }
    })
  )

  for (const item of transcripts) {
    if (!item) continue
    const { project, task, messages } = item
    messages.forEach((msg, idx) => {
      if (msg.kind !== 'user' && msg.kind !== 'assistant') return
      const rawText = msg.text || ''
      const text = rawText.replace(/\s+/g, ' ')
      const matchIdx = text.toLowerCase().indexOf(q)
      if (matchIdx >= 0) {
        const start = Math.max(0, matchIdx - 20)
        const snippet =
          (start > 0 ? '...' : '') + text.slice(start, start + 100) + (start + 100 < text.length ? '...' : '')
        results.push({
          taskId: task.id,
          taskPrompt: task.prompt,
          projectPath: project.path,
          projectName: project.name,
          messageIndex: idx,
          kind: msg.kind,
          snippet,
          createdAt: task.createdAt
        })
      }
    })
  }

  return results
}


/** SDK schema requires /^[A-Z_][A-Z0-9_]*$/; normalize user input so a
 * lowercase or hyphenated name can never invalidate the whole config file. */
function sanitizeApiKeyEnv(value: string | undefined): string | undefined {
  if (!value) return undefined
  const upper = value.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
  return /^[A-Z_][A-Z0-9_]*$/.test(upper) ? upper : undefined
}