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
  saveSearchApiKey,
  setWebSearchProvider,
  type ProviderConfig,
  type ReasoningEffort,
  type ApprovalMode,
  type AgentRoute,
  type WebSearchProviderId,
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

/** AnyBuff:saveSettings — persists provider/model/keys/routing/web-search prefs. */
export function saveSettings(payload: SaveSettingsPayload): unknown {
  updateProviders(payload.providers, payload.activeModel, payload.reasoningEffort, payload.approvalMode)
  if (payload.apiKeys) {
    for (const [id, key] of Object.entries(payload.apiKeys)) {
      if (key) saveProviderApiKey(id, key.trim())
    }
  }
  for (const id of payload.deleteKeys ?? []) {
    saveProviderApiKey(id, '')
  }
  if (payload.agentRouting) updateAgentRouting(payload.agentRouting)
  if (payload.webSearchProvider) setWebSearchProvider(payload.webSearchProvider)
  if (payload.searchApiKeys) {
    for (const [provider, key] of Object.entries(payload.searchApiKeys)) {
      if (key && (provider === 'tinyfish' || provider === 'firecrawl')) {
        saveSearchApiKey(provider, key.trim())
      }
    }
  }
  for (const provider of payload.deleteSearchKeys ?? []) {
    if (provider === 'tinyfish' || provider === 'firecrawl') saveSearchApiKey(provider, '')
  }
  return { ok: true, settings: getAppSettings() }
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
