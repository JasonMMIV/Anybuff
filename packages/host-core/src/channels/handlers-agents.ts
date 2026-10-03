/**
 * Custom-agent & skill handlers (AnyBuff:listLocalAgents / createLocalAgent /
 * deleteLocalAgent / readLocalAgentFile / saveLocalAgentFile / listSkills /
 * readSkillFile).
 *
 * listSkills/readSkillFile scan `.agents/skills` + `.claude/skills` — pure fs
 * logic that lived in the Electron shell and now moves to host-core so the
 * Android shell can surface skills too.
 */

import {
  loadProjectLocalAgents,
  createLocalAgent as createLocalAgentFn,
  deleteLocalAgent as deleteLocalAgentFn,
  readLocalAgentFile as readLocalAgentFileFn,
  saveLocalAgentFile as saveLocalAgentFileFn,
  type CreateLocalAgentInput,
} from '../agents/local-agents'
import { bundledAgents } from '../agents/bundled-agents'
import { AGENT_ID_FOR_MODE, buildAgentDefinitions, getLastLocalAgents } from '../run/start-run'
import type { MentionAgentInfo } from '../contracts/types'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  buildSkillDocument,
  deleteSkill,
  globalSkillRoots,
  importSkillFile,
  installSkill,
  saveSkillFile,
} from '../skills/install-skill'
import {
  downloadGithubSkill,
  listGithubSkills,
} from '../skills/github-skills'

export interface SkillInfo {
  name: string
  description: string
  path: string
  source: 'project' | 'home'
  /** Convention root the skill lives under. */
  root: '.agents' | '.claude'
  /** frontmatter metadata.source stamp (P2 provenance badge). */
  provenance?: string
}

const SKILL_ROOTS = ['.agents', '.claude'] as const

/** frontmatter `metadata.source` (P2 provenance badge) — block form only. */
function extractProvenance(fmBody: string): string | undefined {
  const lines = fmBody.split(/\r?\n/)
  const idx = lines.findIndex((l) => /^metadata:/.test(l))
  if (idx < 0) return undefined
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (!/^[ \t]/.test(line)) break // next top-level key
    const m = line.match(/^[ \t]+source:\s*(.+)$/)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return undefined
}

function scanSkillsDir(skillsDir: string, source: 'project' | 'home', root: '.agents' | '.claude'): SkillInfo[] {
  const out: SkillInfo[] = []
  if (!existsSync(skillsDir)) return out
  let names: string[]
  try {
    names = (readdirSync(skillsDir, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[])
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return out
  }
  for (const name of names) {
    const skillFile = join(skillsDir, name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    try {
      const content = readFileSync(skillFile, 'utf-8')
      const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      let description = ''
      let provenance: string | undefined
      if (fm) {
        const descMatch = fm[1].match(/^description:\s*(.+)$/m)
        description = descMatch ? descMatch[1].trim() : ''
        provenance = extractProvenance(fm[1])
      }
      out.push({
        name,
        description,
        path: skillFile,
        source,
        root,
        ...(provenance ? { provenance } : {}),
      })
    } catch {
      // skip unreadable skill
    }
  }
  return out
}

function scanSkillRoot(dir: string, source: 'project' | 'home'): SkillInfo[] {
  const out: SkillInfo[] = []
  for (const rootName of SKILL_ROOTS) {
    out.push(...scanSkillsDir(join(dir, rootName, 'skills'), source, rootName))
  }
  return out
}

/** AnyBuff:listSkills */
export function listSkills(cwd: string): SkillInfo[] {
  const project = scanSkillRoot(cwd, 'project')
  const home = scanSkillRoot(homedir(), 'home')
  return [...project, ...home]
}

/** AnyBuff:readSkillFile */
export function readSkillFile(path: string): unknown {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 200 * 1024) return { ok: false, error: 'Not a file or larger than 200KB' }
    return { ok: true, content: readFileSync(path, 'utf-8') }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** AnyBuff:listGlobalSkills — Skills page list: HOME roots only (no cwd
 *  dependency, so the tab works before a project is opened). */
export function listGlobalSkills(): SkillInfo[] {
  const out: SkillInfo[] = []
  for (const { root, dir } of globalSkillRoots()) {
    out.push(...scanSkillsDir(dir, 'home', root))
  }
  return out
}

/** AnyBuff:createSkill — form → composed SKILL.md → installSkill. */
export function createSkill(payload: {
  name: string
  description: string
  body: string
  confirm?: boolean
}): unknown {
  const content = buildSkillDocument(payload.name, payload.description ?? '', payload.body ?? '')
  return installSkill({ name: payload.name, content, confirm: payload.confirm, source: 'manual' })
}

/** AnyBuff:importSkillFile — picked markdown file → verbatim install. */
export function importSkillFileChannel(payload: { sourcePath: string; confirm?: boolean }): unknown {
  return importSkillFile(payload)
}

/** AnyBuff:saveSkillFile — edit an existing global skill (D6 gate host-side). */
export function saveSkillFileChannel(payload: { path: string; content: string }): unknown {
  return saveSkillFile(payload)
}

/** AnyBuff:deleteSkill — remove a global skill folder (D6 gate host-side). */
export function deleteSkillChannel(payload: { path: string }): unknown {
  return deleteSkill(payload)
}

/** AnyBuff:listGithubSkills — repo scan for skill folders (P1, async). */
export function listGithubSkillsChannel(payload: { repo?: string }): Promise<unknown> {
  return listGithubSkills(payload ?? {})
}

/** AnyBuff:downloadGithubSkill — whole-subfolder install (P1, async).
 *  Failure envelopes keep `exists` so the UI's overwrite-confirm works. */
export function downloadGithubSkillChannel(payload: {
  repo?: string
  path?: string
  confirm?: boolean
}): Promise<unknown> {
  return downloadGithubSkill(payload ?? {})
}

/** AnyBuff:listLocalAgents */
export async function listLocalAgents(cwd: string): Promise<unknown> {
  if (!cwd) return getLastLocalAgents()
  try {
    return await loadProjectLocalAgents(cwd)
  } catch (err) {
    return {
      agents: [],
      validationErrors: [{ agentId: '', filePath: '', message: err instanceof Error ? err.message : String(err) }],
    }
  }
}

/** Deliberate exclusion from the @-mention menu (upstream lists every
 *  spawnable): context-pruner is a zero-LLM maintenance routine spawned
 *  programmatically before each step and its UI activity is silenced
 *  (SILENT_AGENT_TYPES, maintenance ledger) — offering it as a pickable
 *  "agent" would only produce a no-op turn. */
const MENTION_HIDDEN_AGENT_IDS = new Set(['context-pruner'])

/**
 * AnyBuff:listMentionAgents — agents offered by the composer's @-mention menu,
 * mirroring the upstream CLI's `loadLocalAgents(agentMode)` semantics
 * (cli/src/utils/local-agent-registry.ts):
 *   - bundled agents are filtered to the current mode's ROOT spawnableAgents
 *     (so the menu never offers something the root cannot spawn),
 *   - `.agents/` local agents are always included and override bundled agents
 *     with the same id (buildAgentDefinitions already injects them into the
 *     coding roots' spawnableAgents — reusing the merged view keeps the menu
 *     and the run in lockstep),
 *   - sorted by displayName.
 * ADR-23: a pick only inserts `@agent-id ` into the draft — the ROOT stays
 * the mode's default agent and spawns the mentioned agent as a SUB-AGENT
 * ("Spawn mentioned agents"); there is no per-turn root override anymore.
 */
export async function listMentionAgents(cwd: string, mode?: 'default' | 'plan' | 'chat'): Promise<MentionAgentInfo[]> {
  const rootId = AGENT_ID_FOR_MODE[mode ?? 'default']
  // Reuse the run's merged definitions: custom ids are already appended to
  // the coding roots' spawnableAgents (chat is deliberately excluded — a
  // lightweight root must not gain full-access project agents, ADR-20).
  // Side effect (benign): this also refreshes the lastLocalAgents snapshot
  // the Settings panel reads — same cwd scan the panel itself performs.
  const { definitions } = await buildAgentDefinitions(cwd).catch(() => ({
    // Broken .agents/ load must never break the menu — fall back to the
    // bundled-only view (mirrors the run's own fallback to bundledAgents).
    definitions: bundledAgents,
  }))
  const spawnable = new Set(definitions[rootId]?.spawnableAgents ?? [])
  const out: MentionAgentInfo[] = []
  for (const [id, def] of Object.entries(definitions)) {
    if (!spawnable.has(id) || MENTION_HIDDEN_AGENT_IDS.has(id)) continue
    out.push({
      id,
      displayName: def?.displayName ?? id,
      description: typeof def?.spawnerPrompt === 'string' && def.spawnerPrompt ? def.spawnerPrompt : undefined,
    })
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'))
}

/** AnyBuff:createLocalAgent */
export function createLocalAgent(payload: CreateLocalAgentInput): unknown {
  return createLocalAgentFn(payload)
}

/** AnyBuff:deleteLocalAgent */
export function deleteLocalAgent(payload: { cwd: string; filePath?: string; id?: string }): unknown {
  return deleteLocalAgentFn(payload)
}

/** AnyBuff:readLocalAgentFile */
export function readLocalAgentFile(payload: { filePath: string }): unknown {
  return readLocalAgentFileFn(payload)
}

/** AnyBuff:saveLocalAgentFile */
export function saveLocalAgentFile(payload: { filePath: string; content: string }): unknown {
  return saveLocalAgentFileFn(payload)
}
