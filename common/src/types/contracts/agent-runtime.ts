import type { TrackEventFn } from './analytics'
import type { ConsumeCreditsWithFallbackFn } from './billing'
import type {
  HandleStepsLogChunkFn,
  RequestFilesFn,
  RequestMcpToolDataFn,
  RequestOptionalFileFn,
  RequestToolCallFn,
  SendActionFn,
  SendSubagentChunkFn,
} from './client'
import type {
  AddAgentStepFn,
  DatabaseAgentCache,
  FetchAgentFromDatabaseFn,
  FinishAgentRunFn,
  GetUserInfoFromApiKeyFn,
  StartAgentRunFn,
} from './database'
import type { ClientEnv, CiEnv } from './env'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredFn,
} from './llm'
import type { Logger } from './logger'
import type { TraceWriter } from './trace'

/** Selectable web search providers for the web_search tool (AnyBuff BYOK seam). */
export type WebSearchProviderId = 'duckduckgo' | 'firecrawl' | 'tinyfish'

/**
 * Host-injected web search configuration. Keys travel via the run-options
 * channel (ADR-12) — they must never be written to process.env.
 */
export type WebSearchOptions = {
  provider: WebSearchProviderId
  /** Tinyfish X-API-Key (required when provider is 'tinyfish'). */
  tinyfishApiKey?: string
  /** Firecrawl Bearer key; keyless works with lower per-IP limits. */
  firecrawlApiKey?: string
}

/** Shared dependencies */
export type AgentRuntimeDeps = {
  // Environment
  clientEnv: ClientEnv
  ciEnv: CiEnv

  // Database
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  fetchAgentFromDatabase: FetchAgentFromDatabaseFn
  startAgentRun: StartAgentRunFn
  finishAgentRun: FinishAgentRunFn
  addAgentStep: AddAgentStepFn

  // Billing
  consumeCreditsWithFallback: ConsumeCreditsWithFallbackFn

  // LLM
  promptAiSdkStream: PromptAiSdkStreamFn
  promptAiSdk: PromptAiSdkFn
  promptAiSdkStructured: PromptAiSdkStructuredFn

  // Mutable State
  databaseAgentCache: DatabaseAgentCache

  // Analytics
  trackEvent: TrackEventFn

  // Other
  logger: Logger
  /** Optional debug trace of agent message histories (see TraceWriter) */
  traceWriter?: TraceWriter
  fetch: typeof globalThis.fetch
  /** Web search provider config for the web_search tool. Optional —
   *  absent means DuckDuckGo defaults (upstream-compatible). */
  webSearch?: WebSearchOptions

  /**
   * Resolve the actual context window for a given agent/model from the
   * provider config. When provided, the context meter and pruner use the
   * real window instead of the hardcoded 250k/400k per-model budget.
   * Fallback: contextPrunerBudgetForModel(agentTemplate.model).
   */
  resolveContextWindow?: (agentId?: string, model?: string) => number | undefined
}

/** Per-run dependencies */
export type AgentRuntimeScopedDeps = {
  // Client (WebSocket)
  handleStepsLogChunk: HandleStepsLogChunkFn
  requestToolCall: RequestToolCallFn
  requestMcpToolData: RequestMcpToolDataFn
  requestFiles: RequestFilesFn
  requestOptionalFile: RequestOptionalFileFn
  sendAction: SendActionFn
  sendSubagentChunk: SendSubagentChunkFn

  apiKey: string
}
