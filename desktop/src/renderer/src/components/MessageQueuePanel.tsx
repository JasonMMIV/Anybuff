import { useEffect, useRef, useState } from 'react'
import { ArrowUpIcon, BoltIcon, ChevronDownIcon, XIcon } from './Icons'
import type { Attachment } from './Composer'

/**
 * Execution-time message queue (#2).
 *
 * While a run is in flight, newly submitted messages are parked here instead
 * of being rejected. When the current turn ends the first queued message is
 * dispatched automatically. Items can be edited inline, sent into the running
 * turn now, reordered, promoted to "next" and deleted before they run.
 */
export interface QueuedMessage {
  id: string
  /** What the user typed (shown while editing / persisted as task title source). */
  text: string
  /** Fully expanded prompt (@file contents etc.) captured at enqueue time. */
  finalPrompt: string
  /** Snapshot of the attachments this message was queued with — kept so an
   * inline edit re-bakes them without re-attaching. */
  attachments?: Attachment[]
  /** Conversation (or draft tab) and project this message belongs to. */
  taskId?: string | null
  tabId?: string | null
  cwd?: string
  /** Agent mode captured when the message was queued (background dispatch). */
  mode?: 'default' | 'plan' | 'chat'
  /** Model/effort snapshot captured with the same turn, so later tab edits do
   *  not retroactively change a queued message. */
  model?: string
  reasoningEffort?: string
}

interface MessageQueuePanelProps {
  items: QueuedMessage[]
  /** Ids held by a per-conversation ADR-30 pause. */
  pausedIds?: ReadonlySet<string>
  /** True when this view owns at least one paused item. */
  paused?: boolean
  /** True while this chat's turn is in flight. */
  running: boolean
  /** Ids whose queued text can be injected into the live run right now. */
  sendNowIds: ReadonlySet<string>
  onResume?: () => void
  onEdit: (id: string, text: string) => void
  onDelete: (id: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onSendNext: (id: string) => void
  onSendNow: (id: string) => void
}

export default function MessageQueuePanel({ items, pausedIds, paused, running, sendNowIds, onResume, onEdit, onDelete, onMove, onSendNext, onSendNow }: MessageQueuePanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const editRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editingId) return
    const el = editRef.current
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [editingId])

  if (items.length === 0) return null
  const nextIndex = items.findIndex((item) => !pausedIds?.has(item.id))

  return (
    <div className="queue-panel">
      <button type="button" className="queue-panel-header" onClick={() => setCollapsed((c) => !c)} title={collapsed ? 'Expand' : 'Collapse'}>
        <BoltIcon size={12} />
        <span>{items.length} queued{paused ? ' (paused)' : ''}</span>
        <span className="queue-panel-hint">
          {paused
            ? 'paused after stop — resume this chat’s queue to continue'
            : 'sent automatically when this chat’s turn finishes'}
        </span>
        <ChevronDownIcon size={12} className={`queue-chevron${collapsed ? '' : ' open'}`} />
      </button>

      {!collapsed && paused && items.length > 0 && (
        <div className="queue-paused-row">
          <span aria-hidden="true">⏸</span>
          <span>Queue paused — held messages will not auto-send after you stopped the run.</span>
          <button
            type="button"
            className="mini-btn"
            title="Resume the queue now (starts the first held message)"
            onClick={() => {
              onResume?.()
            }}
          >
            Resume
          </button>
        </div>
      )}

      {!collapsed && items.length > 0 && (
        <div className="queue-items">
          {items.map((item, i) => {
            const itemPaused = pausedIds?.has(item.id) === true
            const canSendNow = running && sendNowIds.has(item.id)
            const sendNowTitle = canSendNow
              ? 'Send now — inject this message into the running turn'
              : running
                ? 'Only plain-text queued messages can be sent now'
                : 'Send now is available while this chat is running'
            const isNext = i === nextIndex
            return (
              <div
                key={item.id}
                className={`queue-item${isNext ? ' next' : ''}${itemPaused ? ' paused' : ''}`}
              >
                <span
                  className="queue-order"
                  title={
                    itemPaused
                      ? 'Paused until you resume'
                      : isNext
                        ? 'Sends next'
                        : `Position ${i + 1}`
                  }
                >
                  {itemPaused ? '⏸' : isNext ? 'next' : i + 1}
                </span>

                {editingId === item.id ? (
                  <textarea
                    ref={editRef}
                    className="queue-edit"
                    value={draft}
                    rows={2}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        const text = draft.trim()
                        if (text) onEdit(item.id, text)
                        setEditingId(null)
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditingId(null)
                      }
                    }}
                    onBlur={() => {
                      const text = draft.trim()
                      if (text && text !== item.text) onEdit(item.id, text)
                      setEditingId(null)
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="queue-text"
                    title="Click to edit (note: attachments captured at enqueue time are kept)"
                    onClick={() => {
                      setDraft(item.text)
                      setEditingId(item.id)
                    }}
                  >
                    {item.text}
                  </button>
                )}

                <div className="queue-actions">
                  <button
                    type="button"
                    className="queue-now-btn"
                    title={sendNowTitle}
                    aria-label="Send now"
                    disabled={!canSendNow}
                    onClick={() => onSendNow(item.id)}
                  >
                    <ArrowUpIcon size={12} />
                  </button>
                  {i > 0 && (
                    <button
                      type="button"
                      className="mini-btn"
                      title="Send next in this chat"
                      onClick={() => onSendNext(item.id)}
                    >
                      <ArrowUpIcon size={11} />
                    </button>
                  )}
                  {i > 0 && (
                    <button
                      type="button"
                      className="mini-btn"
                      title="Move up"
                      onClick={() => onMove(item.id, -1)}
                    >
                      ↑
                    </button>
                  )}
                  {i < items.length - 1 && (
                    <button
                      type="button"
                      className="mini-btn"
                      title="Move down"
                      onClick={() => onMove(item.id, 1)}
                    >
                      ↓
                    </button>
                  )}
                  <button type="button" className="mini-btn danger" title="Remove from queue" onClick={() => onDelete(item.id)}>
                    <XIcon size={11} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
