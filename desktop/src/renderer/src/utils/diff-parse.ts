/**
 * Parse `git diff --no-color` output into per-file before/after line views.
 *
 * Pure and shared by the right-panel Changes list and its floating preview so
 * both render exactly the same parsed model.
 */

export interface DiffLine {
  num: number
  text: string
  kind: 'ctx' | 'add' | 'del'
}

export interface FileDiff {
  path: string
  before: DiffLine[]
  after: DiffLine[]
  added: number
  removed: number
}

const MAX_DIFF_LINES_PER_FILE = 2000

export function parseDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = []
  let current: FileDiff | null = null
  let beforeNum = 0
  let afterNum = 0
  let isTruncated = false

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/)
      const path = (m?.[1] ?? 'file').replace(/^"|"$/g, '')
      current = { path, before: [], after: [], added: 0, removed: 0 }
      files.push(current)
      beforeNum = 0
      afterNum = 0
      isTruncated = false
      continue
    }
    if (!current) continue
    if (line.startsWith('Binary files ')) {
      current.before.push({ num: 1, text: '[Binary file differs]', kind: 'ctx' })
      current.after.push({ num: 1, text: '[Binary file differs]', kind: 'ctx' })
      continue
    }
    if (line.startsWith('@@')) {
      const bm = line.match(/^-(\d+)(?:,\d+)?/)
      const am = line.match(/\+(\d+)(?:,\d+)?/)
      beforeNum = bm ? parseInt(bm[1], 10) : 0
      afterNum = am ? parseInt(am[1], 10) : 0
      continue
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) continue
    if (line === '\\ No newline at end of file') continue

    if (isTruncated) continue
    if (current.before.length + current.after.length >= MAX_DIFF_LINES_PER_FILE) {
      isTruncated = true
      current.before.push({ num: beforeNum, text: '… [Diff truncated for performance]', kind: 'ctx' })
      current.after.push({ num: afterNum, text: '… [Diff truncated for performance]', kind: 'ctx' })
      continue
    }

    if (line.startsWith('-')) {
      current.before.push({ num: beforeNum++, text: line.slice(1), kind: 'del' })
      current.removed++
    } else if (line.startsWith('+')) {
      current.after.push({ num: afterNum++, text: line.slice(1), kind: 'add' })
      current.added++
    } else {
      const text = line.startsWith(' ') ? line.slice(1) : line
      current.before.push({ num: beforeNum++, text, kind: 'ctx' })
      current.after.push({ num: afterNum++, text, kind: 'ctx' })
    }
  }
  return files.filter((f) => f.before.length > 0 || f.after.length > 0)
}

/** `git diff` paths are prefixed with `a/` / `b/`; show the project-relative path. */
export function relDiffPath(p: string): string {
  return p.replace(/^[ab]\//, '')
}

export function basenameOfPath(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}
