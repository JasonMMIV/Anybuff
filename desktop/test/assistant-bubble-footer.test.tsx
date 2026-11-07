/**
 * Final-answer footer contract: only the turn's final assistant bubble owns the
 * timestamp + copy footer. Transitional narration between tool calls renders
 * no footer at all (see BodyNode.isFinal in utils/chat-groups).
 */

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantBubble } from '../src/renderer/src/components/ChatMessage'

const TS = Date.UTC(2026, 10, 7, 12, 0, 0)

describe('AssistantBubble footer', () => {
  test('non-final messages render neither timestamp nor copy button', () => {
    const html = renderToStaticMarkup(
      <AssistantBubble
        text="Let me read the file first."
        streaming={false}
        ts={TS}
        isFinal={false}
      />,
    )

    expect(html).toContain('Let me read the file first.')
    expect(html).not.toContain('msg-footer')
    expect(html).not.toContain('msg-time')
    expect(html).not.toContain('title="Copy"')
  })

  test('the final message keeps the timestamp and copy button', () => {
    const html = renderToStaticMarkup(
      <AssistantBubble
        text="Done."
        streaming={false}
        ts={TS}
        isFinal
      />,
    )

    expect(html).toContain('msg-footer')
    expect(html).toContain('msg-time')
    expect(html).toContain('title="Copy"')
  })

  test('plan-only final messages keep their timestamp', () => {
    const html = renderToStaticMarkup(
      <AssistantBubble
        text="<PLAN>Do the thing</PLAN>"
        streaming={false}
        ts={TS}
        isFinal
      />,
    )

    expect(html).toContain('msg-footer')
    expect(html).toContain('msg-time')
    expect(html).not.toContain('title="Copy"')
  })
})
