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
  saveProviderApiKey,
  updateProviders,
  updateAgentRouting,
  updateRunGuardrails,
  saveSearchApiKey,
  setWebSearchProvider,
  type ProviderConfig,
  type ReasoningEffort,
  type ApprovalMode,
  type AgentRoute,
  type WebSearchProviderId,
  type RunCostMode,
} from '../settings/settings'
import { isRunning } from '../run/start-run'
import { getRunningTaskId } from '../sessions/session-store'

export interface SaveSettingsPayload {
  providers: ProviderConfig[]
  activeModel: string
  reasoningEffort: ReasoningEffort
  approvalMode: ApprovalMode
  apiKeys?: Record<string, string>
  deleteKeys?: string[]
  agentRouting?: Record<string, AgentRoute>
  webSearchProvider?: WebSearchProviderId
  searchApiKeys?: Partial<Record<WebSearchProviderId, string>>
  deleteSearchKeys?: WebSearchProviderId[]
  /** #17 per-run step cap (0 = SDK default) + cost mode flag. */
  maxAgentSteps?: number
  costMode?: RunCostMode
}

/** AnyBuff:getState */
export function getState(): unknown {
  const settings = getAppSettings()
  return {
    cwd: settings.cwd,
    settings,
    running: isRunning(),
    runningTaskId: getRunningTaskId(),
    agentIds: Object.keys(bundledAgents).sort(),
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
export function saveSettings(payload: SaveSettingsPayload): unknown {
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
  return { ok: true, ...(keyErrors.length > 0 ? { keyErrors } : {}), settings: getAppSettings() }
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
    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
