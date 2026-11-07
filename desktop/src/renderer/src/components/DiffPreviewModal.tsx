import { useEffect } from 'react'
import { ChangesIcon, XIcon } from './Icons'
import { basenameOfPath, relDiffPath, type FileDiff } from '../utils/diff-parse'

interface Props {
  file: FileDiff
  onClose: () => void
  onOpenFile: () => void
}

/**
 * Floating preview for a single changed file (right-panel Changes tab).
 * The Changes tab itself only lists files; clicking a row pops this window.
 */
export default function DiffPreviewModal({ file, onClose, onOpenFile }: Props) {
  const path = relDiffPath(file.path)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop file-preview-backdrop diff-preview-backdrop" onClick={onClose}>
      <div
        className="file-preview-modal diff-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Changes in ${path}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="file-preview-modal-header">
          <div className="file-preview-modal-title">
            <span className="file-preview-modal-icon">
              <ChangesIcon size={15} />
            </span>
            <span className="file-preview-modal-name">{basenameOfPath(path)}</span>
            <span className="file-preview-modal-path" title={path}>
              {path}
            </span>
          </div>
          <span className="diff-preview-stats">
            <span className="stat-add">+{file.added}</span>
            <span className="stat-del">-{file.removed}</span>
          </span>
          <button type="button" className="btn mini" onClick={onOpenFile}>
            Open file
          </button>
          <button
            type="button"
            className="mini-btn file-preview-modal-close"
            onClick={onClose}
            title="Close preview"
            aria-label="Close preview"
          >
            <XIcon size={14} />
          </button>
        </header>

        <div className="file-preview-modal-body diff-preview-body">
          <div className="diff-split">
            <div className="diff-col">
              <div className="diff-col-head">Before</div>
              {file.before.length === 0 && <div className="diff-empty">No previous content</div>}
              {file.before.map((l, i) => (
                <div key={i} className={`diff-line ${l.kind}`}>
                  <span className="diff-num">{l.num}</span>
                  <span className="diff-text">{l.text || ' '}</span>
                </div>
              ))}
            </div>
            <div className="diff-col">
              <div className="diff-col-head">After</div>
              {file.after.length === 0 && <div className="diff-empty">No current content</div>}
              {file.after.map((l, i) => (
                <div key={i} className={`diff-line ${l.kind}`}>
                  <span className="diff-num">{l.num}</span>
                  <span className="diff-text">{l.text || ' '}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
