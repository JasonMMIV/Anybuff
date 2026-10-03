/**
 * Global-skills install/edit/delete helpers (skills plan D3/D6).
 *
 * One implementation shared by the three install paths (form create / file
 * import / GitHub download) so the validation chain — name regex → full
 * frontmatter parse → containment → exists-confirm → ADR-13 atomic write —
 * can only ever be exercised in one place. Folder-shaped installs (GitHub
 * download, and a file import that picked a skill's own SKILL.md) share
 * installSkillMulti; a lone document still goes through installSkill.
 *
 * Scope gate (D6): saveSkillFile / deleteSkill refuse unless the shell
 * declared `globalSkillsScope: 'managed'` (Android rootfs). Desktop declares
 * 'shared' — its ~/.agents/skills is the cross-tool convention directory
 * (Claude Code, `npx skills add`, …), so AnyBuff keeps it read-only. The gate
 * lives HOST-side on purpose: channels are the boundary, a renderer that
 * merely hides buttons must never be the enforcement layer. Absent scope
 * defaults to 'shared' (fail-safe — see HostEnv.globalSkillsScope).
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Dirent } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'
import {
  isValidSkillName,
  SKILL_FILE_NAME,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from '@codebuff/common/constants/skills'
import { parseSkillFileContent } from '@codebuff/common/util/parse-skill'
import { renameWithRetry, writeFileAtomic } from '../files/atomic-write'
import { globalSkillsScope, hostPaths, pickedFilesShareFolder } from '../env'

/**
 * There is deliberately NO size quota on skill content — neither per file nor
 * per folder, and none on SKILL.md itself.
 *
 * The 200KB that used to live here was inherited from the `readSkillFile` IPC
 * guard (a string bound on what the renderer may be handed), and it does not
 * transfer to skill files: a skill's `references/` and `scripts/` are data the
 * agent reads during a run, not prose destined for a prompt. The cap only ever
 * produced half-installed skills — a 300KB JSON data file the skill genuinely
 * uses was skipped with a warning, which is the same "the model is told to read
 * a file that isn't there" failure the folder-aware import exists to remove.
 *
 * What still bounds an install:
 *   - links are never followed and `.git`/`node_modules` are never entered
 *     (see scanSkillFolder) — no cycles, no VCS databases, no dep trees;
 *   - consent: a folder-shaped import never installs on the first call — it
 *     returns `folderConfirm` with the exact file list and waits for
 *     `confirmFolder` (see importSkillFile), so a `SKILL.md` sitting in an
 *     ordinary folder cannot sweep that folder in silence.
 *
 * The GitHub download has no budget either: `github-skills.ts` installs the
 * whole subfolder and only reports GitHub's own `truncated` tree flag. Do not
 * add a size/count quota anywhere in this file — a truncated skill still
 * installs as a skill and points at files that are not there, which is worse
 * than a loud failure. Replace any limit you are tempted to add with
 * information (show the count) and consent (ask before installing).
 */

/** Directory names a folder walk never descends into. A skill folder has no
 *  reason to carry a VCS database or a dependency tree, and walking them would
 *  copy megabytes of noise nobody asked to install. */
const SKILL_SKIP_DIRS = new Set(['.git', 'node_modules'])

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

export interface SkillFolderEntry {
  /** Forward-slash path RELATIVE to the skill folder (`SKILL.md`, `references/api.md`). */
  rel: string
  /** Absolute path on disk (never handed to installSkillMulti). */
  abs: string
  size: number
}

export interface SkillFolderScan {
  entries: SkillFolderEntry[]
  /** Skip notes — links, unreadable paths. Rendered by formatSkipWarnings. */
  warnings: string[]
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Walk a skill folder on disk and report every file in it. There is no size
 * quota: what the user picked is what gets installed.
 *
 * Two rules bound the walk instead:
 *   - **Links are never followed.** A symlink — or a Windows junction, which
 *     lstat reports identically — inside a picked folder would otherwise pull
 *     in content from outside the folder the user chose, and a link cycle
 *     would never terminate.
 *   - **`.git` and `node_modules` are never entered.**
 *
 * Every `rel` is built from real dirent names, segment by segment, so it
 * satisfies isSafeRelPath by construction. installSkillMulti re-checks it
 * anyway: that check is a safety line, not a convenience, and must stay
 * enforced on every install path.
 *
 * Entries are sorted by name at each level so an install is reproducible
 * regardless of the OS's directory order, and SKILL.md is hoisted to the front
 * so a caller that requires it can rely on finding it.
 */
export function scanSkillFolder(dir: string): SkillFolderScan {
  const scan: SkillFolderScan = { entries: [], warnings: [] }

  const walk = (current: string, prefix: string): void => {
    let dirents: Dirent[]
    try {
      dirents = readdirSync(current, { withFileTypes: true })
    } catch (err) {
      // Noun phrase, not a clause: formatSkipWarnings prefixes "skipped ".
      scan.warnings.push(`"${prefix || '.'}" (could not be read: ${errText(err)})`)
      return
    }
    const sorted = [...dirents].sort((a, b) => a.name.localeCompare(b.name))
    if (prefix === '') {
      const idx = sorted.findIndex((d) => d.name.toLowerCase() === SKILL_FILE_NAME.toLowerCase())
      if (idx > 0) sorted.unshift(...sorted.splice(idx, 1))
    }
    for (const d of sorted) {
      const abs = join(current, d.name)
      const rel = prefix ? `${prefix}/${d.name}` : d.name
      if (d.isSymbolicLink()) {
        scan.warnings.push(`"${rel}" is a link`)
        continue
      }
      if (d.isDirectory()) {
        if (SKILL_SKIP_DIRS.has(d.name)) continue
        walk(abs, rel)
        continue
      }
      if (!d.isFile()) continue
      let size: number
      try {
        size = lstatSync(abs).size
      } catch {
        continue // vanished between readdir and stat
      }
      scan.entries.push({ rel, abs, size })
    }
  }

  walk(dir, '')
  return scan
}

/**
 * One file in a folder install plan: the path it will be installed under plus
 * where its bytes live on disk.
 */
export interface PlannedSkillFile {
  /** Install path — `SKILL.md` for the picked document, verbatim otherwise. */
  path: string
  /** Absolute path on disk (never handed to installSkillMulti). */
  abs: string
}

export interface SkillFolderPlan {
  /** Install order — `SKILL.md` first, then the walk's deterministic order. */
  files: PlannedSkillFile[]
  /** Skip notes from the walk plus plan-level ones (duplicate spellings). */
  warnings: string[]
}

/** Root-level `SKILL.md` in any spelling (`SKILL.md`, `skill.md`, `Skill.md`). */
function isRootSkillDoc(rel: string): boolean {
  return !rel.includes('/') && rel.toLowerCase() === SKILL_FILE_NAME.toLowerCase()
}

/**
 * Turn a folder scan into an install plan. The PICKED document — whatever case
 * it is spelled in — installs as `SKILL.md`; every other file keeps its name.
 *
 * Why the picked file wins: its frontmatter is what named the skill (the
 * caller reads `sourcePath` before any scan), so installing a sibling variant
 * instead would land a document the caller never validated. A second root-level
 * variant is skipped WITH a warning rather than installed: `SKILL.md` and
 * `Skill.md` are the same file on Windows/macOS, so writing both would let the
 * second clobber the canonical one after validation.
 *
 * Returns null when the folder holds no root-level SKILL.md spelling at all —
 * the pick vanished between the read and the walk. The caller then falls back
 * to single-file mode, which installs the bytes it already read.
 */
export function planSkillFolder(scan: SkillFolderScan, sourcePath: string): SkillFolderPlan | null {
  const variants = scan.entries.filter((e) => isRootSkillDoc(e.rel))
  const pickedAbs = resolve(sourcePath)
  // Exact match first: on a case-sensitive filesystem two variants can coexist
  // and only one of them is the pick.
  const picked =
    variants.find((v) => resolve(v.abs) === pickedAbs) ??
    variants.find((v) => resolve(v.abs).toLowerCase() === pickedAbs.toLowerCase()) ??
    variants[0]
  if (!picked) return null

  const warnings = [...scan.warnings]
  const files: PlannedSkillFile[] = []
  for (const entry of scan.entries) {
    if (entry === picked) files.push({ path: SKILL_FILE_NAME, abs: entry.abs })
    else if (isRootSkillDoc(entry.rel)) {
      warnings.push(`"${entry.rel}" (a second SKILL.md spelling — only one skill document installs)`)
    } else files.push({ path: entry.rel, abs: entry.abs })
  }
  const skillIdx = files.findIndex((f) => f.path === SKILL_FILE_NAME)
  if (skillIdx > 0) files.unshift(...files.splice(skillIdx, 1))
  return { files, warnings }
}

/**
 * Read a plan into install payloads. Unreadable files are reported through
 * `warnings` — they are dropped, never substituted — so a failure to read is
 * visible instead of silent; a plan whose SKILL.md cannot be read fails loudly
 * inside installSkillMulti.
 */
export function collectSkillFolderFiles(plan: SkillFolderPlan): {
  files: MultiSkillFile[]
  warnings: string[]
} {
  const files: MultiSkillFile[] = []
  const warnings = [...plan.warnings]
  for (const f of plan.files) {
    try {
      files.push({ path: f.path, data: readFileSync(f.abs) })
    } catch (err) {
      warnings.push(`"${f.path}" (could not be read: ${errText(err)})`)
    }
  }
  return { files, warnings }
}

/** How many files a skill folder holds — the real number, no quota applied. */
export function countSkillFiles(skillDir: string): number {
  return scanSkillFolder(skillDir).entries.length
}

/** How many per-file skip reasons a warning quotes. A folder full of links or
 *  unreadable files can produce hundreds (skills review #5) — the rest is a
 *  count, not text. */
const MAX_QUOTED_SKIPS = 5

/** Render skip notes as one bounded sentence, or undefined when there are none. */
export function formatSkipWarnings(warnings: string[]): string | undefined {
  if (warnings.length === 0) return undefined
  const quoted = warnings.slice(0, MAX_QUOTED_SKIPS)
  const rest = warnings.length - quoted.length
  return `skipped ${quoted.join('; ')}${rest > 0 ? ` (and ${rest} more skipped files)` : ''}`
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
  /**
   * Consent to install the WHOLE folder, granted after the caller showed the
   * file list from a `folderConfirm` result. Absent = no consent: a
   * folder-shaped pick answers with the preview instead of installing — the
   * gate is host-side, exactly like `exists`, so a caller that forgets it can
   * only under-install (single file), never over-install.
   */
  confirmFolder?: boolean
}

export type ImportSkillResult =
  | { ok: true; name: string; path: string; fileCount?: number; warning?: string }
  | {
      ok: false
      /**
       * Folder-shaped pick awaiting consent: this is the exact install plan,
       * file by file. Re-issue with `confirmFolder: true` to install it, or
       * drop it to install nothing.
       */
      folderConfirm: true
      /** Frontmatter name the install would use. */
      name: string
      /** Install paths, `SKILL.md` first — what a confirmed install writes. */
      files: string[]
      fileCount: number
      /** Skips the walk already knows about (links, unreadable files). */
      warning?: string
      /** Confirmed install would replace an existing skill with this name. */
      exists: boolean
      /** Never set: declared so a caller reading `error` off any failure
       *  envelope (the UI does) sees `undefined`, not a type error. */
      error?: undefined
    }
  | { ok: false; exists?: boolean; name?: string; error: string }

/**
 * The skill folder a pick belongs to, or null when this pick cannot mean
 * "install the whole skill folder":
 *
 *   - the shell's picker does not preserve folders — Android copies every pick
 *     flat into the guest `/upload` staging dir, whose parent holds the whole
 *     pick history, not this skill's attachments (HostEnv.pickedFilesShareFolder);
 *   - the file is not the convention name `SKILL.md` — a loose document is
 *     imported as the single file it is;
 *   - the file sits directly in a convention skills root. Picking
 *     `~/.agents/skills/SKILL.md` must not sweep the user's other skills into
 *     one new folder — the root is a container of skills, not a skill.
 */
function folderImportFor(filePath: string): string | null {
  if (!pickedFilesShareFolder()) return null
  if (basename(filePath).toLowerCase() !== SKILL_FILE_NAME.toLowerCase()) return null
  const dir = dirname(filePath)
  try {
    if (!statSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  const parent = basename(dirname(dir))
  if (parent === '.agents' || parent === '.claude') return null
  return dir
}

/**
 * Import a picked markdown file as a skill.
 *
 * **Single-file mode** (unchanged): the file's own frontmatter supplies the
 * name and description — nothing is rebuilt, the document is written verbatim
 * (after full validation), so license/metadata fields survive.
 *
 * **Folder mode** (folder-aware): when the pick IS a skill's own
 * `<skill>/SKILL.md` and that folder carries companion files, the whole folder
 * installs atomically through installSkillMulti — `references/`, `scripts/`,
 * `assets/`, everything the SKILL.md body tells the model to read. Installing
 * only the SKILL.md would drop them SILENTLY, leaving the model to follow
 * instructions that point at files that do not exist: the most confusing
 * failure this page can produce, and the reason a skill is a folder rather
 * than a file at all. Same skips and same atomic whole-or-nothing landing as
 * the GitHub path, and no size or count quota (see the block at the top of
 * this file).
 *
 * **Consent (`folderConfirm`):** folder mode never installs on the first
 * call. The pick may be a `SKILL.md` that merely *sits* in an ordinary folder
 * (`~/Downloads/SKILL.md` beside a 20MB installer), so the first call returns the plan file by file and the caller
 * re-issues with `confirmFolder: true` after showing it. Same shape as the
 * `exists` gate: the host decides, the caller only consents.
 */
export function importSkillFile(input: ImportedSkillSource): ImportSkillResult {
  let raw: string
  try {
    const stat = statSync(input.sourcePath)
    if (!stat.isFile()) return { ok: false, error: 'Not a file.' }
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
  // Folder-aware: a pick of a skill's own SKILL.md brings its attachments.
  const folder = folderImportFor(input.sourcePath)
  if (folder) {
    const plan = planSkillFolder(scanSkillFolder(folder), input.sourcePath)
    // Folder mode only when the folder really carries attachments: a lone
    // SKILL.md takes the single-file path below (same outcome, one less branch
    // to reason about). A vanished pick (plan === null) falls through too,
    // where the single-file path installs the bytes already read above.
    if (plan && plan.files.length > 1 && plan.files[0].path === SKILL_FILE_NAME) {
      if (!input.confirmFolder) {
        // Consent gate. Nothing is read, written or replaced here — the caller
        // shows this list and re-issues with confirmFolder.
        const previewWarning = formatSkipWarnings(plan.warnings)
        return {
          ok: false,
          folderConfirm: true,
          name,
          files: plan.files.map((f) => f.path),
          fileCount: plan.files.length,
          ...(previewWarning ? { warning: previewWarning } : {}),
          exists: existsSync(join(globalSkillRoots()[0].dir, name, SKILL_FILE_NAME)),
        }
      }
      const { files, warnings } = collectSkillFolderFiles(plan)
      const installed = installSkillMulti({ name, files, confirm: input.confirm, source: 'file' })
      if (!installed.ok) {
        // exists → the UI's overwrite-confirm labels the dialog with the
        // FRONTMATTER name (the skill actually being replaced), not the folder
        // tail the user happened to click.
        return installed.exists
          ? { ok: false, exists: true, name, error: installed.error }
          : { ok: false, error: installed.error }
      }
      const warning = formatSkipWarnings(warnings)
      return {
        ok: true,
        name: installed.name,
        path: installed.path,
        fileCount: files.length,
        ...(warning ? { warning } : {}),
      }
    }
  }

  const result = installSkill({ name, content: raw, confirm: input.confirm, source: 'file' })
  if (!result.ok && result.exists) {
    // Surface the exists signal to the UI for its confirm flow.
    return { ok: false, exists: true, name, error: result.error }
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
 * Atomically install a whole skill FOLDER — the shared installer behind the
 * GitHub download (plan D3 #7) and the folder-aware file import:
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
      // Directory renames obey the same ADR-13 backoff as file renames: a
      // just-written folder on Windows hits EPERM/EBUSY routinely, and failing
      // the install on the first one would make every overwrite flaky.
      renameWithRetry(dir, backup)
      try {
        renameWithRetry(tmp, dir)
      } catch (err) {
        // Keep the backup on disk rather than lose it if even the rollback fails.
        try {
          renameWithRetry(backup, dir)
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
      renameWithRetry(tmp, dir)
    }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, name, path: filePath }
}
