import { useCallback, useEffect, useMemo, useState } from 'react'
import type { UiEvent } from '../../../preload'

const EVENT_META: Record<string, { icon: string; label: string }> = {
  start: { icon: '▶', label: 'Started' },
  finish: { icon: '✓', label: 'Finished' },
  subagent_start: { icon: '◈', label: 'Sub-agent started' },
  subagent_finish: { icon: '◇', label: 'Sub-agent finished' },
  tool_start: { icon: '⚙', label: 'Running tool' },
  tool_call: { icon: '⚙', label: 'Tool call' },
  tool_result: { icon: '▤', label: 'Tool result' },
  phase: { icon: '≋', label: 'Phase' },
  error: { icon: '✕', label: 'Error' },
  download: { icon: '↓', label: 'Download' },
  provider_status: { icon: '⇄', label: 'Provider' },
  context_compaction: { icon: '□', label: 'Context compacted' },
  job_update: { icon: '⚙', label: 'Job update' }
}

type Tab = 'activity' | 'diff'
type Filter = 'all' | 'tools' | 'agents' | 'errors'

interface DiffLine {
  num: number
  text: string
  kind: 'ctx' | 'add' | 'del'
}

interface FileDiff {
  path: string
  before: DiffLine[]
  after: DiffLine[]
  added: number
  removed: number
}

const MAX_DIFF_LINES_PER_FILE = 2000

/** Parse `git diff --no-color` output into per-file before/after line views. */
function parseDiff(raw: string): FileDiff[] {
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

function relDiffPath(p: string): string {
  return p.replace(/^[ab]\//, '')
}

interface Props {
  events: UiEvent[]
  cwd: string | null
  onOpenFile: (path: string) => void
}

type DiffStatus = 'loading' | 'ok' | 'empty'

export default function ActivityPanel({ events, cwd, onOpenFile }: Props) {
  const [tab, setTab] = useState<Tab>('activity')
  const [filter, setFilter] = useState<Filter>('all')
  const [diff, setDiff] = useState<FileDiff[]>([])
  const [diffStatus, setDiffStatus] = useState<DiffStatus>('empty')
  const [selectedFileDiff, setSelectedFileDiff] = useState<string | null>(null)
  const [busyFile, setBusyFile] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refreshDiff = useCallback(() => {
    if (!cwd) return
    if (typeof window.AnyBuff === 'undefined') {
      const fake = [
        'diff --git a/src/calculator.js b/src/calculator.js',
        'index 1234567..89abcde 100644',
        '--- a/src/calculator.js',
        '+++ b/src/calculator.js',
        '@@ -18,5 +18,8 @@ export function multiply(a, b) {',
        ' }',
        ' ',
        ' export function divide(a, b) {',
        '+  if (b === 0) {',
        '+    throw new RangeError(\'Cannot divide by zero\')',
        '+  }',
        '   return a / b',
        ' }'
      ].join('\n')
      const parsed = parseDiff(fake)
      setDiff(parsed)
      setDiffStatus(parsed.length > 0 ? 'ok' : 'empty')
      setSelectedFileDiff((s) => s ?? parsed[0]?.path ?? null)
      return
    }
    void window.AnyBuff.gitDiff(cwd).then((d) => {
      const data = d as { diff: string; files: string[] }
      const parsed = parseDiff(data.diff)
      setDiff(parsed)
      setDiffStatus(data.diff.trim() ? 'ok' : 'empty')
      setSelectedFileDiff((s) => s ?? parsed[0]?.path ?? null)
    })
  }, [cwd])

  useEffect(() => {
    refreshDiff()
  }, [refreshDiff])

  // Refresh the diff when new tool/finish events arrive
  useEffect(() => {
    if (events.some((e) => e.type === 'tool_result' || e.type === 'finish')) {
      refreshDiff()
    }
  }, [events, refreshDiff])

  const filtered = useMemo(() => {
    const isIgnored = (e: UiEvent) =>
      e.type === 'error' &&
      typeof e.message === 'string' &&
      (e.message.includes('suggest_followups already ended') ||
        e.message.includes('No more non-terminal tools are available after followups'))

    const valid = events.filter((e) => !isIgnored(e))
    if (filter === 'all') return valid
    if (filter === 'tools') return valid.filter((e) => e.type.startsWith('tool'))
    if (filter === 'agents') return valid.filter((e) => e.type.startsWith('subagent'))
    return valid.filter((e) => e.type === 'error')
  }, [events, filter])

  const onAccept = useCallback(
    async (path: string) => {
      if (!cwd) return
      setBusyFile(path)
      try {
        const res = (await window.AnyBuff.gitAccept({ cwd, file: relDiffPath(path) })) as { ok: boolean; error?: string }
        setNotice(res.ok ? `Accepted ${relDiffPath(path)}` : res.error ?? 'Failed to accept')
        refreshDiff()
      } finally {
        setBusyFile(null)
        setTimeout(() => setNotice(null), 2500)
      }
    },
    [cwd, refreshDiff]
  )

  const onRevert = useCallback(
    async (path: string) => {
      if (!cwd) return
      setBusyFile(path)
      try {
        const res = (await window.AnyBuff.gitRevert({ cwd, file: relDiffPath(path) })) as { ok: boolean; error?: string }
        setNotice(res.ok ? `Reverted ${relDiffPath(path)}` : res.error ?? 'Failed to revert')
        refreshDiff()
      } finally {
        setBusyFile(null)
        setTimeout(() => setNotice(null), 2500)
      }
    },
    [cwd, refreshDiff]
  )

  const current = diff.find((d) => d.path === selectedFileDiff) ?? diff[0]

  return (
    <div className="activity-panel">
      <div className="tabs">
        <button className={`tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>
          Activity {events.length > 0 && <span className="tab-count">{events.length}</span>}
        </button>
        <button className={`tab ${tab === 'diff' ? 'active' : ''}`} onClick={() => setTab('diff')}>
          Diff {diff.length > 0 && <span className="tab-count">{diff.length}</span>}
        </button>
      </div>

      {notice && <div className="diff-notice">{notice}</div>}

      {tab === 'activity' && (
        <>
          <div className="timeline-filters">
            {(['all', 'tools', 'agents', 'errors'] as Filter[]).map((f) => (
              <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'tools' ? 'Tools' : f === 'agents' ? 'Agents' : 'Errors'}
              </button>
            ))}
          </div>
          <div className="event-timeline">
            {filtered.length === 0 && (
              <div className="panel-empty">
                {filter === 'all' ? 'Run a prompt and agent activity will appear here.' : `No ${filter} activity yet.`}
              </div>
            )}
            {filtered.map((e, i) => {
              const meta = EVENT_META[e.type] ?? { icon: '·', label: e.type }
              const detail = e.toolName ?? e.agentType ?? e.status ?? e.message ?? ''
              const isLast = i === filtered.length - 1
              return (
                <div key={i} className={`timeline-item e-${e.type}${isLast ? ' latest' : ''}`}>
                  <span className="timeline-icon">{meta.icon}</span>
                  <div className="timeline-body">
                    <span className="timeline-label">{meta.label}</span>
                    {detail && <span className="timeline-detail">{detail}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {tab === 'diff' && (
        <div className="diff-view">
          {!cwd && <div className="panel-empty">Select a project folder first.</div>}
          {cwd && diffStatus === 'empty' && <div className="panel-empty">Git not initialized or no changes yet.</div>}
          {diff.length > 0 && current && (
            <>
              <div className="diff-files">
                {diff.map((f) => (
                  <button
                    key={f.path}
                    className={`diff-file-row ${f.path === current.path ? 'active' : ''}`}
                    onClick={() => setSelectedFileDiff(f.path)}
                    title={f.path}
                  >
                    <span className="diff-file-name">{relDiffPath(f.path)}</span>
                    <span className="diff-file-stats">
                      <span className="stat-add">+{f.added}</span>
                      <span className="stat-del">-{f.removed}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="diff-actions">
                <button className="btn mini danger" disabled={busyFile === current.path} onClick={() => void onRevert(current.path)}>
                  Revert
                </button>
                <button className="btn mini primary" disabled={busyFile === current.path} onClick={() => void onAccept(current.path)}>
                  Accept
                </button>
              </div>
              <div className="diff-split">
                <div className="diff-col">
                  <div className="diff-col-head">Before</div>
                  {current.before.map((l, i) => (
                    <div key={i} className={`diff-line ${l.kind}`}>
                      <span className="diff-num">{l.num}</span>
                      <span className="diff-text">{l.text || ' '}</span>
                    </div>
                  ))}
                </div>
                <div className="diff-col">
                  <div className="diff-col-head">After</div>
                  {current.after.map((l, i) => (
                    <div key={i} className={`diff-line ${l.kind}`}>
                      <span className="diff-num">{l.num}</span>
                      <span className="diff-text">{l.text || ' '}</span>
                    </div>
                  ))}
                </div>
              </div>
              {cwd && (
                <div className="diff-open-file">
                  <button className="btn mini" onClick={() => onOpenFile(joinPath(cwd, relDiffPath(current.path)))}>
                    Open file
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function joinPath(cwd: string, rel: string): string {
  const sep = cwd.includes('\\') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`
}
