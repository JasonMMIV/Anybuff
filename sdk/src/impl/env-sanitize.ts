/**
 * ADR-12b: keep plaintext provider API keys out of agent-spawned child
 * processes. Terminal commands inherit the SDK process environment; without
 * this scrub a prompt-injected agent could exfiltrate every configured key
 * with a single `env` call, defeating DPAPI protection at the Desktop layer.
 *
 * Host-supplied run-level env values are NOT affected: they are merged after
 * the scrub by callers, so an explicit opt-out remains possible.
 */

import { loadProviderConfigSync } from '../provider-config'
import { getSystemProcessEnv } from '../env'

/** Well-known key variable names beyond whatever anybuff.json declares. */
const WELL_KNOWN_PROVIDER_KEY_ENV_VARS = [
  'ANYBUFF_API_KEY',
  'CODEBUFF_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'GLM_API_KEY',
  'ZHIPUAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'MOONSHOT_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
] as const

let cachedBlocklist: Set<string> | null = null

export function getProviderApiKeyEnvBlocklist(): Set<string> {
  if (cachedBlocklist) return cachedBlocklist
  const blocklist = new Set<string>(WELL_KNOWN_PROVIDER_KEY_ENV_VARS)
  try {
    const loaded = loadProviderConfigSync()
    for (const provider of Object.values(loaded.config.providers)) {
      if (
        (provider.type === 'openai-compatible' ||
          provider.type === 'anthropic-compatible') &&
        provider.apiKeyEnv
      ) {
        blocklist.add(provider.apiKeyEnv)
      }
    }
  } catch {
    // Config unavailable: static list still applies.
  }
  cachedBlocklist = blocklist
  return blocklist
}

/** Test/refresh hook: config edits should be visible on the next command. */
export function resetProviderApiKeyEnvBlocklist(): void {
  cachedBlocklist = null
}

export function omitProviderApiKeysFromEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const blocklist = getProviderApiKeyEnvBlocklist()
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (blocklist.has(key)) continue
    result[key] = value
  }
  return result
}

export function getScrubbedSystemProcessEnv(): NodeJS.ProcessEnv {
  return omitProviderApiKeysFromEnv(getSystemProcessEnv())
}
