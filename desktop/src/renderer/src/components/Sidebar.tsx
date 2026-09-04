import { useState, useEffect, useRef } from 'react'
import {
  EditIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  NotePenIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
  XIcon
} from './Icons'

export interface SearchResult {
  index: number
  kind: string
  text: string
  key?: string
  taskId?: string
  taskPrompt?: string
  projectPath?: string
  projectName?: string
}

export interface TaskRecord {
  id: string
  prompt: string
  createdAt: number
  updatedAt?: number
  messages?: unknown[]
}

export interface ProjectRecord {
  path: string
  name: string
  tasks: TaskRecord[]
}

interface SidebarProps {
  open: boolean
  onClose?: () => void
  // nav
  onNewTask: () => void
  searchOpen: boolean
  onToggleSearch: () => void
  searchQuery: string
  onSearchQuery: (q: string) => void
  searchResults: SearchResult[]
  onSearchJump: (r: SearchResult) => void
  projects: ProjectRecord[]
  /** Task that owns the active agent run — shown with a live indicator. */
  runningTaskId?: string | null
  onNewProject: () => void
  onOpenProject: (path: string) => void
  onOpenTask: (project: ProjectRecord, task: TaskRecord) => void
  onRenameTask?: (project: ProjectRecord, task: TaskRecord, newPrompt: string) => void
  onDeleteTask?: (project: ProjectRecord, task: TaskRecord) => void
  onRemoveProject?: (project: ProjectRecord) => void
  onSettings: () => void
  currentProjectPath: string | null
  /** Task currently open in the chat view — highlighted in the list. */
  activeTaskId?: string | null
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(ts).toLocaleDateString()
}

interface ContextMenuState {
  x: number
  y: number
  project: ProjectRecord
  task: TaskRecord
}

interface ProjectContextMenuState {
  x: number
  y: number
  project: ProjectRecord
}

export default function Sidebar(props: SidebarProps) {
  const [expandedProject, setExpandedProject] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<{ project: ProjectRecord; task: TaskRecord } | null>(null)
  const [confirmRemoveProject, setConfirmRemoveProject] = useState<ProjectRecord | null>(null)

  const contextMenuRef = useRef<HTMLDivElement>(null)
  const projectContextMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!contextMenu && !projectContextMenu) return
    const dismiss = (e: MouseEvent) => {
      const target = e.target as Node
      if (contextMenuRef.current?.contains(target) || projectContextMenuRef.current?.contains(target)) {
        return
      }
      setContextMenu(null)
      setProjectContextMenu(null)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
        setProjectContextMenu(null)
      }
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', handleKeyDown)

  return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu, projectContextMenu])


  // Bug 3: newest-first — projects by latest task activity, tasks by recency
  const sortedProjects = [...props.projects]
    .map((p) => ({ ...p, tasks: [...p.tasks].sort((a, b) =>
      ((b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))) }))
    .sort((a, b) => {
      const am = a.tasks[0] ? (a.tasks[0].updatedAt ?? a.tasks[0].createdAt) : 0
      const bm = b.tasks[0] ? (b.tasks[0].updatedAt ?? b.tasks[0].createdAt) : 0
      if (bm !== am) return bm - am
      return a.name.localeCompare(b.name)
    })
  return (
    <aside className={`sidebar ${props.open ? 'open' : 'closed'}`}>
      <div className="sidebar-mobile-header">
        <span className="sidebar-title">AnyBuff</span>
        <button
          type="button"
          className="icon-btn sidebar-close-btn"
          onClick={props.onClose}
          title="Close sidebar"
        >
          <XIcon size={16} />
        </button>
      </div>

      <div className="sidebar-top">
        <button
          className="nav-item new-task-btn"
          onClick={() => {
            props.onNewTask()
            props.onClose?.()
          }}
          title="New task"
        >
          <NotePenIcon size={16} />
          <span>New Task</span>
        </button>

        <button
          className={`nav-item search-trigger-btn ${props.searchOpen ? 'active' : ''}`}
          onClick={props.onToggleSearch}
          title="Search messages & files"
        >
          <SearchIcon size={15} />
          <span>Search</span>
        </button>

        {props.searchOpen && (
          <div className="search-box">
            <input
              autoFocus
              value={props.searchQuery}
              onChange={(e) => props.onSearchQuery(e.target.value)}
              placeholder="Search…"
              spellCheck={false}
            />
            {props.searchQuery && (
              <div className="search-results">
                {props.searchResults.length === 0 && <div className="panel-empty">No results found.</div>}
                {props.searchResults.slice(0, 60).map((r, i) => (
                  <button
                    key={r.key ?? `${r.taskId ?? 'current'}-${r.index}-${i}`}
                    className="search-result"
                    onClick={() => {
                      props.onSearchJump(r)
                      props.onClose?.()
                    }}
                    title={r.taskPrompt ? `${r.projectName ? `${r.projectName} • ` : ''}${r.taskPrompt}` : undefined}
                  >
                    <div className="search-result-row">
                      <span className="search-kind">{r.kind}</span>
                      <span className="search-text">{r.text}</span>
                    </div>
                    {r.taskPrompt && (
                      <div className="search-sub">
                        <span className="search-task-prompt">
                          {r.projectName ? `${r.projectName} / ` : ''}
                          {r.taskPrompt}
                        </span>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="nav-section-head">
          <span>Projects</span>
          <button className="mini-plus" onClick={props.onNewProject} title="Add Project">
            <FolderPlusIcon size={15} />
          </button>
        </div>
      </div>

      <div className="projects-list">
        {props.projects.length === 0 && <div className="nav-muted">No projects yet. Open a folder to start.</div>}
        {sortedProjects.map((p) => {
          const isOpen = expandedProject === p.path
          const isCurrent = p.path === props.currentProjectPath

          return (
            <div key={p.path} className={`project-item ${isCurrent ? 'current' : ''}`}>
              <div
                className="project-row"
                onClick={() => {
                  if (isOpen) setExpandedProject(null)
                  else {
                    setExpandedProject(p.path)
                    props.onOpenProject(p.path)
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const menuWidth = 130
                  const menuHeight = 44
                  const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8)
                  const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8)
                  setProjectContextMenu({ x, y, project: p })
                }}
                title={p.path}
              >
                {isOpen ? <FolderOpenIcon size={15} /> : <FolderIcon size={15} />}
                <span className="project-name-text">{p.name}</span>
                <button
                  className="project-new-task-btn"
                  title="New task"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onOpenProject(p.path)
                    props.onNewTask()
                    props.onClose?.()
                  }}
                >
                  <PlusIcon size={13} />
                </button>
                <button
                  type="button"
                  className="row-more-btn"
                  title="Project options"
                  onClick={(e) => {
                    e.stopPropagation()
                    const rect = e.currentTarget.getBoundingClientRect()
                    const menuWidth = 130
                    const menuHeight = 44
                    const x = Math.min(rect.right, window.innerWidth - menuWidth - 8)
                    const y = Math.min(rect.bottom + 4, window.innerHeight - menuHeight - 8)
                    setProjectContextMenu({ x, y, project: p })
                  }}
                >
                  ···
                </button>
              </div>
              {isOpen && (
                <div className="task-list">
                  {p.tasks.length === 0 && <div className="nav-muted small">No tasks</div>}
                  {p.tasks.map((t) =>
                    editingTaskId === t.id ? (
                      <div key={t.id} className="task-row editing" onClick={(e) => e.stopPropagation()}>
                        <input
                          className="task-rename-input"
                          value={editingText}
                          autoFocus
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => setEditingText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              const trimmed = editingText.trim()
                              if (trimmed && trimmed !== t.prompt) {
                                props.onRenameTask?.(p, t, trimmed)
                              }
                              setEditingTaskId(null)
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              setEditingTaskId(null)
                            }
                          }}
                          onBlur={() => {
                            const trimmed = editingText.trim()
                            if (trimmed && trimmed !== t.prompt) {
                              props.onRenameTask?.(p, t, trimmed)
                            }
                            setEditingTaskId(null)
                          }}
                        />
                      </div>
                    ) : (
                      <div
                        key={t.id}
                        role="button"
                        tabIndex={0}
                        className={`task-row ${props.activeTaskId === t.id ? 'active' : ''}`}
                        onClick={() => {
                          props.onOpenTask(p, t)
                          props.onClose?.()
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            props.onOpenTask(p, t)
                            props.onClose?.()
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          const menuWidth = 130
                          const menuHeight = 74
                          const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8)
                          const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8)
                          setContextMenu({ x, y, project: p, task: t })
                        }}
                        title={t.prompt}
                      >
                        {t.id === props.runningTaskId ? (
                          <span className="spinner-ring task-running-spinner" />
                        ) : null}
                        <span className="task-text">{t.prompt}</span>
                        <span className="task-time">{timeAgo(t.updatedAt ?? t.createdAt)}</span>
                        <button
                          type="button"
                          className="row-more-btn"
                          title="Task options"
                          onClick={(e) => {
                            e.stopPropagation()
                            const rect = e.currentTarget.getBoundingClientRect()
                            const menuWidth = 130
                            const menuHeight = 74
                            const x = Math.min(rect.right, window.innerWidth - menuWidth - 8)
                            const y = Math.min(rect.bottom + 4, window.innerHeight - menuHeight - 8)
                            setContextMenu({ x, y, project: p, task: t })
                          }}
                        >
                          ···
                        </button>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sidebar-bottom">
        <button
          className="nav-item"
          onClick={() => {
            props.onSettings()
            props.onClose?.()
          }}
        >
          <SettingsIcon size={15} />
          <span>Settings</span>
        </button>
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="task-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={(e) => {
              e.stopPropagation()
              const { task } = contextMenu
              setContextMenu(null)
              setEditingTaskId(task.id)
              setEditingText(task.prompt)
            }}
          >
            <EditIcon size={14} />
            <span>Rename</span>
          </button>
          <button
            type="button"
            className="context-menu-item danger"
            onClick={(e) => {
              e.stopPropagation()
              const { project, task } = contextMenu
              setContextMenu(null)
              setConfirmDeleteTask({ project, task })
            }}
          >
            <TrashIcon size={14} />
            <span>Delete</span>
          </button>
        </div>
      )}

      {projectContextMenu && (
        <div
          ref={projectContextMenuRef}
          className="task-context-menu"
          style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="context-menu-item danger"
            onClick={(e) => {
              e.stopPropagation()
              const target = projectContextMenu.project
              setProjectContextMenu(null)
              setConfirmRemoveProject(target)
            }}
          >
            <TrashIcon size={14} />
            <span>Remove</span>
          </button>
        </div>
      )}

      {confirmDeleteTask && (
        <div className="modal-backdrop" onClick={() => setConfirmDeleteTask(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete conversation?</h2>
            <p className="hint">
              Are you sure you want to delete &ldquo;{confirmDeleteTask.task.prompt}&rdquo;? This will permanently remove this conversation.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmDeleteTask(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                autoFocus
                onClick={() => {
                  const target = confirmDeleteTask
                  setConfirmDeleteTask(null)
                  props.onDeleteTask?.(target.project, target.task)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRemoveProject && (
        <div className="modal-backdrop" onClick={() => setConfirmRemoveProject(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Remove project?</h2>
            <p className="hint">
              Remove &ldquo;{confirmRemoveProject.name}&rdquo; from project history?
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmRemoveProject(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                autoFocus
                onClick={() => {
                  const target = confirmRemoveProject
                  setConfirmRemoveProject(null)
                  props.onRemoveProject?.(target)
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}