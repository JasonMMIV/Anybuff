import { useCallback, useEffect, useState } from 'react'
import type { UiEvent } from '../../../preload'
import { parseDiff, relDiffPath, type FileDiff } from '../utils/diff-parse'
import DiffPreviewModal from './DiffPreviewModal'

interface Props {
  events: UiEvent[]
  cwd: string | null
  onOpenFile: (path: string) => void
}

type DiffStatus = 'loading' | 'ok' | 'empty' | 'error'

const DEMO_DIFF = [
  'diff --git a/src/calculator.js b/src/calculator.js',
  'index 1234567..89abcde 100644',
  '--- a/src/calculator.js',
  '+++ b/src/calculator.js',
  '@@ -18,5 +18,8 @@ export function multiply(a, b) {',
  ' }',
  ' ',
  ' export function divide(a, b) {',
  '+  if (b === 0) {',
  "+    throw new RangeError('Cannot divide by zero')",
  '+  }',
  '   return a / b',
  ' }'
].join('\n')

/**
 * Right-panel Changes tab: a flat list of files changed in the working tree.
 * The diff itself is deliberately not rendered inline — clicking a row opens
 * it in the floating preview window (DiffPreviewModal).
 */
export default function ChangesPanel({ events, cwd, onOpenFile }: Props) {
  const [diff, setDiff] = useState<FileDiff[]>([])
  const [status, setStatus] = useState<DiffStatus>('loading')
  const [previewPath, setPreviewPath] = useState<string | null>(null)

  const refreshDiff = useCallback(() => {
    if (!cwd) return
    if (typeof window.AnyBuff === 'undefined') {
      const parsed = parseDiff(DEMO_DIFF)
      setDiff(parsed)
      setStatus(parsed.length > 0 ? 'ok' : 'empty')
      return
    }
    void (window.AnyBuff.gitDiff(cwd) as Promise<{ diff: string; files: string[] }>)
      .then((data) => {
        const parsed = parseDiff(data?.diff ?? '')
        setDiff(parsed)
        setStatus(parsed.length > 0 ? 'ok' : 'empty')
      })
      .catch(() => {
        setDiff([])
        setStatus('error')
      })
  }, [cwd])

  // Refresh on mount / project switch. The panel unmounts when the tab is
  // switched away, so re-activating Changes always starts from fresh state.
  useEffect(() => {
    setDiff([])
    setPreviewPath(null)
    if (!cwd) {
      setStatus('empty')
      return
    }
    setStatus('loading')
    refreshDiff()
  }, [cwd, refreshDiff])

  // Pick up edits made by the agent while the panel stays open. Only the most
  // recent event matters; every tool_result / finish represents a new snapshot.
  const lastEvent = events[events.length - 1]
  useEffect(() => {
    if (lastEvent && (lastEvent.type === 'tool_result' || lastEvent.type === 'finish')) {
      refreshDiff()
    }
  }, [lastEvent, refreshDiff])

  const previewFile = previewPath ? diff.find((f) => f.path === previewPath) ?? null : null

  return (
    <div className="diff-view changes-view">
      {!cwd && <div className="panel-empty">Select a project folder first.</div>}
      {cwd && status === 'loading' && <div className="panel-empty">Loading changes…</div>}
      {cwd && status === 'empty' && <div className="panel-empty">Git not initialized or no changes yet.</div>}
      {cwd && status === 'error' && <div className="panel-empty">Could not load changes.</div>}

      {cwd && status === 'ok' && (
        <div className="diff-files">
          {diff.map((f) => (
            <button
              key={f.path}
              className="diff-file-row"
              onClick={() => setPreviewPath(f.path)}
              title={`${relDiffPath(f.path)} — click to preview`}
            >
              <span className="diff-file-name">{relDiffPath(f.path)}</span>
              <span className="diff-file-stats">
                <span className="stat-add">+{f.added}</span>
                <span className="stat-del">-{f.removed}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {previewFile && cwd && (
        <DiffPreviewModal
          file={previewFile}
          onClose={() => setPreviewPath(null)}
          onOpenFile={() => {
            const path = joinPath(cwd, relDiffPath(previewFile.path))
            setPreviewPath(null)
            onOpenFile(path)
          }}
        />
      )}
    </div>
  )
}

function joinPath(cwd: string, rel: string): string {
  const sep = cwd.includes('\\') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`
}
