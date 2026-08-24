/**
 * AnyBuff local/BYOK model resolution.
 *
 * Resolves an agent's requested model through anybuff.json routing
 * (modes → agents → defaultModel), then instantiates a direct
 * OpenAI-compatible or Anthropic-compatible language model using the
 * user's own credentials. There is no hosted inference fallback.
 *
 * Compatibility rules follow PLAN.md §9.2 ("只清除、不抑制"):
 * - Strip parameters a provider rejects (never degrade model behavior).
 * - Never actively suppress native reasoning.
 */

import {
  OpenAICompatibleChatLanguageModel,
  VERSION,
} from '@codebuff/llm-providers/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import { APICallError } from 'ai'

import { isTransientNetworkError } from '@codebuff/common/util/error'

import {
  DEFAULT_PROVIDER_COMPATIBILITY,
  loadProviderConfigSync,
  resolveConfiguredAgentModelConfig,
  resolveConfiguredProviderModel,
  resolveModelCapabilities,
} from '../provider-config'
import { resolveModelsToTry } from './failover'
import { getSystemProcessEnv } from '../env'

import type {
  AnybuffReasoningEffort,
  LoadedProviderConfig,
  ProviderCompatibility,
  ProviderConfig,
  ResolvedProviderModel,
} from '../provider-config'
import type { FetchFunction } from '@ai-sdk/provider-utils'
import type { LanguageModel } from 'ai'

/** Configured per-million-token pricing for cost-accounting fallback. */
export type ModelPricing = {
  inputPerMillionTokens?: number
  outputPerMillionTokens?: number
  cachedInputPerMillionTokens?: number
  currency?: string
}

/**
 * Host-injected API keys (ADR-12): providerId → apiKey. Takes priority over
 * process.env so plaintext keys never need to live in the environment where
 * agent-spawned child processes could read them.
 */
let injectedApiKeyOverrides: Record<string, string> | undefined

export function setProviderApiKeyOverrides(
  overrides: Record<string, string> | undefined,
): void {
  injectedApiKeyOverrides =
    overrides && Object.keys(overrides).length > 0 ? overrides : undefined
}

function resolveApiKey(
  providerId: string,
  provider: ProviderConfig,
): string | undefined {
  const override = injectedApiKeyOverrides?.[providerId]
  if (override) return override

  if (
    (provider.type === 'openai-compatible' ||
      provider.type === 'anthropic-compatible') &&
    provider.apiKeyEnv
  ) {
    return getSystemProcessEnv()[provider.apiKeyEnv]
  }
  return undefined
}

/**
 * Parameters for requesting a model.
 */
export interface ModelRequestParams {
  /** Legacy hosted-auth slot. Local BYOK routing does not require it. */
  apiKey?: string
  /** Model ID requested by an agent. Remapped by anybuff.json when omitted or overridden. */
  model?: string
  /** Agent ID requesting this model. Used for per-agent model overrides. */
  agentId?: string
  /** Routing cost mode. Accepted for caller compatibility; does not affect local resolution. */
  costMode?: string
  /** True when the prompt/message history contains image input parts. */
  requiresVision?: boolean
  /** When true, an explicit `model` wins over mode/agent/defaultModel routing. */
  preferModelParam?: boolean
  /** Per-call key injection (wins over module-level overrides and env). */
  apiKeyOverrides?: Record<string, string>
}

/**
 * Result from getModelForRequest.
 */
export interface ModelResult {
  model: LanguageModel
  compatibility: ProviderCompatibility
  reasoningEffort?: AnybuffReasoningEffort
  effectiveModel: string
  contextWindowTokens?: number
  pricing?: ModelPricing
}

/**
 * Notification hook kept for upstream caller compatibility. Local BYOK has no
 * free-mode capacity concept, so this only stores the listener.
 */
export type FreeModeCapacityDeferral = { retryAfterSeconds: number }

let freeModeCapacityDeferralListener:
  | ((deferral: FreeModeCapacityDeferral) => void)
  | null = null

export function setFreeModeCapacityDeferralListener(
  listener: ((deferral: FreeModeCapacityDeferral) => void) | null,
): void {
  freeModeCapacityDeferralListener = listener
}

export function selectAdaptiveReasoningEffort(params: {
  agentId?: string
  supported?: boolean
  efforts?: AnybuffReasoningEffort[]
}): AnybuffReasoningEffort | undefined {
  if (params.supported === false) return undefined
  const id = (params.agentId ?? '').toLowerCase()
  const preferred: AnybuffReasoningEffort =
    /thinker|debugger|reviewer|plan|base-deep|architect|integration-agent|performance-specialist|incident-coordinator|release-manager|docs-architect|evaluator/.test(
      id,
    )
      ? 'high'
      : /editor|test-writer|general-agent|base2|base$/.test(id)
        ? 'medium'
        : /file-picker|code-searcher|context-pruner|researcher|synthesizer/.test(
              id,
            )
          ? 'low'
          : 'medium'
  const efforts = params.efforts
  if (!efforts?.length) return params.supported ? preferred : undefined
  if (efforts.includes(preferred)) return preferred
  const order: AnybuffReasoningEffort[] = ['high', 'medium', 'low', 'minimal', 'none']
  return order.find((effort) => efforts.includes(effort))
}

// ============================================================================
// Compatibility rules (PLAN.md §9.2.1, verified 2026-08-23)
// ============================================================================

const COMPAT_LOG_PREFIX = '[anybuff-compat]'

function logCompat(rule: string, resolved: {
  providerId: string
  providerModel: string
}, detail: string): void {
  console.info(
    `${COMPAT_LOG_PREFIX} ${rule}: ${resolved.providerId}/${resolved.providerModel} — ${detail}`,
  )
}

/**
 * Endpoints that accept tool schemas but reject, hang on, or silently ignore
 * forced tool selection:
 * - deepseek: documented as supported, but thinking mode returns 400 and
 *   non-thinking truncates arguments (~48 tokens) as of 2026-07.
 * - glm: historical hangs on tool_choice:"required" (unverified recently).
 * - lmstudio / ollama: silently ignore "required", returning empty
 *   tool_calls with no error, which breaks agent loops undetectably.
 */
const REQUIRED_TOOL_CHOICE_DOWNGRADE_MODEL_PATTERN =
  /(^|[-_/])(deepseek|glm)([-_/]|$)/i

function shouldDowngradeRequiredToolChoice(params: {
  resolved: Pick<ResolvedProviderModel, 'providerId' | 'providerModel'>
  compatibility: Partial<ProviderCompatibility>
  body: Record<string, unknown>
}): boolean {
  if (params.body.tool_choice !== 'required') return false
  if (params.compatibility.supportsRequiredToolChoice === false) {
    return true
  }
  const matched = REQUIRED_TOOL_CHOICE_DOWNGRADE_MODEL_PATTERN.test(
    params.resolved.providerModel,
  )
  if (matched) {
    logCompat('tool_choice-required-downgrade', params.resolved, 'omitted')
  }
  return matched
}

function shouldStripStopSequences(params: {
  resolved: Pick<ResolvedProviderModel, 'providerId' | 'providerModel'>
  compatibility: Partial<ProviderCompatibility>
  body: Record<string, unknown>
}): boolean {
  if (!('stop' in params.body)) return false
  const strip = params.compatibility.supportsStopSequences === false
  if (strip) {
    logCompat('stop-strip', params.resolved, 'removed; enforced locally')
  }
  return strip
}

export function applyConfiguredProviderRequestCompatibility(
  body: Record<string, unknown>,
  resolved: Pick<ResolvedProviderModel, 'providerId' | 'providerModel'> & {
    compatibility?: Partial<ProviderCompatibility>
  },
): Record<string, unknown> {
  const compatibility = {
    ...DEFAULT_PROVIDER_COMPATIBILITY,
    ...(resolved.compatibility ?? {}),
  }

  // 只清除、不抑制: rejected parameters are removed, native reasoning is
  // never suppressed. Users who explicitly want thinking disabled can set
  // per-provider customBody (e.g. {"thinking": {"type": "disabled"}}).
  const downgradeToolChoice = shouldDowngradeRequiredToolChoice({
    resolved,
    compatibility,
    body,
  })
  const stripStopSequences = shouldStripStopSequences({
    resolved,
    compatibility,
    body,
  })

  if (!downgradeToolChoice && !stripStopSequences) {
    return body
  }

  const transformed: Record<string, unknown> = {
    ...body,
    ...(downgradeToolChoice ? { tool_choice: undefined } : {}),
  }

  if (stripStopSequences) {
    delete transformed.stop
  }

  return transformed
}

function createConfiguredProviderFetch(
  resolved: ResolvedProviderModel,
): FetchFunction | undefined {
  const inner = createRetryableNetworkErrorFetch(resolved)

  const customBody =
    resolved.provider.type === 'openai-compatible'
      ? (resolved.provider as { customBody?: Record<string, unknown> })
          .customBody
      : undefined

  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let transformedInit = init

    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        // Compat rules apply to EVERY request (PLAN §9.2): merge optional
        // per-provider customBody, then strip/downgrade rejected parameters.
        transformedInit = {
          ...init,
          body: JSON.stringify(
            applyConfiguredProviderRequestCompatibility(
              { ...(customBody ?? {}), ...body },
              resolved,
            ),
          ),
        }
      } catch {
        // If the body is not JSON, pass it through unchanged.
      }
    }

    return inner(input, transformedInit)
  }) as FetchFunction
}

/**
 * Wrap fetch so transient connection failures are rethrown as retryable
 * APICallErrors the AI SDK can absorb with its built-in backoff.
 */
function createRetryableNetworkErrorFetch(
  resolved: ResolvedProviderModel,
): FetchFunction {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    try {
      return await globalThis.fetch(input, init)
    } catch (error: unknown) {
      if (isTransientNetworkError(error)) {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        throw new APICallError({
          message: error instanceof Error ? error.message : String(error),
          cause: error,
          url,
          requestBodyValues: {},
          isRetryable: true,
        })
      }
      throw error
    }
  }) as FetchFunction
}

// ============================================================================
// Model instantiation
// ============================================================================

function createOpenAICompatibleHeaders(
  apiKey?: string,
): Record<string, string> {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    'user-agent': `ai-sdk/openai-compatible/${VERSION}/anybuff`,
  }
}

/**
 * Normalize an Anthropic baseURL per the Claude Code convention: a bare host
 * gets `/v1` appended; URLs that already carry a path segment stay untouched.
 */
export function normalizeAnthropicBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  const url = new URL(trimmed)
  const hasPathSegment = url.pathname !== '' && url.pathname !== '/'
  return hasPathSegment ? trimmed : `${trimmed}/v1`
}

function createConfiguredOpenAICompatibleModel(
  resolvedModel: ResolvedProviderModel,
): LanguageModel {
  const { providerId, provider, providerModel, apiKey } = resolvedModel
  if (provider.type !== 'openai-compatible') {
    throw new Error(
      `Provider '${providerId}' is not an OpenAI-compatible provider.`,
    )
  }
  const baseURL = provider.baseURL.replace(/\/$/, '')

  // Per-request usage accounting closure: capture OpenRouter-style cost
  // fields when the endpoint reports them so local runs can show real spend.
  const usageAccounting = {
    cost: null as number | null,
    upstreamInferenceCost: null as number | null,
  }

  return new OpenAICompatibleChatLanguageModel(providerModel, {
    provider: providerId,
    url: ({ path: endpoint }: { path: string }) => `${baseURL}${endpoint}`,
    headers: () => createOpenAICompatibleHeaders(apiKey),
    fetch: createConfiguredProviderFetch(resolvedModel),
    includeUsage: undefined,
    supportsStructuredOutputs: provider.supportsStructuredOutputs,
    stringifyTextContent: resolvedModel.compatibility.stringifyTextContent,
    enableThinking: provider.enableThinking,
    customBody: provider.customBody,
    metadataExtractor: {
      extractMetadata: async ({ parsedBody }: { parsedBody: any }) => {
        if (typeof parsedBody?.usage?.cost === 'number') {
          usageAccounting.cost = parsedBody.usage.cost
        }
        if (
          typeof parsedBody?.usage?.cost_details
            ?.upstream_inference_cost === 'number'
        ) {
          usageAccounting.upstreamInferenceCost =
            parsedBody.usage.cost_details.upstream_inference_cost
        }
        return {
          codebuff: {
            usage: {
              cost: usageAccounting.cost,
              costDetails: {
                upstreamInferenceCost: usageAccounting.upstreamInferenceCost,
              },
            },
          },
        }
      },
      createStreamExtractor: () => ({
        processChunk: (parsedChunk: any) => {
          if (typeof parsedChunk?.usage?.cost === 'number') {
            usageAccounting.cost = parsedChunk.usage.cost
          }
          if (
            typeof parsedChunk?.usage?.cost_details
              ?.upstream_inference_cost === 'number'
          ) {
            usageAccounting.upstreamInferenceCost =
              parsedChunk.usage.cost_details.upstream_inference_cost
          }
        },
        buildMetadata: () => ({
          codebuff: {
            usage: {
              cost: usageAccounting.cost,
              costDetails: {
                upstreamInferenceCost: usageAccounting.upstreamInferenceCost,
              },
            },
          },
        }),
      }),
    },
  })
}

function createConfiguredAnthropicModel(
  resolvedModel: ResolvedProviderModel,
): LanguageModel {
  const { providerId, provider, providerModel, apiKey } = resolvedModel
  if (provider.type !== 'anthropic-compatible') {
    throw new Error(
      `Provider '${providerId}' is not an Anthropic-compatible provider.`,
    )
  }

  const anthropic = createAnthropic({
    baseURL: normalizeAnthropicBaseURL(provider.baseURL),
    // Sent as the x-api-key header. Empty string instead of letting the SDK
    // fall back to ANTHROPIC_API_KEY for keyless local gateways.
    apiKey: apiKey ?? '',
    headers: {
      'user-agent': `ai-sdk/anthropic/${VERSION}/anybuff`,
    },
    name: providerId,
  })

  return anthropic(providerModel)
}

// ============================================================================
// Routing
// ============================================================================

type VisionSupport = 'yes' | 'no' | 'unknown'

function isLikelyVisionModelName(modelNames: string): boolean {
  return /(^|[-_/])(claude|gemini|gpt-4o|gpt-5|vision)([-_/.:]|$)/i.test(
    modelNames,
  )
}

function isLikelyNonVisionModelName(modelNames: string): boolean {
  return /(^|[-_/])(deepseek|qwen|kimi|minimax|glm|llama|mistral)([-_/.:]|$)/i.test(
    modelNames,
  )
}

function getModelVisionSupport(params: {
  configuredProviderModel: ResolvedProviderModel
  effectiveModel: string
  loadedConfig: LoadedProviderConfig
}): VisionSupport {
  const { configuredProviderModel, effectiveModel, loadedConfig } = params
  const capabilities = resolveModelCapabilities({
    providerId: configuredProviderModel.providerId,
    model: effectiveModel,
    loadedConfig,
  })

  if (capabilities.input?.image === true) return 'yes'
  if (capabilities.input?.image === false) return 'no'
  if (configuredProviderModel.provider.type === 'anthropic-compatible') {
    return 'yes'
  }

  const modelNames = [
    effectiveModel,
    configuredProviderModel.requestedModel,
    configuredProviderModel.providerModel,
  ].join(' ')
  if (isLikelyVisionModelName(modelNames)) {
    return 'yes'
  }
  if (isLikelyNonVisionModelName(modelNames)) {
    return 'no'
  }
  return 'unknown'
}

function getProviderRoutableModels(
  providerId: string,
  provider: ProviderConfig,
): string[] {
  if (Array.isArray(provider.models)) {
    return provider.models.map((model) => `${providerId}/${model}`)
  }

  return Object.keys(provider.models).map((model) =>
    model.startsWith(`${providerId}/`) ? model : `${providerId}/${model}`,
  )
}

function getVisionFallbackRank(model: string): number {
  if (/opus/i.test(model)) return 0
  if (/sonnet/i.test(model)) return 1
  if (/gpt-5/i.test(model)) return 2
  if (/gpt-4o/i.test(model)) return 3
  if (/gemini/i.test(model)) return 4
  if (/claude/i.test(model)) return 5
  return 10
}

function findProviderVisionFallback(params: {
  configuredProviderModel: ResolvedProviderModel
  loadedConfig: LoadedProviderConfig
}): string | undefined {
  const { configuredProviderModel, loadedConfig } = params
  const candidateProviderIds = [
    configuredProviderModel.providerId,
    ...Object.keys(loadedConfig.config.providers).filter(
      (id) => id !== configuredProviderModel.providerId,
    ),
  ]

  const candidates: { model: string; support: VisionSupport }[] = []
  for (const providerId of candidateProviderIds) {
    const provider = loadedConfig.config.providers[providerId]
    if (!provider) continue
    for (const candidate of getProviderRoutableModels(providerId, provider)) {
      // Soft-skip candidates whose providers are misconfigured (e.g. missing
      // key): one broken entry must not crash the whole fallback scan.
      let candidateProviderModel: ResolvedProviderModel | undefined
      try {
        candidateProviderModel = resolveConfiguredProviderModel({
          model: candidate,
          loadedConfig,
          apiKeyOverrides: injectedApiKeyOverrides,
        })
      } catch {
        continue
      }
      if (!candidateProviderModel) continue
      const support = getModelVisionSupport({
        configuredProviderModel: candidateProviderModel,
        effectiveModel: candidate,
        loadedConfig,
      })
      if (support === 'yes') {
        candidates.push({ model: candidate, support })
      }
    }
  }

  return candidates.sort(
    (left, right) =>
      getVisionFallbackRank(left.model) - getVisionFallbackRank(right.model),
  )[0]?.model
}

function resolveVisionModelIfNeeded(params: {
  configuredProviderModel: ResolvedProviderModel
  effectiveModel: string
  loadedConfig: LoadedProviderConfig
  reasoningEffort?: AnybuffReasoningEffort
}): {
  configuredProviderModel: ResolvedProviderModel
  effectiveModel: string
  reasoningEffort?: AnybuffReasoningEffort
} {
  const { configuredProviderModel, effectiveModel, loadedConfig } = params
  const visionSupport = getModelVisionSupport({
    configuredProviderModel,
    effectiveModel,
    loadedConfig,
  })
  if (visionSupport === 'yes') {
    return params
  }

  const visionModel =
    loadedConfig.config.visionModel ??
    findProviderVisionFallback({
      configuredProviderModel,
      loadedConfig,
    })
  if (!visionModel) {
    throw new Error(
      `Model '${effectiveModel}' ${
        visionSupport === 'no'
          ? 'is not image-capable'
          : 'is not annotated as image-capable'
      }, but this request contains image input. Configure visionModel in anybuff.json or route this agent to an image-capable model.`,
    )
  }

  const visionProviderModel = resolveConfiguredProviderModel({
    model: visionModel,
    loadedConfig,
    apiKeyOverrides: injectedApiKeyOverrides,
  })
  if (!visionProviderModel) {
    throw new Error(
      `Configured visionModel '${visionModel}' could not be routed to a provider. Add it to anybuff.json providers before sending image input.`,
    )
  }

  const fallbackVisionSupport = getModelVisionSupport({
    configuredProviderModel: visionProviderModel,
    effectiveModel: visionModel,
    loadedConfig,
  })
  if (fallbackVisionSupport === 'no') {
    throw new Error(
      `Configured visionModel '${visionModel}' is marked non-vision, but this request contains image input. Choose an image-capable model.`,
    )
  }

  return {
    configuredProviderModel: visionProviderModel,
    effectiveModel: visionModel,
    reasoningEffort:
      loadedConfig.config.visionReasoningEffort ?? params.reasoningEffort,
  }
}

/**
 * Resolve model capacity without constructing a provider client or touching
 * credentials. Used before the first LLM request so pruning and context-window
 * telemetry share the same BYOK capability source as the request path.
 */
export function resolveModelContextWindow(params: {
  agentId?: string
  model?: string
}): number | undefined {
  const loadedConfig = loadProviderConfigSync()
  const effectiveModel = resolveConfiguredAgentModelConfig({
    agentId: params.agentId,
    model: params.model,
    loadedConfig,
  }).model
  const windows = resolveModelsToTry(effectiveModel, loadedConfig).flatMap(
    (candidateModel) => {
      let configured: ResolvedProviderModel | undefined
      try {
        configured = resolveConfiguredProviderModel({
          model: candidateModel,
          loadedConfig,
          apiKeyOverrides: injectedApiKeyOverrides,
        })
      } catch {
        // Unresolvable candidate (missing key etc.) contributes no window.
        return []
      }
      if (!configured) return []
      const windowTokens = resolveModelCapabilities({
        providerId: configured.providerId,
        model: candidateModel,
        loadedConfig,
      })?.context?.windowTokens
      return typeof windowTokens === 'number' &&
        Number.isFinite(windowTokens) &&
        windowTokens > 0
        ? [windowTokens]
        : []
    },
  )
  return windows[0]
}

export function resolveModelContextWindows(params: {
  agentId?: string
  model?: string
}): { primary?: number; failoverFloor?: number } {
  const loadedConfig = loadProviderConfigSync()
  const effectiveModel = resolveConfiguredAgentModelConfig({
    agentId: params.agentId,
    model: params.model,
    loadedConfig,
  }).model
  const windows = resolveModelsToTry(effectiveModel, loadedConfig).flatMap(
    (candidateModel) => {
      let configured: ResolvedProviderModel | undefined
      try {
        configured = resolveConfiguredProviderModel({
          model: candidateModel,
          loadedConfig,
          apiKeyOverrides: injectedApiKeyOverrides,
        })
      } catch {
        return []
      }
      const value = configured
        ? resolveModelCapabilities({
            providerId: configured.providerId,
            model: candidateModel,
            loadedConfig,
          })?.context?.windowTokens
        : undefined
      return typeof value === 'number' && value > 0 ? [value] : []
    },
  )
  return {
    ...(windows[0] ? { primary: windows[0] } : {}),
    ...(windows.length > 0 ? { failoverFloor: Math.min(...windows) } : {}),
  }
}

/**
 * Get the appropriate model for a request.
 *
 * Resolves the requested agent model through anybuff.json, then routes to a
 * matching OpenAI-compatible or Anthropic-compatible provider using the
 * user's own credentials.
 */
export async function getModelForRequest(
  params: ModelRequestParams,
): Promise<ModelResult> {
  const { model, agentId, preferModelParam } = params

  if (params.apiKeyOverrides) {
    setProviderApiKeyOverrides(params.apiKeyOverrides)
  }
  const apiKeyOverrides = injectedApiKeyOverrides

  const loadedProviderConfig = loadProviderConfigSync()
  const effectiveAgentModelConfig = resolveConfiguredAgentModelConfig({
    agentId,
    model,
    loadedConfig: loadedProviderConfig,
    preferModelParam,
  })
  let effectiveModel = effectiveAgentModelConfig.model
  let reasoningEffort = effectiveAgentModelConfig.reasoningEffort

  let configuredProviderModel = resolveConfiguredProviderModel({
    model: effectiveModel,
    loadedConfig: loadedProviderConfig,
    apiKeyOverrides,
  })
  if (params.requiresVision && configuredProviderModel) {
    const visionRoute = resolveVisionModelIfNeeded({
      configuredProviderModel,
      effectiveModel,
      loadedConfig: loadedProviderConfig,
      reasoningEffort,
    })
    effectiveModel = visionRoute.effectiveModel
    reasoningEffort = visionRoute.reasoningEffort
    configuredProviderModel = visionRoute.configuredProviderModel
  }
  const resolvedCapabilities = configuredProviderModel
    ? resolveModelCapabilities({
        providerId: configuredProviderModel.providerId,
        model: effectiveModel,
        loadedConfig: loadedProviderConfig,
      })
    : undefined
  if (
    reasoningEffort === undefined &&
    loadedProviderConfig.config.adaptiveReasoning !== false
  ) {
    reasoningEffort = selectAdaptiveReasoningEffort({
      agentId,
      supported: resolvedCapabilities?.reasoning?.supported,
      efforts: resolvedCapabilities?.reasoning?.efforts,
    })
  }

  if (!configuredProviderModel) {
    throw new Error(
      `AnyBuff could not route model '${effectiveModel}'${
        agentId ? ` for agent '${agentId}'` : ''
      }. Add a provider mapping in anybuff.json or set ${'ANYBUFF_PROVIDER_CONFIG'}.`,
    )
  }

  // Post-resolution key injection wins over whatever env-based resolution found.
  const overrideKey = injectedApiKeyOverrides?.[configuredProviderModel.providerId]
  if (overrideKey) {
    configuredProviderModel = { ...configuredProviderModel, apiKey: overrideKey }
  }

  const contextWindowTokens = resolvedCapabilities?.context?.windowTokens
  const pricing = resolvedCapabilities?.pricing as ModelPricing | undefined

  if (configuredProviderModel.provider.type === 'anthropic-compatible') {
    return {
      model: createConfiguredAnthropicModel(configuredProviderModel),
      compatibility: configuredProviderModel.compatibility,
      reasoningEffort,
      effectiveModel,
      contextWindowTokens,
      pricing,
    }
  }

  return {
    model: createConfiguredOpenAICompatibleModel(configuredProviderModel),
    compatibility: configuredProviderModel.compatibility,
    reasoningEffort,
    effectiveModel,
    contextWindowTokens,
    pricing,
  }
}
