import { describe, expect, test } from 'bun:test'

import { keepTailForCompaction } from '../compaction-tail'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const LF = String.fromCharCode(10)

const user = (text: string, tags?: string[]): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...(tags ? { tags } : {}),
})

const assistant = (text: string, toolCallId?: string): Message => ({
  role: 'assistant',
  content: toolCallId
    ? [
        { type: 'text', text },
        { type: 'tool-call', toolCallId, toolName: 'read_files', input: {} },
      ]
    : [{ type: 'text', text }],
})

const tool = (toolCallId: string): Message => ({
  role: 'tool',
  toolCallId,
  toolName: 'read_files',
  content: [{ type: 'json', value: { ok: true } }],
})

const roles = (messages: Message[]) => messages.map((m) => m.role)

const textOfFirstPart = (message: Message | undefined): string => {
  if (!message || !Array.isArray(message.content)) return ''
  const part = message.content[0]
  return part && part.type === 'text' ? part.text : ''
}

const MECHANICAL_SUMMARY_HEADER =
  'This is a summary of the conversation so far. The original messages have been condensed to save context space.'

describe('keepTailForCompaction', () => {
  test('returns [] when there is no assistant message', () => {
    expect(keepTailForCompaction({ messages: [user('a'), user('b')] })).toEqual(
      [],
    )
  })

  test('starts on an assistant message and carries its tool results', () => {
    const tail = keepTailForCompaction({
      messages: [
        user('do it'),
        assistant('working', 'call-1'),
        tool('call-1'),
        user('thanks'),
      ],
    })
    expect(roles(tail)).toEqual(['assistant', 'tool'])
    // The trailing user turn stays in the summary, never in the tail: the
    // summary is user-role, so a leading user message would repeat the role.
    expect(JSON.stringify(tail)).not.toContain('thanks')
  })

  test('keeps a mid-history USER_PROMPT out of the tail', () => {
    const tail = keepTailForCompaction({
      messages: [
        assistant('old', 'call-old'),
        tool('call-old'),
        user('also check auth', ['USER_PROMPT']),
        assistant('new', 'call-new'),
        tool('call-new'),
      ],
    })
    expect(roles(tail)).toEqual(['assistant', 'tool', 'assistant', 'tool'])
    expect(JSON.stringify(tail)).not.toContain('also check auth')
  })

  test('never returns an orphan tool result', () => {
    expect(
      keepTailForCompaction({ messages: [user('x'), tool('call-1')] }),
    ).toEqual([])
  })

  test('excludes per-step scaffolding', () => {
    const tail = keepTailForCompaction({
      messages: [
        user('prompt', ['USER_PROMPT']),
        user('step', ['STEP_PROMPT']),
        user('instructions', ['INSTRUCTIONS_PROMPT']),
        user('spawn', ['SUBAGENT_SPAWN']),
        assistant('done', 'call-1'),
        tool('call-1'),
      ],
    })
    expect(roles(tail)).toEqual(['assistant', 'tool'])
  })

  test('drops the oldest exchange when the budget is exceeded', () => {
    const huge = 'x'.repeat(40_000)
    const tail = keepTailForCompaction({
      messages: [
        assistant(huge, 'call-old'),
        tool('call-old'),
        assistant('newest', 'call-new'),
        tool('call-new'),
      ],
      maxTokens: 1_000,
    })
    expect(roles(tail)).toEqual(['assistant', 'tool'])
    expect(textOfFirstPart(tail[0])).toBe('newest')
  })

  test('returns [] when even the newest exchange exceeds the budget', () => {
    expect(
      keepTailForCompaction({
        messages: [assistant('y'.repeat(40_000))],
        maxTokens: 100,
      }),
    ).toEqual([])
  })

  test('keeps reasoning and tool calls of an assistant exchange intact', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'why' },
          { type: 'text', text: 'reading' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'read_files',
            input: {},
          },
        ],
      },
      tool('c1'),
    ]
    const tail = keepTailForCompaction({ messages })
    expect(tail).toHaveLength(2)
    expect(
      (tail[0]?.content as Array<{ type: string }>).some(
        (part) => part.type === 'reasoning',
      ),
    ).toBe(true)
  })

  test('does not merge exchanges across a mechanical summary', () => {
    const summary: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<conversation_summary>${LF}${MECHANICAL_SUMMARY_HEADER}${LF}</conversation_summary>`,
        },
      ],
    }
    const tail = keepTailForCompaction({
      messages: [
        assistant('old', 'call-old'),
        tool('call-old'),
        summary,
        assistant('new', 'call-new'),
        tool('call-new'),
      ],
    })

    // Both exchanges fit, but they stay two separate exchanges and the
    // summary envelope itself is never tail material.
    expect(roles(tail)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
    ])
    expect(textOfFirstPart(tail[0])).toBe('old')
    expect(textOfFirstPart(tail[2])).toBe('new')
    expect(JSON.stringify(tail)).not.toContain('<conversation_summary>')
  })

  test('a user message that only mentions the tag still bounds an exchange', () => {
    const tail = keepTailForCompaction({
      messages: [
        assistant('old', 'call-old'),
        tool('call-old'),
        user('<conversation_summary> is a string this code uses'),
        assistant('new', 'call-new'),
        tool('call-new'),
      ],
    })

    expect(roles(tail)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
    ])
    expect(textOfFirstPart(tail[0])).toBe('old')
    expect(textOfFirstPart(tail[2])).toBe('new')
  })

  test('a user-role TOOL_CALL_ERROR ends the exchange and stays out of the tail', () => {
    const tail = keepTailForCompaction({
      messages: [
        assistant('attempt', 'call-1'),
        user('bad tool input', ['TOOL_CALL_ERROR']),
        tool('call-1'),
      ],
    })
    expect(roles(tail)).toEqual(['assistant'])
    expect(tail.some((m) => m.tags?.includes('TOOL_CALL_ERROR'))).toBe(false)
  })
})
