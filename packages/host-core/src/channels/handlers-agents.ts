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

export interface SkillInfo {
  name: string
  description: string
  path: string
  source: 'project' | 'home'
}

const SKILL_ROOTS = ['.agents', '.claude'] as const

function scanSkillRoot(dir: string, source: 'project' | 'home'): SkillInfo[] {
  const out: SkillInfo[] = []
  for (const rootName of SKILL_ROOTS) {
    const skillsDir = join(dir, rootName, 'skills')
    if (!existsSync(skillsDir)) continue
    let names: string[]
    try {
      names = (readdirSync(skillsDir, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[])
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const name of names) {
      const skillFile = join(skillsDir, name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      try {
        const content = readFileSync(skillFile, 'utf-8')
        const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        let description = ''
        if (fm) {
          const descMatch = fm[1].match(/^description:\s*(.+)$/m)
          description = descMatch ? descMatch[1].trim() : ''
        }
        out.push({ name, description, path: skillFile, source })
      } catch {
        // skip unreadable skill
      }
    }
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
