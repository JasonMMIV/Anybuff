import { useEffect, useRef, useState } from 'react'
import { ArrowUpIcon, BoltIcon, ChevronDownIcon, XIcon } from './Icons'

/**
 * Execution-time message queue (#2).
 *
 * While a run is in flight, newly submitted messages are parked here instead
 * of being rejected. When the current turn ends the first queued message is
 * dispatched automatically. Items can be edited inline, reordered, promoted to
 * "next" and deleted before they run.
 */
export interface QueuedMessage {
  id: string
  /** What the user typed (shown while editing / persisted as task title source). */
  text: string
  /** Fully expanded prompt (@file contents etc.) captured at enqueue time. */
  finalPrompt: string
}

interface MessageQueuePanelProps {
  items: QueuedMessage[]
  onEdit: (id: string, text: string) => void
  onDelete: (id: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onSendNext: (id: string) => void
}

export default function MessageQueuePanel({ items, onEdit, onDelete, onMove, onSendNext }: MessageQueuePanelProps) {
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

  return (
    <div className="queue-panel">
      <button type="button" className="queue-panel-header" onClick={() => setCollapsed((c) => !c)} title={collapsed ? 'Expand' : 'Collapse'}>
        <BoltIcon size={12} />
        <span>{items.length} queued</span>
        <span className="queue-panel-hint">sent automatically when the current turn finishes</span>
        <ChevronDownIcon size={12} className={`queue-chevron${collapsed ? '' : ' open'}`} />
      </button>

      {!collapsed && (
        <div className="queue-items">
          {items.map((item, i) => (
            <div key={item.id} className={`queue-item${i === 0 ? ' next' : ''}`}>
              <span className="queue-order" title={i === 0 ? 'Sends next' : `Position ${i + 1}`}>
                {i === 0 ? 'next' : i + 1}
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
                {i > 0 && (
                  <button type="button" className="mini-btn" title="Promote to next" onClick={() => onSendNext(item.id)}>
                    <ArrowUpIcon size={11} />
                  </button>
                )}
                {i > 0 && (
                  <button type="button" className="mini-btn" title="Move up" onClick={() => onMove(item.id, -1)}>
                    ↑
                  </button>
                )}
                {i < items.length - 1 && (
                  <button type="button" className="mini-btn" title="Move down" onClick={() => onMove(item.id, 1)}>
                    ↓
                  </button>
                )}
                <button type="button" className="mini-btn danger" title="Remove from queue" onClick={() => onDelete(item.id)}>
                  <XIcon size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
