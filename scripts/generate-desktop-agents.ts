#!/usr/bin/env bun
/**
 * Generate the desktop app's bundled agents from the upstream agents/
 * directory, with AnyBuff desktop patches baked in:
 *
 * 1. Ensure the base coding agents have the full working tool set
 *    (run_terminal_command / code_search / update_subgoal / think_deeply).
 *    Upstream routes shell work through subagents by default; a desktop
 *    one-window experience wants the root agent to run commands directly.
 * 2. Add native web_search to the primary coding agent (DuckDuckGo,
 *    built into agent-runtime, no key needed).
 * 3. Append prompt-discipline sections: git_status retry suppression and
 *    "invisible files" handling (context tree omits gitignored paths).
 * 4. Strip gravity_index (hosted ads-mesh tool; meaningless without the
 *    Freebuff backend).
 *
 * Output: desktop/src/main/agents/bundled-agents.ts (plain data module).
 */

import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.join(import.meta.dir, '..')
const AGENTS_DIR = path.join(ROOT, 'agents')
const OUT_FILE = path.join(
  ROOT,
  'desktop',
  'src',
  'main',
  'agents',
  'bundled-agents.ts',
)

// Agent modules import @codebuff/common which validates env at import time.
process.env.NEXT_PUBLIC_CB_ENVIRONMENT ||= 'test'
process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ||= 'http://localhost:3000'
process.env.NEXT_PUBLIC_WEB_PORT ||= '3000'
process.env.NEXT_PUBLIC_SUPPORT_EMAIL ||= 'support@anybuff.local'
process.env.NEXT_PUBLIC_POSTHOG_API_KEY ||= 'test-posthog-key'
process.env.NEXT_PUBLIC_POSTHOG_HOST_URL ||= 'https://us.i.posthog.com'
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ||= 'pk_test_placeholder'
process.env.NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL ||=
  'https://billing.stripe.com/p/login/test_placeholder'
process.env.NODE_ENV ||= 'test'

/** Base coding agents that get the full desktop tool surface. Superset —
 *  missing ids are skipped gracefully. */
const BASE_AGENT_IDS = [
  'base2',
  'base2-fast',
  'base2-fast-no-validation',
  'base2-plan',
  'base2-lite',
  'base2-max',
  'base-deep',
  'base3',
  'base-chat',
]

const EXTRA_TOOLS = [
  'run_terminal_command',
  'code_search',
  'update_subgoal',
  'think_deeply',
]

const GIT_DISCIPLINE = `# Git status discipline

If \`git_status\` reports that the current directory is not a git repository (e.g. \`fatal: not a git repository\`), do not call \`git_status\` again for the rest of this turn. Rely on the runtime-injected Git observation instead.`

const INVISIBLE_FILES_DISCIPLINE = `# Invisible files discipline

The file tree you see may omit files that actually exist on disk (for example paths filtered out of discovery for token economy). If the user references a file or directory that is absent from the file tree, do NOT claim it does not exist. First attempt \`read_files\` (or \`list_directory\` for folders) with the exact relative path the user provided; only report a file as missing after that direct read fails.`

type AgentDefinition = Record<string, any>

function getAllTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (
        entry.name === '__tests__' ||
        entry.name === 'node_modules' ||
        entry.name === 'types' ||
        entry.name === 'e2e'
      ) {
        continue
      }
      files.push(...getAllTsFiles(fullPath))
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('-evals.ts')
    ) {
      files.push(fullPath)
    }
  }
  return files
}

async function loadAgentDefinition(
  filePath: string,
): Promise<AgentDefinition | null> {
  try {
    const module = await import(filePath)
    const definition = module.default
    if (!definition || !definition.id || !definition.model) return null
    const processed: AgentDefinition = { ...definition }
    if (typeof processed.handleSteps === 'function') {
      processed.handleSteps = processed.handleSteps.toString()
    }
    return processed
  } catch (error) {
    console.error(
      `skip ${path.relative(ROOT, filePath)}: ${error instanceof Error ? error.message.split('\n')[0] : error}`,
    )
    return null
  }
}

function applyDesktopPatch(id: string, def: AgentDefinition): AgentDefinition {
  let patched = { ...def }

  // 4. Hosted ads-mesh tool is dead weight locally.
  if (Array.isArray(patched.toolNames)) {
    patched.toolNames = patched.toolNames.filter((t: string) => t !== 'gravity_index')
  }

  if (BASE_AGENT_IDS.includes(id)) {
    const toolNames: string[] = Array.isArray(patched.toolNames)
      ? [...patched.toolNames]
      : []

    // 1. Full working surface for the desktop root agent.
    for (const tool of EXTRA_TOOLS) {
      if (!toolNames.includes(tool)) toolNames.push(tool)
    }

    // 2. Native web search on the primary coding agents.
    if (!toolNames.includes('web_search')) toolNames.push('web_search')

    // 3. Prompt discipline sections.
    let systemPrompt =
      typeof patched.systemPrompt === 'string' ? patched.systemPrompt : ''
    if (systemPrompt && !systemPrompt.includes('not a git repository')) {
      systemPrompt = `${systemPrompt}\n\n${GIT_DISCIPLINE}`
    }
    if (!systemPrompt.includes('absent from the file tree')) {
      systemPrompt = `${systemPrompt}\n\n${INVISIBLE_FILES_DISCIPLINE}`
    }

    patched = { ...patched, toolNames, systemPrompt: systemPrompt || undefined }
  }

  return patched
}

async function main() {
  const files = getAllTsFiles(AGENTS_DIR)
  const bundled: Record<string, AgentDefinition> = {}
  const skipped: string[] = []

  for (const file of files.sort()) {
    const def = await loadAgentDefinition(file)
    if (!def || typeof def.id !== 'string') {
      skipped.push(path.relative(AGENTS_DIR, file))
      continue
    }
    if (bundled[def.id]) continue
    bundled[def.id] = applyDesktopPatch(def.id, def)
  }

  const count = Object.keys(bundled).length
  const body = JSON.stringify(bundled, null, 2)

  const out = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
 *
 * Generated by scripts/generate-desktop-agents.ts from the upstream
 * agents/ directory, with AnyBuff desktop patches baked in (see script
 * header). Regenerate: bun scripts/generate-desktop-agents.ts
 *
 * Generated at: ${new Date().toISOString()}
 * Agent count: ${count}
 */

export const bundledAgents: Record<string, any> = ${body};
`

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, out)
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)} (${count} agents)`)
  if (skipped.length) {
    console.log(`skipped ${skipped.length} files:`)
    for (const s of skipped) console.log(`  - ${s}`)
  }
  console.log(
    `patched base ids: ${BASE_AGENT_IDS.filter((id) => bundled[id]).join(', ')}`,
  )
}

main()
