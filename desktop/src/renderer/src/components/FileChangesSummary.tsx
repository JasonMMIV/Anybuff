import { useState } from 'react'
import { ChevronDownIcon, FileIcon } from './Icons'

export interface FileChange {
  path: string
  action: 'create' | 'modify' | 'delete'
}

function actionIcon(action: FileChange['action']): string {
  switch (action) {
    case 'create': return '＋'
    case 'modify': return '✎'
    case 'delete': return '✕'
  }
}

function actionLabel(action: FileChange['action']): string {
  switch (action) {
    case 'create': return 'Created'
    case 'modify': return 'Modified'
    case 'delete': return 'Deleted'
  }
}

function actionColor(action: FileChange['action']): string {
  switch (action) {
    case 'create': return 'var(--green)'
    case 'modify': return 'var(--accent)'
    case 'delete': return 'var(--red)'
  }
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function dirnameOf(p: string): string {
  const parts = p.split(/[\\/]/)
  parts.pop()
  return parts.join('/') || '.'
}

export function FileChangesSummary({ files, collapsed: initialCollapsed = false }: { files: FileChange[]; collapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed)

  if (!files || files.length === 0) return null

  const creates = files.filter(f => f.action === 'create').length
  const modifies = files.filter(f => f.action === 'modify').length
  const deletes = files.filter(f => f.action === 'delete').length

  const summaryParts: string[] = []
  if (creates > 0) summaryParts.push(`${creates} created`)
  if (modifies > 0) summaryParts.push(`${modifies} modified`)
  if (deletes > 0) summaryParts.push(`${deletes} deleted`)
  const summary = summaryParts.join(', ')

  return (
    <div className="file-changes-summary">
      <div className="file-changes-header" onClick={() => setCollapsed(c => !c)}>
        <span className="file-changes-icon"><FileIcon size={14} /></span>
        <span className="file-changes-title">
          {files.length} file{files.length !== 1 ? 's' : ''} changed
        </span>
        <span className="file-changes-detail">{summary}</span>
        <span className="file-changes-toggle">
          <ChevronDownIcon size={14} className={collapsed ? 'file-changes-chevron-collapsed' : ''} />
        </span>
      </div>
      {!collapsed && (
        <ul className="file-changes-list">
          {files.map((f, i) => (
            <li key={i} className="file-changes-item">
              <span className="file-changes-action-icon" style={{ color: actionColor(f.action) }}>
                {actionIcon(f.action)}
              </span>
              <span className="file-changes-filepath" title={f.path}>
                <span className="file-changes-dirname">{dirnameOf(f.path)}/</span>
                <span className="file-changes-filename">{basenameOf(f.path)}</span>
              </span>
              <span className="file-changes-action-label" style={{ color: actionColor(f.action) }}>
                {actionLabel(f.action)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
