import { useState } from 'react'

import {
  REVIEW_SCOPE_OPTIONS,
  type ReviewScope,
} from '../utils/prompt-builders'
import { XIcon } from './Icons'

/**
 * Scope picker for the /review command (#5 第二批), mirroring the upstream
 * CLI's ReviewScreen presets: conversation / uncommitted / branch vs main /
 * custom focus. Picking a preset immediately runs the review on the currently
 * selected model.
 */
interface ReviewScopePanelProps {
  onClose: () => void
  onRun: (scope: ReviewScope, customInput?: string) => void
}

export default function ReviewScopePanel({
  onClose,
  onRun,
}: ReviewScopePanelProps) {
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')

  const runCustom = () => {
    if (!customText.trim()) return
    onRun('custom', customText)
  }

  return (
    <div className="modal-backdrop review-scope-backdrop" onClick={onClose}>
      <div
        className="modal review-scope-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="review-scope-head">
          <h2>Code review</h2>
          <button className="chip-x" onClick={onClose} title="Close">
            <XIcon size={12} />
          </button>
        </div>
        <p className="review-scope-hint">
          Choose what the reviewer should look at — it runs on your selected
          model.
        </p>

        {!customOpen ? (
          <div className="review-scope-list">
            {REVIEW_SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                className="review-scope-item"
                onClick={() => {
                  if (opt.id === 'custom') {
                    setCustomOpen(true)
                  } else {
                    onRun(opt.id)
                  }
                }}
              >
                <span className="review-scope-label">{opt.label}</span>
                <span className="review-scope-desc">{opt.description}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="review-scope-custom">
            <textarea
              autoFocus
              rows={3}
              value={customText}
              placeholder="e.g. the retry logic in llm.ts — focus on error handling and edge cases"
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  runCustom()
                }
                if (e.key === 'Escape') onClose()
              }}
            />
            <div className="modal-actions">
              <button className="btn" onClick={() => setCustomOpen(false)}>
                Back
              </button>
              <button
                className="btn primary"
                onClick={runCustom}
                disabled={!customText.trim()}
              >
                Run review
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
