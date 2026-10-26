import { assistantMessage, systemMessage, userMessage } from '@codebuff/common/util/messages'
import { describe, expect, test } from 'bun:test'

import { filterInheritedHistory } from '../util/message-history-filter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => logger,
} as any

const userPrompt = (text: string) =>
  userMessage({ content: text, tags: ['USER_PROMPT'] })

const reasoning = (text: string) => ({ type: 'reasoning' as const, text })
const textPart = (text: string) => ({ type: 'text' as const, text })
const toolCall = (toolCallId: string, toolName = 'read_files') => ({
  type: 'tool-call' as const,
  toolCallId,
  toolName,
  input: { paths: ['src/a.ts'] },
})

const toolResult = (toolCallId: string): Message =>
  ({
    role: 'tool',
    toolName: 'read_files',
    toolCallId,
    content: [{ type: 'json', value: { ok: true } }],
  }) as Message

const filter = (messages: Message[]) =>
  filterInheritedHistory({ messages, filter: 'review-context', logger })

describe('filterInheritedHistory', () => {
  test('drops earlier-turn reasoning but keeps visible text and tool calls', () => {
    const messages = [
      userPrompt('first request'),
      assistantMessage({
        content: [
          reasoning('secret plan'),
          textPart('Option A or option B?'),
          toolCall('call-1'),
        ],
      }),
      toolResult('call-1'),
      userPrompt('second request'),
      assistantMessage('Let me get a review.'),
    ]

    const filtered = filter(messages)

    expect(filtered[0]).toBe(messages[0])
    expect(filtered[1].content).toEqual([
      textPart('Option A or option B?'),
      toolCall('call-1'),
    ])
    expect(filtered[2]).toBe(messages[2])
  })

  test('keeps current-turn narration and drops only its reasoning', () => {
    const messages = [
      userPrompt('request'),
      assistantMessage({
        content: [
          reasoning('current thinking'),
          textPart('Reading the files now.'),
          toolCall('call-2'),
        ],
      }),
      toolResult('call-2'),
      assistantMessage('Let me get a review.'),
    ]

    const filtered = filter(messages)

    expect(filtered[1].content).toEqual([
      textPart('Reading the files now.'),
      toolCall('call-2'),
    ])
  })

  test('drops a message that contained nothing but reasoning', () => {
    const messages = [
      userPrompt('request'),
      assistantMessage({ content: [reasoning('nothing else')] }),
      assistantMessage({
        content: [reasoning('more thinking'), textPart('Visible update.')],
      }),
      userMessage('a plain follow-up'),
      assistantMessage('Final line.'),
    ]

    const filtered = filter(messages)

    expect(filtered).toHaveLength(4)
    expect(filtered[1].content).toEqual([textPart('Visible update.')])
  })

  test('replays the final assistant run verbatim', () => {
    const finalRun = [
      assistantMessage({ content: [reasoning('last thoughts')] }),
      assistantMessage('Let me get a review.'),
    ]
    const messages = [
      userPrompt('first request'),
      assistantMessage({
        content: [reasoning('earlier'), textPart('Here is the plan.')],
      }),
      userMessage('a plain follow-up'),
      ...finalRun,
    ]

    const filtered = filter(messages)

    expect(filtered.slice(-2)).toEqual(finalRun)
    expect(filtered[1].content).toEqual([textPart('Here is the plan.')])
  })

  test('leaves non-assistant messages and string content untouched', () => {
    const messages = [
      systemMessage('system prompt'),
      userMessage('plain user text'),
    ]

    const filtered = filter(messages)

    expect(filtered).toEqual(messages)
    expect(filtered[0]).toBe(messages[0])
    expect(filtered[1]).toBe(messages[1])
  })

  test('does not mutate the input history', () => {
    const messages = [
      userPrompt('request'),
      assistantMessage({
        content: [reasoning('secret'), textPart('visible')],
      }),
      toolResult('call-4'),
      assistantMessage('Final line.'),
    ]
    const snapshot = JSON.parse(JSON.stringify(messages))

    filter(messages)

    expect(messages).toEqual(snapshot)
    expect(messages[1].content).toHaveLength(2)
  })

  test('returns an empty array for an empty history', () => {
    expect(filter([])).toEqual([])
  })

  test('renders subagent edits into a readable block', () => {
    const messages: Message[] = [
      userPrompt('request'),
      assistantMessage({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'spawn-1',
            toolName: 'spawn_agents',
            input: { agents: [{ agent_type: 'editor' }] },
          } as any,
        ],
      }) as Message,
      {
        role: 'tool',
        toolName: 'spawn_agents',
        toolCallId: 'spawn-1',
        content: [
          {
            type: 'json',
            value: [
              {
                agentName: 'Code Editor',
                agentType: 'editor',
                value: {
                  type: 'structuredOutput',
                  value: {
                    output: {
                      messages: [
                        {
                          role: 'assistant',
                          content: [
                            { type: 'reasoning', text: 'private plan' },
                            {
                              type: 'tool-call',
                              toolCallId: 'edit-1',
                              toolName: 'str_replace',
                              input: {
                                path: 'src/a.ts',
                                replacements: [
                                  { oldString: 'old line', newString: 'new line' },
                                ],
                              },
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        ],
      } as unknown as Message,
    ]

    const filtered = filter(messages)
    const report = (filtered[2] as any).content[0].value[0]

    expect(report.rendered).toContain('old line')
    expect(report.rendered).toContain('new line')
    expect(report.rendered).not.toContain('private plan')
    expect(report.value).toBeUndefined()
  })

  test('does not render subagent results for a non-review filter', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        toolName: 'spawn_agents',
        toolCallId: 'spawn-1',
        content: [
          {
            type: 'json',
            value: [
              {
                agentName: 'Code Editor',
                agentType: 'editor',
                value: {
                  type: 'structuredOutput',
                  value: { output: { messages: [] } },
                },
              },
            ],
          },
        ],
      } as unknown as Message,
    ]

    // `review-context` is the only registered filter today; the cast guards the
    // renderer against future filters inheriting it by accident.
    const filtered = filterInheritedHistory({
      messages,
      filter: 'future-filter' as unknown as 'review-context',
      logger,
    })

    expect(filtered[0]).toBe(messages[0])
  })
})
