import FileTree, { type TreeNode } from './FileTree'
import ChangesPanel from './ChangesPanel'
import { ChangesIcon, FilesIcon } from './Icons'
import type { UiEvent } from '../../../preload'

export type RightTab = 'files' | 'changes'

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
  onClose?: () => void
}

/**
 * Right panel: two tabs (Files / Changes).
 *
 * Gap #14 re-scope: the old inline <pre> preview is gone — clicking a file
 * opens the floating preview modal; the Files tab always shows the tree and
 * highlights the file currently being previewed. The Changes tab also only
 * lists changed files; clicking one opens its diff in a floating window.
 */
export default function RightPanel(props: RightPanelProps) {
  const { open, tab, onTab, cwd, selectedPath, onPreviewFile, onMenuFile, longPressEnabled, onOpenFile, events, onClose } = props

  return (
    <aside className={`activity-panel right-content-panel ${open ? 'open' : 'closed'}`}>
      <div className="tabs right-panel-tabs">
        <div className="tabs-left">
          <button className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => onTab('files')}>
            <FilesIcon size={14} />
            Files
          </button>
          <button className={`tab ${tab === 'changes' ? 'active' : ''}`} onClick={() => onTab('changes')}>
            <ChangesIcon size={14} />
            Changes
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

      {tab === 'changes' && <ChangesPanel events={events} cwd={cwd} onOpenFile={onOpenFile} />}
    </aside>
  )
}
