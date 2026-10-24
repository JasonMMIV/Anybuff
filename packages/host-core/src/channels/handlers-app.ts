/**
 * App-state handlers (AnyBuff:getState / saveSettings / fetchModels).
 *
 * Logic ported verbatim from the Electron shell's registerIpc() so behavior is
 * byte-identical whether the renderer talks over IPC or (Phase B) WebSocket.
 */

import { bundledAgents } from '../agents/bundled-agents'
import {
  getAppSettings,
  getProviderApiKey,
  getProviderConfigHealth,
  loadSettings,
  saveProviderApiKey,
  updateProviders,
  updateAgentRouting,
  updateRunGuardrails,
  saveSearchApiKey,
  setWebSearchProvider,
  setGlobalSkillsEnabled,
  type ProviderConfig,
  type ReasoningEffort,
  type ApprovalMode,
  type AgentRoute,
  type WebSearchProviderId,
  type RunCostMode,
} from '../settings/settings'
import { refreshModelCatalogIfStale } from '@codebuff/sdk'
import {
  catalogWarmTarget,
  warmModelCatalogForModels,
  type CatalogWarmTarget,
} from '../model-catalog-warm'
import { isRunning } from '../run/start-run'
import { getRunningTaskId } from '../sessions/session-store'

/** ADR-31: the only settings-path catalog wait — a model ADDED by this save.
 *  Snapshot hits still resolve instantly; this caps a genuine round-trip. */
const SAVE_CATALOG_WARM_TIMEOUT_MS = 3000

export interface SaveSettingsPayload {
  providers: ProviderConfig[]
  activeModel: string
  reasoningEffort: ReasoningEffort
  approvalMode: ApprovalMode
  apiKeys?: Record<string, string>
  deleteKeys?: string[]
  agentRouting?: Record<string, AgentRoute>
  webSearchProvider?: WebSearchProviderId
  /** Skills page: home-dir global-skills scan opt-in (default true).
   *  The renderer echoes this field on every Settings save; omission is a
   *  NO-OP (the typeof guard in saveSettings), so partial saves — App.tsx's
   *  guardrail saves — never reset it (ADR-27 MC-0 save-payload race lesson). */
  globalSkillsEnabled?: boolean
  searchApiKeys?: Partial<Record<WebSearchProviderId, string>>
  deleteSearchKeys?: WebSearchProviderId[]
  /** #17 per-run step cap (0 = SDK default) + cost mode flag. */
  maxAgentSteps?: number
  costMode?: RunCostMode
}

/**
 * Pairs this save ADDS relative to the persisted settings (ADR-31 trigger
 * table). Computed from the payload so the renderer's intended models — not a
 * normalized copy — decide the trigger.
 */
function addedCatalogTargets(providers: ProviderConfig[]): {
  targets: CatalogWarmTarget[]
  newProvider: boolean
} {
  const previous = new Map(loadSettings().providers.map((p) => [p.id, new Set(p.models ?? [])]))
  const targets: CatalogWarmTarget[] = []
  let newProvider = false
  for (const provider of providers) {
    const before = previous.get(provider.id)
    if (!before) {
      // A new provider's models are new pairs as well. Warm them (bounded) so
      // the onboarding path — add provider → fetch models → save — already has
      // a reasoning ladder before the model's first run.
      newProvider = true
      for (const model of provider.models ?? []) {
        targets.push(catalogWarmTarget(provider, model))
      }
      continue
    }
    for (const model of provider.models ?? []) {
      if (!before.has(model)) targets.push(catalogWarmTarget(provider, model))
    }
  }
  return { targets, newProvider }
}

/** Shape the config-health field shared by getState and saveSettings. Only
 *  present when something is actually wrong — a clean config adds nothing. */
function configHealthField(): { configHealth: ReturnType<typeof getProviderConfigHealth> } | {} {
  const configHealth = getProviderConfigHealth()
  if (configHealth.dropped.length === 0 && configHealth.rejection === undefined) return {}
  return { configHealth }
}

/** AnyBuff:getState — reads the already-loaded catalog; startup never touches
 *  the network (ADR-31 trigger table). */
export function getState(): unknown {
  const settings = getAppSettings()
  return {
    cwd: settings.cwd,
    settings,
    running: isRunning(),
    runningTaskId: getRunningTaskId(),
    agentIds: Object.keys(bundledAgents).sort(),
    ...configHealthField(),
  }
}

/** AnyBuff:saveSettings — persists provider/model/keys/routing/web-search prefs.
 *
 * Key writes are isolated per key: one failing key (e.g. OS keychain
 * unavailable, or a headless host with no persistence seam) must not
 * silently drop the routing/web-search/guardrail fields that follow —
 * failures are collected into `keyErrors` and the rest of the payload still
 * persists (2026-09-08 device round 10: a single throwing key blocked
 * everything after it, so "did the other fields even save?" was unknowable). */
export async function saveSettings(payload: SaveSettingsPayload): Promise<unknown> {
  // ADR-31: decide what this save ADDS before persisting. Only a newly added
  // model gets a bounded catalog wait; an unchanged save stays offline.
  const added = addedCatalogTargets(payload.providers)
  updateProviders(payload.providers, payload.activeModel, payload.reasoningEffort, payload.approvalMode)
  const keyErrors: string[] = []
  if (payload.apiKeys) {
    for (const [id, key] of Object.entries(payload.apiKeys)) {
      if (!key) continue
      try {
        saveProviderApiKey(id, key.trim())
      } catch (error) {
        keyErrors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  for (const id of payload.deleteKeys ?? []) {
    try {
      saveProviderApiKey(id, '')
    } catch (error) {
      keyErrors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (payload.agentRouting) updateAgentRouting(payload.agentRouting)
  if (payload.webSearchProvider) setWebSearchProvider(payload.webSearchProvider)
  if (typeof payload.globalSkillsEnabled === 'boolean') setGlobalSkillsEnabled(payload.globalSkillsEnabled)
  if (payload.maxAgentSteps !== undefined || payload.costMode !== undefined) {
    updateRunGuardrails(payload.maxAgentSteps ?? 0, payload.costMode ?? 'normal')
  }
  if (payload.searchApiKeys) {
    for (const [provider, key] of Object.entries(payload.searchApiKeys)) {
      if (!key || (provider !== 'tinyfish' && provider !== 'firecrawl')) continue
      try {
        saveSearchApiKey(provider, key.trim())
      } catch (error) {
        keyErrors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  for (const provider of payload.deleteSearchKeys ?? []) {
    if (provider !== 'tinyfish' && provider !== 'firecrawl') continue
    try {
      saveSearchApiKey(provider, '')
    } catch (error) {
      keyErrors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // ADR-31 trigger table: a model added by this save gets its catalog ladder
  // immediately, so the composer and per-agent routing menus are configurable
  // before the first run. Bounded and best-effort — a slow or unreachable
  // models.dev never blocks saving Settings. A NEW provider warms its models
  // and additionally asks for a stale-checked refresh (30 days, fire-and-
  // forget); an unchanged save is a no-op because the catalog is already loaded.
  if (added.newProvider) void refreshModelCatalogIfStale()
  if (added.targets.length > 0) {
    await warmModelCatalogForModels(added.targets, {
      timeoutMs: SAVE_CATALOG_WARM_TIMEOUT_MS,
    })
  }
  return {
    ok: true,
    ...(keyErrors.length > 0 ? { keyErrors } : {}),
    // A rejected or degraded engine-config write must never be console-only:
    // the renderer surfaces this on the Model & Provider page (2026-09-15).
    ...configHealthField(),
    settings: getAppSettings()
  }
}

export async function fetchModels(payload: {
  baseURL: string
  apiKey?: string
  providerType?: string
  providerId?: string
}): Promise<unknown> {
  try {
    const base = payload.baseURL.replace(/\/+$/, '')
    // Stored DPAPI keys are never echoed back to the renderer, so an empty
    // payload.apiKey after reopening Settings must fall back to the persisted
    // key — otherwise every re-fetch goes out unauthenticated.
    const apiKey = payload.apiKey || (payload.providerId ? getProviderApiKey(payload.providerId) : undefined)
    // Ollama-compatible endpoint (/api/tags)
    if (/ollama|:11434/i.test(base)) {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      const data = (await res.json()) as { models?: { name?: string }[] }
      const models = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean).sort()
      if (models.length === 0) return { ok: false, error: 'No model data in response' }
      // ADR-31 §6.3: a successfully fetched model list is a good moment to
      // check the catalog's age (fire-and-forget; a 304 or failure keeps the
      // current snapshot).
      void refreshModelCatalogIfStale()
      return { ok: true, models }
    }
    // OpenAI-compatible /models
    const res = await fetch(`${base}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` }
    const data = (await res.json()) as { data?: { id?: string }[] }
    // Gemini-style endpoints list ids with a "models/" prefix; strip it so
    // stored ids match what /chat/completions expects and selectors render
    // clean names.
    const models = [
      ...new Set((data.data ?? []).map((m) => (m.id ?? '').replace(/^models\//, '')).filter(Boolean).sort()),
    ]
    if (models.length === 0) return { ok: false, error: 'No model data in response' }
    void refreshModelCatalogIfStale()
    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
