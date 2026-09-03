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
 * 4. Strip gravity_index everywhere (hosted ads-mesh tool; meaningless
 *    without the Freebuff backend) — toolNames AND the prompt copy that
 *    tells agents to reach for it.
 * 5. Scrub Codebuff/Freebuff product meta copy (credits /usage codebuff.com
 *    mode picker) from prompts — none of it exists in AnyBuff, which is BYOK
 *    with model routing from anybuff.json. Keep the "Buffy" persona; drop
 *    every Codebuff/Freebuff platform reference.
 * 6. Drop agents that are pure Freebuff-web product surface (base-chat) —
 *    REVERTED by patch #7 below, which instead re-bundles base-chat as the
 *    AnyBuff "Chat" mode root with a lightweight AnyBuff tool surface.
 * 7. AnyBuff Chat root (base-chat): a third UI mode ('chat') runs the upstream
 *    conversational agent with no filesystem. Re-surface it into the bundle
 *    with an AnyBuff surface — web_search / read_url / render_ui /
 *    spawn_agents, spawnable researcher-web / thinker / context-pruner,
 *    rewritten Buffy prompts, and compactContext (base3-style mechanical
 *    compaction keyed to the routed model) instead of upstream's handleSteps
 *    Freebuff context-window table. (suggest_followups is left out: the SDK
 *    followups policy strips it from every agent unless ANYBUFF_FOLLOWUPS=1.)
 *
 * Only this file's generator output reaches the desktop bundle; upstream
 * agents/ stays untouched (upstream-mergeable, ADR-1/ADR-6).
 *
 * Output: desktop/src/main/agents/bundled-agents.ts (plain data module).
 */

import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.join(import.meta.dir, '..')
const AGENTS_DIR = path.join(ROOT, 'agents')
// ADR-21: bundled agents moved into the shared host-core package so the
// Electron shell and the Android proot-Node shell consume the same artifact.
const OUT_FILE = path.join(
  ROOT,
  'packages',
  'host-core',
  'src',
  'agents',
  'bundled-agents.ts',
)

/** Base coding agents that get the full desktop tool surface. Superset —
 *  missing ids are skipped gracefully. NOTE: base-chat is deliberately NOT
 *  here — it is a Freebuff web-chat root (see BUNDLE_EXCLUDED_AGENT_IDS). */
const BASE_AGENT_IDS = [
  'base2',
  'base2-fast',
  'base2-fast-no-validation',
  'base2-plan',
  'base2-lite',
  'base2-max',
  'base-deep',
  'base3',
]

/** Agents whose prompts get the AnyBuff BYOK rewrite (patch #5). Superset of
 *  BASE_AGENT_IDS plus the single-loop variants that also bake in
 *  Codebuff/Freebuff meta copy (base3-lite) plus the AnyBuff Chat root
 *  (base-chat, patch #7 — its prompts are additionally wholesale-replaced
 *  by the Chat-specific constants below). */
const META_SCRUB_IDS = new Set([
  ...BASE_AGENT_IDS,
  'base3-lite',
  'base-chat',
])

/** The AnyBuff Chat-mode root: the upstream freebuff.com/chat conversational
 *  agent (base-chat), which runs with no filesystem. */
const CHAT_ROOT_IDS = new Set(['base-chat'])

/** Lightweight tool surface for the Chat root: conversation + live lookup
 *  only. No file tools (read_files/str_replace/write_file), no gravity_index
 *  (hosted ads-mesh, patch #4). web_search/read_url let Chat answer directly
 *  instead of forcing a researcher spawn on every question. suggest_followups
 *  is deliberately absent: the SDK followups policy strips it from every agent
 *  unless ANYBUFF_FOLLOWUPS=1, so Chat keeps no dead-end instruction. */
const CHAT_TOOLS = [
  'web_search',
  'read_url',
  'render_ui',
  'spawn_agents',
]

/** Chat root spawns only the agents it actually needs for Q&A + lookups. */
const CHAT_SPAWNABLE_AGENTS = ['researcher-web', 'thinker', 'context-pruner']

const ANYBUFF_CHAT_SYSTEM_PROMPT = `You are Buffy, the AI coding assistant behind AnyBuff. You are chatting with a user in the AnyBuff desktop app, which renders markdown.

Current date: {CODEBUFF_CURRENT_DATE}.

This is Chat mode: you have no file tools, so you cannot browse, read, or edit the user's files on your own — you answer questions, explain concepts, and look things up. You can only see content the user explicitly pastes or attaches into the conversation. If a request needs the user's actual project files (reading, editing, running commands), say so briefly and suggest they switch to Build mode.`

const ANYBUFF_CHAT_INSTRUCTIONS = `Be direct and helpful. Use markdown when it improves clarity (code blocks, lists, tables), and keep answers as short as they can be while fully answering the question.

You can search the live internet yourself with the web_search tool (and follow promising pages with read_url). Prefer searching directly for quick lookups. For deeper or source-backed research, spawn the researcher-web agent; for library/API documentation questions, spawn researcher-web or researcher-docs. Give a focused question; you can spawn several in parallel for independent questions. After it reports back, answer the user in your own words and cite source URLs when useful. Don't spawn a researcher for questions you can already answer well (general knowledge, coding help, writing, math).

Whenever a question needs real reasoning, spawn the thinker agent and let it do the thinking — do not reason it out yourself in your reply. This is your default for anything beyond a quick lookup: math or logic problems, puzzles, debugging, code design, architecture and trade-off decisions, planning, comparisons, "why/how" explanations, estimates, or any multi-step question. When in doubt, spawn the thinker. It sees the full conversation, including everything your tools returned, so give it a short, focused prompt naming the problem. Wait for its conclusion, then write the final answer to the user in your own words. Skip the thinker only for trivial, purely factual, or conversational messages (greetings, simple definitions, quick lookups) where there is nothing to reason about.

Never spawn the context-pruner agent: it is spawned automatically for you before each step.`

/** Agents that are pure upstream Freebuff product surface, useless in the
 *  AnyBuff desktop (BYOK; no hosted backend). Excluded from the bundle —
 *  upstream files stay on disk for ADR-1 mergeability.
 *
 * base-chat was once excluded here; patch #7 re-bundles it as the AnyBuff
 * "Chat" mode root (UI mode 'chat' → AGENT_ID_FOR_MODE['chat'] = 'base-chat'
 * in desktop/src/main/start-run.ts), so the set is currently empty by design.
 */
const BUNDLE_EXCLUDED_AGENT_IDS = new Set<string>([])

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

/** The "Research services before recommending them" gravity_index guidance
 *  bullet start, which base2/base3 bake into their prompts. Replaced by
 *  ANYBUFF_RESEARCH_RULE (patch #5) when the bullet advertises gravity_index. */
const GRAVITY_BULLET_START =
  '- **Research services before recommending them:**'

/** AnyBuff replacement for the gravity_index research bullet: BYOK, so a
 *  third-party service choice is grounded in live research (researcher-web /
 *  researcher-docs) rather than the hosted ads-mesh. */
const ANYBUFF_RESEARCH_RULE = `- **Research services before recommending them:** Whenever the user needs to choose or integrate a third-party developer service (database, auth, payments, hosting, email, cache, monitoring, analytics, AI, storage, CMS, search, etc.), don't recommend or integrate one from memory alone. Research it instead: spawn the researcher-web / researcher-docs agents for current, source-backed guidance, and only then make a recommendation.`

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

/** Collapse runs of blank lines / trailing spaces left by deletions. */
function tidyPrompt(prompt: string): string {
  return prompt
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** True when a bullet starts with the given literal at this line start. */
function isBullet(line: string, bulletStart: string): boolean {
  return (
    line.startsWith(bulletStart) ||
    line.startsWith(`- ${bulletStart}`) ||
    line.startsWith(bulletStart.trimStart())
  )
}

/**
 * Patch #7: rewrite the Chat-mode root (base-chat) for the AnyBuff desktop.
 * The upstream agent is freebuff.com/chat product surface: Freebuff identity,
 * gravity_index guidance, no direct web_search. AnyBuff Chat runs on the
 * user's own model (anybuff.json defaultModel — 'base-chat' is not a provider
 * mode id, so mode/agent/defaultModel routing lands on defaultModel) and
 * answers directly with web_search/read_url.
 */
function applyChatRootPatch(id: string, def: AgentDefinition): AgentDefinition {
  let patched: AgentDefinition = { ...def }
  // handleSteps in upstream base-chat carries a Freebuff-only context-window
  // table (minimax/stealth/ox-alpha…). AnyBuff chat mirrors the desktop's
  // base3 roots instead: compactContext:true → mechanical compaction keyed to
  // the routed model's window. Drop handleSteps so no Freebuff table ships.
  delete patched.handleSteps
  patched = {
    ...patched,
    // 'base-chat' is not a provider mode id, so BYOK mode/agent/defaultModel
    // routing lands on the user's defaultModel — the baked model here is never
    // authoritative (resolveConfiguredAgentModelConfig uses it only as a
    // last-resort fallback when no defaultModel exists). It must still be a
    // valid string: the shared DynamicAgentDefinitionSchema requires
    // model: z.string(), and the desktop validates EVERY bundled agent on
    // every run — a missing model fails schema validation for all modes.
    // Upstream ships deepseek-v4-flash here; keep it purely as the
    // schema/budget heuristic (context-window sizing + cache-control checks),
    // never as the request model. Do NOT list this id in docs/config examples
    // as "the Chat model" — Chat runs on whatever defaultModel the user
    // configures.
    model: 'deepseek/deepseek-v4-flash',
    // The upstream spawnerPrompt is Freebuff-web product surface
    // ("freebuff.com/chat"); replace with the AnyBuff Chat-mode description.
    spawnerPrompt:
      'Lightweight Q&A in the AnyBuff desktop app: answers questions and looks things up, no file access.',
    displayName: 'Buffy Chat',
    compactContext: true,
    systemPrompt: ANYBUFF_CHAT_SYSTEM_PROMPT,
    instructionsPrompt: ANYBUFF_CHAT_INSTRUCTIONS,
    toolNames: [...CHAT_TOOLS],
    spawnableAgents: [...CHAT_SPAWNABLE_AGENTS],
  }
  return patched
}

function applyDesktopPatch(id: string, def: AgentDefinition): AgentDefinition {
  let patched = { ...def }

  // 7. AnyBuff Chat root: wholesale AnyBuff rewrite before the generic scrub
  //    (which then no-ops on the already-clean Chat copy, but keeps the
  //    identity/prompt guarantees uniform).
  if (CHAT_ROOT_IDS.has(id)) {
    patched = applyChatRootPatch(id, patched)
  }

  // 4. Hosted ads-mesh tool is dead weight locally: drop from toolNames and
  //    scrub the prompt copy that tells agents to reach for it.
  if (Array.isArray(patched.toolNames)) {
    patched.toolNames = patched.toolNames.filter((t: string) => t !== 'gravity_index')
  }

  // 5. Scrub Freebuff/Codebuff product meta copy + gravity guidance.
  if (META_SCRUB_IDS.has(id)) {
    patched.systemPrompt = scrubPromptCopy(patched.systemPrompt)
    if (typeof patched.instructionsPrompt === 'string') {
      patched.instructionsPrompt = scrubPromptCopy(patched.instructionsPrompt)
    }
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
/**
 * Patch #5: rewrite a systemPrompt / instructionsPrompt for AnyBuff BYOK.
 *
 * A per-line state machine that handles the real copy variants without
 * depending on every possible literal:
 *
 * 1. The "Research services before recommending them" gravity bullet is
 *    replaced by ANYBUFF_RESEARCH_RULE when it advertises gravity_index;
 *    any other line mentioning gravity_index is dropped.
 * 2. From a "# Codebuff Meta-information" header to the next "# " section
 *    header (or end) is removed entirely — that whole block is Codebuff
 *    product meta that does not exist in AnyBuff (modes, credits, /usage,
 *    codebuff.com docs).
 * 3. Product-identity sentences ("behind the product, Codebuff", "behind
 *    Freebuff", "made by Freebuff") are rewritten to the AnyBuff identity.
 *
 * The tool itself stays in toolNames-adjacent render/history plumbing
 * (context-pruner's handleSteps summarizeToolCall case, start-run.ts,
 * ChatMessage.tsx) untouched — that is historical-transcript support.
 */
function scrubPromptCopy(prompt: string | undefined): string | undefined {
  if (typeof prompt !== 'string') return prompt

  const lines = prompt.split('\n')
  const out: string[] = []
  let inMetaBlock = false

  for (const line of lines) {
    // Leave the section: drop the header, then everything until next "# ".
    if (inMetaBlock) {
      if (line.startsWith('# ') && !line.startsWith('# Codebuff Meta-information')) {
        inMetaBlock = false
        // fall through and keep this next header line
      } else {
        continue
      }
    }
    if (line.startsWith('# Codebuff Meta-information')) {
      inMetaBlock = true
      continue
    }
    // gravity_index: replace the research bullet; drop any other mention.
    if (line.includes('gravity_index')) {
      if (isBullet(line, GRAVITY_BULLET_START)) {
        out.push(ANYBUFF_RESEARCH_RULE)
      }
      // Non-bullet mention: skip entirely (dead copy pointing at a tool we
      // removed from toolNames).
      continue
    }
    // Codebuff-cost/productization sentences that made sense only in the
    // metered Codebuff product (base-deep carries one in "Other response
    // guidelines"). No credits ledger exists in AnyBuff.
    if (
      /at the cost of more credits used/.test(line) ||
      /considers the cost of credits/.test(line)
    ) {
      continue
    }
    // Product identity → AnyBuff. Replace the brand phrase, and (when the
    // sentence goes on to describe the *product* as a "(CLI) tool") rewrite
    // the whole sentence so AnyBuff (a desktop app) isn't misdescribed.
    if (
      line.includes('behind the product, Codebuff') ||
      line.includes('behind the product, Freebuff') ||
      line.includes('behind Codebuff') ||
      line.includes('behind Freebuff') ||
      line.includes('made by Freebuff') ||
      /^You are (?:Freebuff|Codebuff) Chat/.test(line)
    ) {
      let rewritten = line
        .replace(/the AI agent behind the product, (?:Codebuff|Freebuff)/g, 'the AI coding assistant behind AnyBuff')
        .replace(/the AI agent behind (?:Codebuff|Freebuff)/g, 'the AI coding assistant behind AnyBuff')
        .replace(/the coding agent behind (?:Codebuff|Freebuff)/g, 'the coding agent behind AnyBuff')
        .replace(/^You are (?:Freebuff|Codebuff) Chat[^.]*\./, 'You are Buffy, the AI coding assistant behind AnyBuff.')
      rewritten = rewritten.replace(
        /, a (?:CLI )?tool where users can chat with you to code with AI\./,
        '.',
      )
      // A bare "behind Codebuff" first line with no product description stays
      // as-is (it now reads "behind AnyBuff"); only rewrite when the sentence
      // was a full product-identity sentence.
      out.push(rewritten)
      continue
    }
    out.push(line)
  }

  return tidyPrompt(out.join('\n'))
}

async function main() {
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
    // Patch #6: keep Freebuff-web-only product roots out of the desktop app.
    // The exclusion set is intentionally EMPTY since patch #7 re-bundles
    // base-chat as the AnyBuff Chat root — it stays as a guard should another
    // Freebuff-web-only root appear upstream.
    if (BUNDLE_EXCLUDED_AGENT_IDS.has(def.id)) {
      console.log(`excluded from bundle: ${def.id}`)
      continue
    }
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
  console.log(
    `chat root ids: ${Array.from(CHAT_ROOT_IDS).filter((id) => bundled[id]).join(', ') || 'none'}`,
  )
}

main()
