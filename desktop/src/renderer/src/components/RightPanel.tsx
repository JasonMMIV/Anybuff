import FileTree, { type TreeNode } from './FileTree'
import ActivityPanel from './ActivityPanel'
import CodebaseIndexPanel from './CodebaseIndexPanel'
import type { UiEvent } from '../../../preload'

export type RightTab = 'files' | 'activity' | 'index'

interface RightPanelProps {
  open: boolean
  tab: RightTab
  onTab: (tab: RightTab) => void
  cwd: string | null
  selectedFile: { path: string; content: string; name: string } | null
  onSelectFile: (node: TreeNode) => void
  onOpenFile: (path: string) => void
  events: UiEvent[]
  onCloseFile: () => void
  running: boolean
}

/**
 * Right panel: shows 2 tabs at the top (File Tree / Agent Activity & Diff);
 * the content renders inside the right panel itself.
 */
export default function RightPanel(props: RightPanelProps) {
  const { open, tab, onTab, cwd, selectedFile, onSelectFile, onOpenFile, events, onCloseFile, running } = props

  return (
    <aside className={`activity-panel right-content-panel ${open ? 'open' : 'closed'}`}>
      <div className="tabs">
        <button className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => onTab('files')}>
          File Tree
        </button>
        <button className={`tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => onTab('activity')}>
          Activity & Diff
          {running && <span className="rail-dot" />}
        </button>
        <button className={`tab ${tab === 'index' ? 'active' : ''}`} onClick={() => onTab('index')}>
          Codebase Index
          {events.some((event) => event.queryIndex) && <span className="tab-count">{events.filter((event) => event.queryIndex).length}</span>}
        </button>
      </div>

      {tab === 'files' && cwd &&
        (selectedFile ? (
          <div className="file-preview">
            <div className="file-preview-head">
              <span className="file-preview-name">{selectedFile.name}</span>
              <button className="mini-btn" onClick={onCloseFile} title="Close preview">
                ✕
              </button>
            </div>
            <pre className="file-preview-content">{selectedFile.content}</pre>
          </div>
        ) : (
          <div className="files-tab">
            <FileTree root={cwd} selectedPath={null} onSelect={onSelectFile} />
          </div>
        ))}
      {tab === 'files' && !cwd && <div className="panel-empty">Select a project folder first.</div>}

      {tab === 'activity' && <ActivityPanel events={events} cwd={cwd} onOpenFile={onOpenFile} />}
      {tab === 'index' && <CodebaseIndexPanel events={events} cwd={cwd} onOpenFile={onOpenFile} />}
    </aside>
  )
}
