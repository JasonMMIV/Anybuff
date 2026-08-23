#!/usr/bin/env bun
/**
 * Headless end-to-end smoke test for the AnyBuff BYOK SDK.
 *
 * Usage:
 *   bun scripts/smoke-sdk.ts
 *
 * Required env — pick one provider flavor:
 *   OPENAI_API_KEY=sk-...                       (OpenAI or any OpenAI-compatible)
 *   ANTHROPIC_API_KEY=sk-ant-...                (Anthropic native)
 *
 * Optional env:
 *   SMOKE_BASE_URL  override baseURL (default https://api.openai.com/v1)
 *   SMOKE_MODEL     override model    (default gpt-4.1-mini / claude-haiku-4-5)
 *   ANYBUFF_SMOKE_KEY_ENV  name of the env var holding the key
 *                          (defaults: OPENAI_API_KEY / ANTHROPIC_API_KEY)
 *
 * Flow: writes a temp anybuff.json + demo project, injects the key through
 * the SDK keyMap channel (never process.env), runs base2 on a tiny task,
 * and asserts the file was actually edited.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const isAnthropic = !!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY
const keyEnvName =
  process.env.ANYBUFF_SMOKE_KEY_ENV ?? (isAnthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')
const apiKey = process.env[keyEnvName]

if (!apiKey) {
  console.error(`Missing ${keyEnvName}. Set it and re-run.`)
  process.exit(1)
}

const baseURL = process.env.SMOKE_BASE_URL ?? (isAnthropic
  ? 'https://api.anthropic.com'
  : 'https://api.openai.com/v1')
const model = process.env.SMOKE_MODEL ?? (isAnthropic
  ? 'claude-haiku-4-5'
  : 'gpt-4.1-mini')
const providerId = isAnthropic && !process.env.SMOKE_BASE_URL ? 'anthropic' : 'smoke'

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybuff-smoke-'))
const projectDir = path.join(workDir, 'project')
fs.mkdirSync(projectDir)

// --- demo project -------------------------------------------------------
const calcPath = path.join(projectDir, 'calculator.js')
fs.writeFileSync(
  calcPath,
  `function add(a, b) { return a + b }\nfunction divide(a, b) { return a / b }\n\nmodule.exports = { add, divide }\n`,
)

// --- provider config (anybuff.json) --------------------------------------
const configPath = path.join(workDir, 'anybuff.json')
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      defaultModel: `${providerId}/${model}`,
      providers: {
        [providerId]: isAnthropic && providerId === 'anthropic'
          ? {
              type: 'anthropic-compatible',
              baseURL,
              models: [model],
            }
          : {
              type: 'openai-compatible',
              baseURL,
              models: [model],
            },
      },
      approvalMode: 'allow-all',
    },
    null,
    2,
  ),
)
process.env.ANYBUFF_PROVIDER_CONFIG = configPath

// --- run ------------------------------------------------------------------
const { CodebuffClient } = await import('../sdk/src/index')
const { bundledAgents } = await import('../desktop/src/main/agents/bundled-agents')

const originalCalc = fs.readFileSync(calcPath, 'utf8')

console.log(`provider=${providerId} model=${model} base=${baseURL}`)
console.log('--- run start ---')

const client = new CodebuffClient({
  cwd: projectDir,
  apiKey: 'unused-local-byok', // hosted slot; routing uses the keyMap below
  agentDefinitions: Object.values(bundledAgents) as any,
})

let sawToolCall = false
try {
  const result = await client.run({
    agent: 'base2',
    prompt:
      'Add zero-division handling to the divide function in calculator.js: when b is 0 return null. Keep exports unchanged.',
    handleEvent: (event: any) => {
      const type = event?.type
      if (type === 'tool_call') {
        sawToolCall = true
        console.log(`[tool] ${event.toolName}`)
      } else if (type === 'finish') {
        console.log('[finish]')
      }
    },
    handleStreamChunk: (chunk: any) => {
      if (typeof chunk === 'string' && chunk.trim()) {
        process.stdout.write(chunk)
      }
    },
    apiKeyOverrides: { [providerId]: apiKey },
    maxAgentSteps: 12,
  })

  console.log('\n--- run end ---')
  const outputType = (result as any)?.output?.type
  console.log('output.type:', outputType)
  if ((result as any)?.output?.type === 'error') {
    console.error('run error:', (result as any).output.message ?? (result as any).output.value)
  }

  const after = fs.readFileSync(calcPath, 'utf8')
  const modified = after !== originalCalc
  const mentionsZero = /null/.test(after) && /b/.test(after)

  console.log('tool calls observed:', sawToolCall)
  console.log('file modified:', modified, '| zero-guard present:', mentionsZero)
  if (outputType === 'error' || !modified || !mentionsZero) {
    console.error('\nSMOKE FAILED')
    console.error('--- calculator.js after ---\n' + after)
    process.exit(1)
  }
  console.log('\nSMOKE OK')
} catch (error) {
  console.error('\nSMOKE THREW:', error instanceof Error ? error.stack : error)
  process.exit(1)
}
