/**
 * ADR-30 queue-first composer contract.
 *
 * The mid-turn steering port must never take the queue away from a running
 * turn: while a run is in flight the primary button stays the QUEUE button
 * (plus glyph / "Queue this message", fed by plain Enter), and the Send now
 * entry is purely ADDITIVE — it only appears when the running turn can take a
 * plain-text steer (`steerable`). Rendered through react-dom/server so the
 * invariant is checked on the actual markup without a DOM harness.
 */

import { describe, test, expect } from 'bun:test'
import { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Composer, { type AgentMode } from '../src/renderer/src/components/Composer'

const base = {
  prompt: 'make it blue',
  onChange: () => {},
  onSend: () => {},
  onSendNow: () => {},
  onStop: () => {},
  running: true,
  disabled: false,
  attachments: [],
  onAttachFiles: () => {},
  onAttachFilesPath: () => {},
  onAttachFilesPaths: () => {},
  onPasteImages: () => {},
  onRemoveAttachment: () => {},
  providers: [{ id: 'p', label: 'P', models: ['m'] }],
  activeModel: 'p/m',
  onModelChange: () => {},
  reasoningEffort: 'default',
  onReasoningChange: () => {},
  agentMode: 'default' as AgentMode,
  onAgentModeChange: () => {},
  tokenUsage: null,
  taskCostUsd: 0,
  fileCandidates: [],
  skills: [],
  agentMentions: [],
  onReviewRequest: () => {},
  onArmInterview: () => {},
  onDisarmInterview: () => {},
  onInitKnowledge: () => {}
}

describe('Composer per-task cost badge', () => {
  test('shows the viewed task cost in USD', () => {
    const html = renderToStaticMarkup(<Composer {...base} taskCostUsd={0.04} />)
    expect(html).toContain('$0.04')
    expect(html).toContain('title="Total cost for this conversation')
  })

  test('hides the badge when the task has no cost', () => {
    const html = renderToStaticMarkup(<Composer {...base} />)
    expect(html).not.toContain('cost-badge')
  })
})

/**
 * Render through the renderer's Android branch. `useIsWebView` looks at
 * `document.documentElement` (main.tsx adds `.is-webview` before React mounts
 * in the WebView), which bun has no DOM for — stub it for the render only.
 */
function renderWebView(node: ReactElement): string {
  const g = globalThis as { document?: unknown }
  const previous = g.document
  g.document = { documentElement: { classList: { contains: (c: string) => c === 'is-webview' } } }
  try {
    return renderToStaticMarkup(node)
  } finally {
    if (previous === undefined) delete g.document
    else g.document = previous
  }
}

describe('Composer Android one-row toolbar', () => {
  test('folds the cost into the token pill instead of a second toolbar item', () => {
    const html = renderWebView(
      <Composer {...base} tokenUsage={{ used: 1234, max: 200000 }} taskCostUsd={0.42} />
    )
    expect(html).toContain('token-cost-mini')
    expect(html).toContain('$0.42')
    // A separate badge would be a second flex item in `.toolbar-right` — the
    // exact shape that wrapped the toolbar onto two rows on phones.
    expect(html).not.toContain('cost-badge')
  })

  test('keeps the standalone badge when there is no token ring to fold into', () => {
    const html = renderWebView(<Composer {...base} tokenUsage={null} taskCostUsd={0.42} />)
    expect(html).toContain('cost-badge')
    expect(html).not.toContain('token-cost-mini')
  })
})

describe('Composer queue-first contract (ADR-30)', () => {
  test('mid-run, the primary button still queues the message', () => {
    const html = renderToStaticMarkup(<Composer {...base} steerable />)
    expect(html).toContain('btn primary send-btn queue-send-btn')
    expect(html).toContain('Queue this message')
  })

  test('mid-run without a steerable turn, the primary queue button stands alone', () => {
    const html = renderToStaticMarkup(<Composer {...base} />)
    expect(html).not.toContain('send-now-btn')
    expect(html).toContain('btn primary send-btn queue-send-btn')
  })

  test('a steerable running turn adds the Send now entry next to the queue button', () => {
    const html = renderToStaticMarkup(<Composer {...base} steerable />)
    expect(html).toContain('send-now-btn')
    expect(html).toContain('inject into the running task')
    // The add-on must not be the primary (accent) button — queue stays primary.
    expect(html).toContain('class="btn send-btn send-now-btn"')
  })

  test('nothing is rendered above the input for the steer entry (button title carries it)', () => {
    const html = renderToStaticMarkup(<Composer {...base} steerable />)
    expect(html).not.toContain('steer-hint')
    // The affordance lives in the button's own tooltip instead.
    expect(html).toContain('Send now — inject into the running task')
  })

  test('with no run in flight the idle send button is untouched (no Send now entry)', () => {
    const html = renderToStaticMarkup(<Composer {...base} running={false} />)
    expect(html).not.toContain('send-now-btn')
    expect(html).not.toContain('queue-send-btn')
    expect(html).toContain('Send (Enter)')
  })
})
