import { compactConfirmState } from '../utils/compact-confirm'
import { formatTokenCount } from '../utils/format-tokens'
import { XIcon } from './Icons'

/**
 * Manual `/compact` confirmation. Compaction is not read-only — the model's
 * memory becomes the summary — so it takes one explicit confirmation, with the
 * current context usage so the user can judge whether it is worth it.
 */
interface CompactConfirmModalProps {
  used: number
  max: number
  running: boolean
  onClose: () => void
  onConfirm: () => void
}

export default function CompactConfirmModal({
  used,
  max,
  running,
  onClose,
  onConfirm,
}: CompactConfirmModalProps) {
  const state = compactConfirmState({ used, max, running })

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="review-scope-head">
          <h2>Compact this conversation?</h2>
          <button className="chip-x" onClick={onClose} title="Close">
            <XIcon size={12} />
          </button>
        </div>
        <p className="review-scope-hint">
          Earlier messages will be replaced by a summary. The transcript stays
          visible in this chat, but the model will continue from the summary —
          details it leaves out are lost to the model.
        </p>
        <p className="review-scope-hint">
          Current context: {formatTokenCount(used)} / {formatTokenCount(max)}{' '}
          tokens
        </p>
        {state.note && <p className="review-scope-hint">{state.note}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={onConfirm}
            disabled={!state.canConfirm}
          >
            Compact
          </button>
        </div>
      </div>
    </div>
  )
}
