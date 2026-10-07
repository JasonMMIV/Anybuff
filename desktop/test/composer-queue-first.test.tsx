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
  totalCost: 0,
  fileCandidates: [],
  skills: [],
  agentMentions: [],
  onReviewRequest: () => {},
  onArmInterview: () => {},
  onDisarmInterview: () => {},
  onInitKnowledge: () => {}
}

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
