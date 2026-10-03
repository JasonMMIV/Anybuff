/**
 * Global-skills install/edit/delete helpers (skills plan D3/D6).
 *
 * One implementation shared by the three install paths (form create / file
 * import / GitHub download) so the validation chain — name regex → full
 * frontmatter parse → containment → exists-confirm → ADR-13 atomic write —
 * can only ever be exercised in one place.
 *
 * Scope gate (D6): saveSkillFile / deleteSkill refuse unless the shell
 * declared `globalSkillsScope: 'managed'` (Android rootfs). Desktop declares
 * 'shared' — its ~/.agents/skills is the cross-tool convention directory
 * (Claude Code, `npx skills add`, …), so AnyBuff keeps it read-only. The gate
 * lives HOST-side on purpose: channels are the boundary, a renderer that
 * merely hides buttons must never be the enforcement layer. Absent scope
 * defaults to 'shared' (fail-safe — see HostEnv.globalSkillsScope).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import {
  isValidSkillName,
  SKILL_FILE_NAME,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from '@codebuff/common/constants/skills'
import { parseSkillFileContent } from '@codebuff/common/util/parse-skill'
import { writeFileAtomic } from '../files/atomic-write'
import { globalSkillsScope, hostPaths } from '../env'

/** Upper bound for a single SKILL.md (mirrors readSkillFile's 200KB cap). */
const MAX_SKILL_BYTES = 200 * 1024

/** Where an installed skill came from (skills plan P2 provenance). Stamped
 *  into frontmatter `metadata.source` by installSkill so the list can show a
 *  badge and a planted skill is distinguishable (risk R1). */
export type SkillInstallSource = 'manual' | 'file' | 'github'

export interface GlobalSkillRoot {
  /** Convention root the skill lives under. */
  root: '.agents' | '.claude'
  /** Absolute `<home>/<root>/skills` directory (may not exist yet). */
  dir: string
}

/**
 * The two global skill roots under the shell-declared home dir. Single source
 * of truth for list/install/edit/delete — every path check in this module
 * resolves against these exact directories.
 *
 * Install target is always the `.agents` root (the cross-tool convention dir;
 * `.claude/skills` is scan-only, matching upstream loaders).
 */
export function globalSkillRoots(): GlobalSkillRoot[] {
  const home = hostPaths().homeDir
  return [
    { root: '.agents', dir: join(home, '.agents', 'skills') },
    { root: '.claude', dir: join(home, '.claude', 'skills') },
  ]
}

/** Strict descendant check: `target` must live inside `root` (no `..`, no self). */
function isInside(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  return t !== r && t.startsWith(r + sep)
}

/** The D6 gate. Returns an envelope when mutation is not allowed, else null. */
function managedGate(): { ok: false; error: string } | null {
  if (globalSkillsScope() === 'managed') return null
  return {
    ok: false,
    error:
      'This skills directory is shared with other tools on this machine, so AnyBuff keeps it read-only. Make changes in your file manager or in the other tool.',
  }
}

/**
 * Build a SKILL.md document from form inputs (createSkill path). The
 * description is clamped to the schema cap so the written file and the
 * loader's view of it agree.
 */
export function buildSkillDocument(name: string, description: string, body: string): string {
  const desc = description.trim().slice(0, SKILL_DESCRIPTION_MAX_LENGTH)
  return `---\nname: ${name}\ndescription: ${yamlScalar(desc)}\n---\n\n${body.trim()}\n`
}

/**
 * Emit `value` as a YAML scalar: plain when that is unambiguous, JSON-quoted
 * otherwise (JSON string literals are valid YAML double-quoted scalars, so
 * colons/#/quotes in a description never corrupt the frontmatter).
 */
function yamlScalar(value: string): string {
  const plainSafe = /^[A-Za-z0-9][\w\s.,()'"!/?-]*$/.test(value) && !value.includes(': ')
  return plainSafe ? value : JSON.stringify(value)
}

/**
 * Best-effort extraction of the frontmatter `name` from a raw SKILL.md
 * (import path: the folder name is derived FROM the file, so we need the name
 * before we can run the full parse — which itself requires directoryName).
 * The extracted candidate is then fully validated by parseSkillFileContent.
 */
export function extractSkillName(content: string): string | null {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return null
  const m = fm[1].match(/^name:\s*(.+)$/m)
  if (!m) return null
  return m[1].trim().replace(/^["']|["']$/g, '')
}

/**
 * Safety line for multi-file installs (GitHub download, plan D3 #6): a
 * repo-relative path must be a plain forward-slash subpath — no `..`, no
 * absolute form, no backslashes, and no `:` (Windows alternate data streams).
 * Rejected paths abort the whole install (never skipped silently).
 */
export function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes(':')) return false
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false
  }
  return true
}

/**
 * Stamp frontmatter `metadata` with provenance (P2): `source` + `installedAt`.
 *
 * Pure text surgery (no YAML round-trip — the rest of the document, comments
 * and key order included, must stay byte-identical). Returns null when the
 * document has no frontmatter or `metadata:` uses a form we cannot extend
 * safely (inline flow map / block scalar); callers then fall back to the
 * original content, because provenance must never block an install.
 */
function injectProvenance(content: string, source: SkillInstallSource): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = m[1].split(/\r?\n/)
  const installedAt = new Date().toISOString()

  const idx = lines.findIndex((l) => /^metadata:/.test(l))
  if (idx < 0) {
    // New block at zero indent — safely terminates any preceding indented block.
    lines.push('metadata:', `  source: ${source}`, `  installedAt: ${installedAt}`)
  } else {
    const head = lines[idx].slice('metadata:'.length).trim()
    // `metadata: {…}` / `metadata: >-` etc. — not a plain block we can extend.
    if (head !== '' && !head.startsWith('#')) return null
    let end = idx + 1
    while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end++
    const firstChild = lines.slice(idx + 1, end).find((l) => l.trim() !== '')
    const pad = ' '.repeat(Math.max(firstChild ? firstChild.match(/^[ \t]*/)![0].length : 2, 1))
    // Replace existing keys in place… (indices stay valid — no splices yet)
    let sawSource = false
    let sawInstalledAt = false
    for (let i = idx + 1; i < end; i++) {
      if (lines[i].startsWith(`${pad}source:`)) {
        lines[i] = `${pad}source: ${source}`
        sawSource = true
      } else if (lines[i].startsWith(`${pad}installedAt:`)) {
        lines[i] = `${pad}installedAt: ${installedAt}`
        sawInstalledAt = true
      }
    }
    // …then insert the missing ones right under the key (old edits travel with
    // their elements through the splice).
    const missing: string[] = []
    if (!sawSource) missing.push(`${pad}source: ${source}`)
    if (!sawInstalledAt) missing.push(`${pad}installedAt: ${installedAt}`)
    if (missing.length > 0) lines.splice(idx + 1, 0, ...missing)
  }
  return `---${eol}${lines.join(eol)}${eol}---${content.slice(m[0].length)}`
}

export interface InstallSkillInput {
  /** Candidate skill name (form value, or extracted from the document). */
  name: string
  /** FULL SKILL.md document to write (createSkill composes it; import/github pass the file verbatim). */
  content: string
  /** Re-install over an existing skill (UI confirmed). */
  confirm?: boolean
  /** Provenance (P2): stamped into frontmatter `metadata.source` when the
   *  stamped document still validates; otherwise the original is written. */
  source?: SkillInstallSource
}

export type InstallSkillResult =
  | { ok: true; name: string; path: string }
  | { ok: false; exists?: boolean; error: string }

/**
 * Install one SKILL.md into `<home>/.agents/skills/<name>/` (ADR-13 atomic).
 *
 * Validation order (fail fast, never leaves a half-written skill):
 *   1. name regex (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64)
 *   2. full document parse — frontmatter schema + name MUST equal the folder
 *      name (parseSkillFileContent's contract; keeps loader keys addressable)
 *   3. containment under the `.agents` root (defense in depth past the regex)
 *   4. exists (a real SKILL.md, not merely a same-named folder) →
 *      `{exists: true}` unless `confirm` (overwrite = whole-file atomic
 *      replace, same as pasting over a file in a file manager). A leftover
 *      empty folder — user-created or from a failed write — is not a skill
 *      and must not demand a confirm for one.
 */
export function installSkill(input: InstallSkillInput): InstallSkillResult {
  const { name, content, confirm, source } = input

  if (!isValidSkillName(name)) {
    return {
      ok: false,
      error: `Invalid skill name "${name}": use 1-64 lowercase letters, digits, and single hyphens (no leading/trailing hyphen).`,
    }
  }
  if (content.length === 0) {
    return { ok: false, error: 'Empty skill file.' }
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_SKILL_BYTES) {
    return { ok: false, error: 'Skill file is larger than 200KB.' }
  }

  const root = globalSkillRoots()[0]
  const dir = join(root.dir, name)
  const filePath = join(dir, SKILL_FILE_NAME)
  if (!isInside(root.dir, dir)) {
    return { ok: false, error: 'Refusing to write outside the global skills directory.' }
  }

  // Full-document validation: frontmatter schema + name === folder name.
  // Provenance (P2): try the metadata-stamped document first; fall back to
  // the ORIGINAL when stamping would break parsing — provenance is
  // best-effort and must never be able to block an install.
  const stamped = source ? injectProvenance(content, source) : null
  let validContent = ''
  let parsedOk = false
  for (const candidate of stamped !== null && stamped !== content ? [stamped, content] : [content]) {
    if (parseSkillFileContent(candidate, { directoryName: name, filePath })) {
      validContent = candidate
      parsedOk = true
      break
    }
  }
  if (!parsedOk) {
    return {
      ok: false,
      error: `Invalid SKILL.md: frontmatter must declare "name: ${name}" (matching the folder) and a non-empty "description", with no other errors.`,
    }
  }

  if (existsSync(filePath) && !confirm) {
    return {
      ok: false,
      exists: true,
      error: `A skill named "${name}" already exists at ${dir}. Confirm to overwrite it.`,
    }
  }

  try {
    mkdirSync(dir, { recursive: true })
    writeFileAtomic(filePath, validContent)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, name, path: filePath }
}

type SkillLocation =
  | { ok: true; filePath: string; dir: string; name: string }
  | { ok: false; error: string }

/**
 * Resolve a caller-supplied path to exactly `<globalRoot>/<valid-name>/SKILL.md`.
 * Anything else (outside the roots, nested deeper, wrong file, invalid name,
 * the root itself) is rejected — this is the traversal safety line for both
 * edit and delete.
 */
function locateSkillFile(path: string): SkillLocation {
  const resolved = resolve(path)
  for (const { dir } of globalSkillRoots()) {
    if (!isInside(dir, resolved)) continue
    const rel = resolved.slice(resolve(dir).length + 1).split(sep)
    if (rel.length !== 2) continue
    const [name, file] = rel
    if (file !== SKILL_FILE_NAME || !isValidSkillName(name)) continue
    return { ok: true, filePath: resolved, dir: join(dir, name), name }
  }
  return {
    ok: false,
    error: `Not a skill file inside the global skills directory (${path}).`,
  }
}

export type SaveSkillResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * Edit an existing global skill (managed scope only). The document is
 * validated BEFORE the write: a broken frontmatter is rejected and the old
 * file stays untouched. `name` is effectively locked — parseSkillFileContent
 * requires frontmatter name === folder name, so a rename attempt fails here
 * (rename = delete + create, deliberately not offered).
 */
export function saveSkillFile(input: { path: string; content: string }): SaveSkillResult {
  const gate = managedGate()
  if (gate) return gate

  const loc = locateSkillFile(input.path)
  if (!loc.ok) return loc
  if (Buffer.byteLength(input.content, 'utf-8') > MAX_SKILL_BYTES) {
    return { ok: false, error: 'Skill file is larger than 200KB.' }
  }
  const parsed = parseSkillFileContent(input.content, {
    directoryName: loc.name,
    filePath: loc.filePath,
  })
  if (!parsed) {
    return {
      ok: false,
      error: `Invalid SKILL.md: frontmatter must keep "name: ${loc.name}" and a non-empty "description". The existing file was not changed.`,
    }
  }
  try {
    writeFileAtomic(loc.filePath, input.content)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, path: loc.filePath }
}

export type DeleteSkillResult = { ok: true; dir: string } | { ok: false; error: string }

/**
 * Delete a global skill FOLDER (managed scope only). Accepts either the
 * SKILL.md path (what the list hands out) or the folder path. Only a direct
 * child of a global root that actually contains a SKILL.md may be removed —
 * `..` escapes, the root itself, and non-skill dirs are all rejected.
 */
export function deleteSkill(input: { path: string }): DeleteSkillResult {
  const gate = managedGate()
  if (gate) return gate

  const asFile = input.path.endsWith(SKILL_FILE_NAME)
  const candidate = asFile ? input.path : join(input.path, SKILL_FILE_NAME)
  const loc = locateSkillFile(candidate)
  if (!loc.ok) return loc

  if (!existsSync(loc.dir)) return { ok: false, error: `Skill not found: ${loc.name}` }
  try {
    const stat = statSync(loc.dir)
    if (!stat.isDirectory()) return { ok: false, error: `Not a skill directory: ${loc.name}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  try {
    rmSync(loc.dir, { recursive: true })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, dir: loc.dir }
}

export interface ImportedSkillSource {
  /** Absolute (desktop) or sandbox (Android /upload/…) path of the picked file. */
  sourcePath: string
  /** Re-install over an existing skill (UI confirmed). */
  confirm?: boolean
}

export type ImportSkillResult =
  | { ok: true; name: string; path: string; exists?: boolean }
  | { ok: false; exists?: boolean; error: string }

/**
 * Import a picked markdown file as a skill. The file's own frontmatter
 * supplies the name and description — nothing is rebuilt, the document is
 * written verbatim (after full validation), so license/metadata fields
 * survive.
 */
export function importSkillFile(input: ImportedSkillSource): ImportSkillResult {
  let raw: string
  try {
    const stat = statSync(input.sourcePath)
    if (!stat.isFile()) return { ok: false, error: 'Not a file.' }
    if (stat.size > MAX_SKILL_BYTES) return { ok: false, error: 'Skill file is larger than 200KB.' }
    raw = readFileSync(input.sourcePath, 'utf-8')
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const name = extractSkillName(raw)
  if (!name) {
    return {
      ok: false,
      error: 'No SKILL.md frontmatter found: the file needs "---" delimited YAML with "name" and "description" fields.',
    }
  }
  if (!isValidSkillName(name)) {
    return {
      ok: false,
      error: `Invalid skill name "${name}" in frontmatter: use 1-64 lowercase letters, digits, and single hyphens.`,
    }
  }
  const result = installSkill({ name, content: raw, confirm: input.confirm, source: 'file' })
  if (!result.ok && result.exists) {
    // Surface the exists signal to the UI for its confirm flow.
    return { ok: false, exists: true, error: result.error }
  }
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, name: result.name, path: result.path }
}

export interface MultiSkillFile {
  /** Forward-slash path RELATIVE to the skill folder (`SKILL.md`, `references/x.md`, …). */
  path: string
  data: Buffer
}

export type InstallSkillMultiResult =
  | { ok: true; name: string; path: string }
  | { ok: false; exists?: boolean; name?: string; error: string }

/**
 * Atomically install a whole skill FOLDER (GitHub download path, plan D3 #7):
 * every file lands in a unique temp dir under the global `.agents` root, then
 * the dir is renamed into place — the skill exists complete or not at all.
 * Overwrite parks the old dir beside a backup, renames the temp in, and rolls
 * back on failure, so a mid-install error never loses the previous skill.
 *
 * Validation order mirrors installSkill: name regex → every relPath safe →
 * SKILL.md present, provenance-stamped and fully parsed → exists-confirm →
 * disk (temp write + rename).
 */
export function installSkillMulti(input: {
  name: string
  files: MultiSkillFile[]
  confirm?: boolean
  source?: SkillInstallSource
}): InstallSkillMultiResult {
  const { name, files, confirm, source } = input

  if (!isValidSkillName(name)) {
    return {
      ok: false,
      error: `Invalid skill name "${name}": use 1-64 lowercase letters, digits, and single hyphens (no leading/trailing hyphen).`,
    }
  }
  if (files.length === 0) return { ok: false, error: 'No files to install.' }

  const root = globalSkillRoots()[0]
  const dir = join(root.dir, name)
  const filePath = join(dir, SKILL_FILE_NAME)
  if (!isInside(root.dir, dir)) {
    return { ok: false, error: 'Refusing to write outside the global skills directory.' }
  }
  for (const f of files) {
    if (!isSafeRelPath(f.path)) return { ok: false, error: `Unsafe path in download: ${f.path}` }
  }

  const skillMd = files.find((f) => f.path === SKILL_FILE_NAME)
  if (!skillMd) return { ok: false, error: `Download contains no ${SKILL_FILE_NAME}.` }
  const originalText = skillMd.data.toString('utf-8')
  const stamped = source ? injectProvenance(originalText, source) : null
  let validText: string | null = null
  for (const candidate of stamped !== null && stamped !== originalText ? [stamped, originalText] : [originalText]) {
    if (parseSkillFileContent(candidate, { directoryName: name, filePath })) {
      validText = candidate
      break
    }
  }
  if (validText === null) {
    return {
      ok: false,
      error: `Invalid SKILL.md: frontmatter must declare "name: ${name}" (matching the folder) and a non-empty "description", with no other errors.`,
    }
  }

  if (existsSync(filePath) && !confirm) {
    return {
      ok: false,
      exists: true,
      // The FRONTMATTER name, so a confirm dialog can name the skill being
      // replaced rather than a path tail (skills review #2).
      name,
      error: `A skill named "${name}" already exists at ${dir}. Confirm to overwrite it.`,
    }
  }

  let tmp: string
  try {
    mkdirSync(root.dir, { recursive: true }) // first install: the root may not exist yet
    tmp = mkdtempSync(join(root.dir, '.tmp-skill-'))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    for (const f of files) {
      const target = join(tmp, f.path)
      if (!isInside(tmp, target)) throw new Error(`Unsafe path in download: ${f.path}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(
        target,
        f.path === SKILL_FILE_NAME && validText !== originalText ? Buffer.from(validText, 'utf-8') : f.data,
      )
    }
    if (existsSync(dir)) {
      const backup = join(
        root.dir,
        `.tmp-old-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      )
      renameSync(dir, backup)
      try {
        renameSync(tmp, dir)
      } catch (err) {
        // Keep the backup on disk rather than lose it if even the rollback fails.
        try {
          renameSync(backup, dir)
        } catch {
          // best effort
        }
        throw err
      }
      try {
        rmSync(backup, { recursive: true, force: true })
      } catch {
        // Best effort — the swap already LANDED (skills review #4): a locked
        // leftover (Windows EBUSY) must not turn a successful install into a
        // reported failure. The dot-prefixed dir stays out of the skill list.
      }
    } else {
      renameSync(tmp, dir)
    }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, name, path: filePath }
}
