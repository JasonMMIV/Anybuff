import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import MessageQueuePanel, {
  type QueuedMessage,
} from '../src/renderer/src/components/MessageQueuePanel'

const item: QueuedMessage = {
  id: 'q1',
  text: 'try the blue theme',
  finalPrompt: 'try the blue theme',
  taskId: 'task-a',
  tabId: 'tab-a',
  cwd: '/tmp/project',
}

const baseProps = {
  items: [item],
  pausedIds: new Set<string>(),
  paused: false,
  running: true,
  onResume: () => {},
  onEdit: () => {},
  onDelete: () => {},
  onMove: () => {},
  onSendNext: () => {},
  onSendNow: () => {},
}

describe('MessageQueuePanel Send now', () => {
  test('enables Send now when the queued text can be steered', () => {
    const html = renderToStaticMarkup(
      <MessageQueuePanel {...baseProps} sendNowIds={new Set([item.id])} />
    )
    expect(html).toContain('queue-now-btn')
    expect(html).toContain('Send now — inject this message into the running turn')
    expect(html).toContain('aria-label="Send now"')
    expect(html).not.toContain('>Send now<')
    expect(html).not.toMatch(/class="queue-now-btn"[^>]*disabled/)
  })

  test('disables Send now when the queued text has baked context', () => {
    const html = renderToStaticMarkup(
      <MessageQueuePanel {...baseProps} sendNowIds={new Set()} />
    )
    expect(html).toContain('Only plain-text queued messages can be sent now')
    expect(html).toMatch(/class="queue-now-btn"[^>]*disabled/)
  })

  test('never enables Send now while the chat is idle', () => {
    const html = renderToStaticMarkup(
      <MessageQueuePanel {...baseProps} running={false} sendNowIds={new Set([item.id])} />
    )
    expect(html).toContain('Send now is available while this chat is running')
    expect(html).toMatch(/class="queue-now-btn"[^>]*disabled/)
  })
})
