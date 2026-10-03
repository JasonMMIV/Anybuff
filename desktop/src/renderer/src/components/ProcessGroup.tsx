import { memo } from 'react'
import { TriangleIcon } from './Icons'

/**
 * 過程收闔 (process folding): collapsible shell folding every non-prose block of
 * one work segment — thinking cards, tool cards, the streaming placeholder —
 * behind a single header. The triangle points right while collapsed (`>`) and
 * down once expanded (`v`); the label flips from `Working` (＋ the CSS three-dot
 * bounce) to `Worked` when the segment's thinking and/or tools finish (the verdict
 * comes from `utils/chat-groups.ts`, not from this component).
 */
export const ProcessGroup = memo(function ProcessGroup({
  live,
  open,
  onToggle,
  children,
}: {
  live: boolean
  open: boolean
  onToggle: () => void
  children?: React.ReactNode
}) {
  return (
    <div
      className={`process-group${open ? ' open' : ''}${live ? ' live' : ''}`}
    >
      <div
        className="process-head"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        title={open ? 'Collapse this step' : 'Expand this step'}
        role="button"
        tabIndex={0}
        aria-expanded={open}
      >
        <span className="process-triangle" aria-hidden="true">
          <TriangleIcon open={open} size={9} />
        </span>
        <span className="process-label">{live ? 'Working' : 'Worked'}</span>
        {live && <ThinkingDots compact />}
      </div>
      {open && <div className="process-body">{children}</div>}
    </div>
  )
})

/**
 * The streaming "…" affordance — CSS three-dot bounce, not an SVG glyph (see the
 * runtime icon matrix). `compact` is the inline variant that sits after a
 * `Working` label; without it the dots keep the roomier padding of the
 * standalone "stream started, no text yet" placeholder row.
 */
export const ThinkingDots = memo(function ThinkingDots({
  compact = false,
}: {
  compact?: boolean
}) {
  return (
    <div className={`thinking-dots${compact ? ' thinking-dots-compact' : ''}`}>
      <span />
      <span />
      <span />
    </div>
  )
})
