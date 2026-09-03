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
import { getLastLocalAgents } from '../run/start-run'
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
