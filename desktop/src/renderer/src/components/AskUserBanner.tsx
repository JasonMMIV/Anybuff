import { useState } from 'react'

type AskUserQuestion = {
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

type AskUserAnswer = {
  questionIndex: number
  selectedOption?: string
  selectedOptions?: string[]
  otherText?: string
}

/**
 * Banner shown while an ask_user tool override waits for the user's answers.
 * Renders each question as a radio (single) / checkbox (multi) group with an
 * optional "Other…" free-text fallback, plus Submit / Skip actions.
 */
export default function AskUserBanner({
  questions,
  onRespond,
}: {
  questions: Array<Record<string, any>>
  onRespond: (payload: { answers?: AskUserAnswer[]; skipped?: boolean }) => void
}) {
  const [selections, setSelections] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const [collapsed, setCollapsed] = useState(false)

  const submit = () => {
    if (collapsed) return
    const answers: AskUserAnswer[] = []
    questions.forEach((q, qi) => {
      const sel = selections[qi] ?? []
      const o = other[qi]
      if (typeof o === 'string' && o.trim()) {
        answers.push({ questionIndex: qi, otherText: o.trim() })
        return
      }
      if (q.multiSelect === true) {
        if (sel.length > 0) answers.push({ questionIndex: qi, selectedOptions: sel })
        return
      }
      if (sel[0] !== undefined) answers.push({ questionIndex: qi, selectedOption: sel[0] })
    })
    onRespond(answers.length > 0 ? { answers } : { skipped: true })
  }

  return (
    <div className="resume-banner" style={{ border: '1px solid var(--accent)', flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="resume-text">
          <strong>The agent has questions</strong>
          <span style={{ color: 'var(--text-2)', fontWeight: 400 }}> — {questions.length} question{questions.length > 1 ? 's' : ''}</span>
        </span>
        <button
          className="mini-btn"
          title={collapsed ? 'Expand' : 'Collapse'}
          onClick={() => setCollapsed((v) => !v)}
          style={{ flexShrink: 0 }}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && questions.map((q: any, qi: number) => {
        const opts: any[] = Array.isArray(q.options) ? q.options : []
        const sel = selections[qi] ?? []
        const multi = q.multiSelect === true
        return (
          <fieldset key={qi} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', margin: 0 }}>
            <legend style={{ padding: '0 6px', fontSize: 12.5, color: 'var(--text-1)' }}>
              {q.header || `Q${qi + 1}`}
            </legend>
            <div style={{ fontSize: 13.5, marginBottom: 6 }}>{q.question}</div>
            {opts.map((o: any, oi: number) => (
              <label key={oi} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 2px', cursor: 'pointer' }}>
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={`ask-${qi}`}
                  checked={sel.includes(o.label)}
                  onChange={() =>
                    setSelections((prev) => {
                      if (!multi) return { ...prev, [qi]: [o.label] }
                      const cur = prev[qi] ?? []
                      return { ...prev, [qi]: cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label] }
                    })
                  }
                />
                <span>
                  <span>{o.label}</span>
                  {o.description && (
                    <span style={{ display: 'block', color: 'var(--text-2)', fontSize: 12 }}>{o.description}</span>
                  )}
                </span>
              </label>
            ))}
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <input
                type="checkbox"
                checked={other[qi] !== undefined}
                onChange={(e) =>
                  setOther((prev) => ({ ...prev, [qi]: e.target.checked ? '' : undefined as any }))
                }
              />
              <span style={{ fontSize: 13 }}>Other…</span>
            </label>
            {other[qi] !== undefined && (
              <input
                className="task-rename-input"
                style={{ width: '100%', marginTop: 4 }}
                value={other[qi] ?? ''}
                placeholder="Type your own answer"
                onChange={(e) => setOther((prev) => ({ ...prev, [qi]: e.target.value }))}
              />
            )}
          </fieldset>
        )
      })}
      {!collapsed && (
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary small" onClick={submit}>
          Submit answers
        </button>
        <button
          className="btn ghost small"
          onClick={() => onRespond({ skipped: true })}
        >
          Skip
        </button>
      </div>
      )}
    </div>
  )
}
