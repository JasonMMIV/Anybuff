import {
  LOCAL_MODE_USER_EMAIL,
  LOCAL_MODE_USER_ID,
} from '@codebuff/common/constants/local-mode'
import { env as clientEnvDefault } from '@codebuff/common/env'
import { getCiEnv } from '@codebuff/common/env-ci'
import { success } from '@codebuff/common/util/error'

import {
  localAddAgentStep,
  localFetchAgentFromDatabase,
  localFinishAgentRun,
  localGetUserInfoFromApiKey,
  localStartAgentRun,
} from './local-database'
import { promptAiSdk, promptAiSdkStream, promptAiSdkStructured } from './llm'
import { resolveModelContextWindow } from './model-provider'

import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
  WebSearchOptions,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { DatabaseAgentCache } from '@codebuff/common/types/contracts/database'
import type { ClientEnv } from '@codebuff/common/types/contracts/env'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { TraceWriter } from '@codebuff/common/types/contracts/trace'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'

const DATABASE_AGENT_CACHE_MAX_ENTRIES = 200

/** Insertion-order (FIFO) eviction so the cache can't grow without bound in
 *  long-lived processes (the desktop app runs the agent runtime in-process). */
class BoundedAgentCache extends Map<string, AgentTemplate | null> {
  override set(key: string, value: AgentTemplate | null): this {
    if (!this.has(key)) {
      while (this.size >= DATABASE_AGENT_CACHE_MAX_ENTRIES) {
        const oldestKey = this.keys().next().value
        if (oldestKey === undefined) break
        this.delete(oldestKey)
      }
    }
    return super.set(key, value)
  }
}

const databaseAgentCache: DatabaseAgentCache = new BoundedAgentCache()

/**
 * Local BYOK dependency table. There is no hosted backend: account lookups
 * return a synthetic local user, the remote agent registry is unreachable by
 * design (bundled + local .agents only), and run bookkeeping is local-only.
 */
export function getAgentRuntimeImpl(
  params: {
    logger?: Logger
    traceWriter?: TraceWriter
    apiKey: string
    clientEnv?: ClientEnv
    /** Web search provider config (AnyBuff BYOK seam). */
    webSearch?: WebSearchOptions
  } & Pick<
    AgentRuntimeScopedDeps,
    | 'handleStepsLogChunk'
    | 'requestToolCall'
    | 'requestMcpToolData'
    | 'requestFiles'
    | 'requestOptionalFile'
    | 'sendAction'
    | 'sendSubagentChunk'
  >,
): AgentRuntimeDeps & AgentRuntimeScopedDeps {
  const {
    logger,
    traceWriter,
    apiKey,
    clientEnv: clientEnvInput,
    webSearch,
    handleStepsLogChunk,
    requestToolCall,
    requestMcpToolData,
    requestFiles,
    requestOptionalFile,
    sendAction,
    sendSubagentChunk,
  } = params

  const trackSdkRuntimeEvent: TrackEventFn = () => {
    // Local BYOK ships no telemetry.
    return
  }

  return {
    // Environment
    clientEnv: clientEnvInput ?? clientEnvDefault,
    ciEnv: getCiEnv(),

    // Database (local stubs)
    getUserInfoFromApiKey: localGetUserInfoFromApiKey,
    fetchAgentFromDatabase: localFetchAgentFromDatabase,
    startAgentRun: localStartAgentRun,
    finishAgentRun: localFinishAgentRun,
    addAgentStep: localAddAgentStep,

    // Billing (no-op: the user pays their provider directly)
    consumeCreditsWithFallback: async () =>
      success({
        chargedToOrganization: false,
      }),

    // LLM
    promptAiSdkStream,
    promptAiSdk,
    promptAiSdkStructured,

    // Mutable State
    databaseAgentCache,

    // Analytics
    trackEvent: trackSdkRuntimeEvent,

    // Other
    logger: logger ?? noopLogger,
    traceWriter,
    fetch: globalThis.fetch,
    ...(webSearch !== undefined ? { webSearch } : {}),

    // Context window: provider-config aware (falls back to hardcoded budget)
    resolveContextWindow: (agentId, model) => resolveModelContextWindow({ agentId, model }),

    // Client callbacks (in-process; historically WebSocket seams)
    handleStepsLogChunk,
    requestToolCall,
    requestMcpToolData,
    requestFiles,
    requestOptionalFile,
    sendAction,
    sendSubagentChunk,


    apiKey,
  } satisfies AgentRuntimeDeps & AgentRuntimeScopedDeps
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
