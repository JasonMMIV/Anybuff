import FileTree, { type TreeNode } from './FileTree'
import ActivityPanel from './ActivityPanel'
import type { UiEvent } from '../../../preload'

export type RightTab = 'files' | 'activity'

interface RightPanelProps {
  open: boolean
  tab: RightTab
  onTab: (tab: RightTab) => void
  cwd: string | null
  /** Path of the file open in the floating preview (highlighted in the tree). */
  selectedPath: string | null
  onPreviewFile: (node: TreeNode) => void
  onMenuFile: (node: TreeNode, x: number, y: number, longPress: boolean) => void
  longPressEnabled: boolean
  onOpenFile: (path: string) => void
  events: UiEvent[]
  running: boolean
  onClose?: () => void
}

/**
 * Right panel: shows 2 tabs at the top (File Tree / Agent Activity & Diff);
 * the content renders inside the right panel itself.
 *
 * Gap #14 re-scope: the old inline <pre> preview is gone — clicking a file
 * opens the floating preview modal; the File Tree tab always shows the tree
 * and highlights the file currently being previewed.
 */
export default function RightPanel(props: RightPanelProps) {
  const { open, tab, onTab, cwd, selectedPath, onPreviewFile, onMenuFile, longPressEnabled, onOpenFile, events, running, onClose } = props

  return (
    <aside className={`activity-panel right-content-panel ${open ? 'open' : 'closed'}`}>
      <div className="tabs right-panel-tabs">
        <div className="tabs-left">
          <button className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => onTab('files')}>
            File Tree
          </button>
          <button className={`tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => onTab('activity')}>
            Activity & Diff
            {running && <span className="rail-dot" />}
          </button>
        </div>
        {onClose && (
          <button
            type="button"
            className="icon-btn right-panel-close-btn"
            onClick={onClose}
            title="Close panel"
          >
            ✕
          </button>
        )}
      </div>

      {tab === 'files' && cwd && (
        <div className="files-tab">
          <FileTree
            root={cwd}
            selectedPath={selectedPath}
            onPreviewFile={onPreviewFile}
            onMenuFile={onMenuFile}
            longPressEnabled={longPressEnabled}
          />
        </div>
      )}
      {tab === 'files' && !cwd && <div className="panel-empty">Select a project folder first.</div>}

      {tab === 'activity' && <ActivityPanel events={events} cwd={cwd} onOpenFile={onOpenFile} />}
    </aside>
  )
}
