import { describe, expect, test } from 'bun:test'

import {
  renderAgentOutput,
  renderSubagentToolMessage,
} from '../util/render-subagent-output'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const spawnMessage = (reports: unknown[]): Message =>
  ({
    role: 'tool',
    toolName: 'spawn_agents',
    toolCallId: 'spawn-1',
    content: [{ type: 'json', value: reports }],
  }) as unknown as Message

const editorReport = (messages: unknown[]) => ({
  agentName: 'Code Editor',
  agentType: 'editor',
  value: { type: 'structuredOutput', value: { output: { messages } } },
})

const editCall = (overrides: Record<string, unknown> = {}) => ({
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: 'edit-1',
      toolName: 'str_replace',
      input: {
        path: 'src/a.ts',
        replacements: [{ oldString: 'const a = 1', newString: 'const a = 2' }],
      },
      ...overrides,
    },
  ],
})

const editResult = () => ({
  role: 'tool',
  toolName: 'str_replace',
  toolCallId: 'edit-1',
  content: [
    {
      type: 'json',
      value: { file: 'src/a.ts', message: 'Successfully replaced 1 occurrence' },
    },
  ],
})

const firstReport = (message: Message) =>
  (message as any).content[0].value[0]

describe('renderSubagentToolMessage', () => {
  test('expands editor edits into readable old/new strings', () => {
    const message = spawnMessage([
      editorReport([editCall(), editResult()]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.agentName).toBe('Code Editor')
    expect(report.agentType).toBe('editor')
    expect(report.rendered).toContain('const a = 1')
    expect(report.rendered).toContain('const a = 2')
    expect(report.rendered).toContain('Successfully replaced 1 occurrence')
    expect(report.value).toBeUndefined()
  })

  test('drops reasoning but keeps visible text inside the subagent transcript', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'private plan' },
            { type: 'text', text: 'I will update the constant.' },
            {
              type: 'tool-call',
              toolCallId: 'edit-1',
              toolName: 'str_replace',
              input: {
                path: 'src/a.ts',
                replacements: [{ oldString: 'a', newString: 'b' }],
              },
            },
          ],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('I will update the constant.')
    expect(report.rendered).not.toContain('private plan')
  })

  test('never leaks a reasoning-only transcript through fail-open', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'secret plan' }],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('no visible output')
    expect(report.rendered).not.toContain('secret plan')
    expect(report.value).toBeUndefined()
  })

  test('distinguishes an empty transcript from a reasoning-only one', () => {
    const message = spawnMessage([editorReport([])])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('no messages')
    expect(report.rendered).not.toContain('reasoning was omitted')
    expect(report.value).toBeUndefined()
  })

  test('labels a write_file as a whole-file write and keeps the full content', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'write-1',
              toolName: 'write_file',
              input: {
                path: 'src/new.ts',
                instructions: 'Add the helper',
                content: 'export const helper = () => 1\n',
              },
            },
          ],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('whole-file write')
    expect(report.rendered).toContain('Add the helper')
    expect(report.rendered).toContain('export const helper = () => 1')
  })

  test('accepts a single replacement object instead of an array', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'edit-1',
              toolName: 'str_replace',
              input: {
                path: 'src/a.ts',
                replacements: { oldString: 'single old', newString: 'single new' },
              },
            },
          ],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('single old')
    expect(report.rendered).toContain('single new')
  })

  test('reads the replacement aliases models actually emit', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'edit-1',
              toolName: 'str_replace',
              input: {
                path: 'src/a.ts',
                replacements: [{ old_str: 'alias old', new_str: 'alias new' }],
              },
            },
          ],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('alias old')
    expect(report.rendered).toContain('alias new')
  })

  test('falls back to the raw input when no old/new strings can be read', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'edit-1',
              toolName: 'str_replace',
              input: { path: 'src/a.ts', replacements: [{ unexpected: 'shape' }] },
            },
          ],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('unexpected')
    expect(report.rendered).toContain('src/a.ts')
  })

  test('renders apply_patch operations as a diff', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'patch-1',
              toolName: 'apply_patch',
              input: {
                operation: {
                  type: 'update_file',
                  path: 'src/c.ts',
                  diff: '@@ -1 +1 @@\n-old line\n+new line',
                },
              },
            },
          ],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('apply_patch (update_file) — src/c.ts')
    expect(report.rendered).toContain('-old line')
    expect(report.rendered).toContain('+new line')
  })

  test('renders an apply_patch deletion without dumping raw JSON', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'patch-1',
              toolName: 'apply_patch',
              input: { operation: { type: 'delete_file', path: 'src/old.ts' } },
            },
          ],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('apply_patch (delete_file) — src/old.ts')
    expect(report.rendered).toContain('deletes the file')
    expect(report.rendered).not.toContain('"operation"')
  })

  test('keeps the payload of an apply_patch operation that has no diff', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'patch-1',
              toolName: 'apply_patch',
              input: {
                operation: {
                  type: 'add_file',
                  path: 'src/new.ts',
                  content: 'export const added = true\n',
                },
              },
            },
          ],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('apply_patch (add_file) — src/new.ts')
    expect(report.rendered).toContain('export const added = true')
    expect(report.rendered).not.toContain('no file content')
  })

  test('renders the applied-changes shape with its diff and strategy', () => {
    const message = spawnMessage([
      {
        agentName: 'Multi-Prompt Editor',
        agentType: 'editor-multi-prompt',
        value: {
          type: 'structuredOutput',
          value: {
            chosenStrategy: 'cache it',
            reason: 'fewer reads',
            toolResults: [
              [
                {
                  type: 'json',
                  value: { file: 'src/a.ts', message: 'Successfully replaced 1 occurrence' },
                },
              ],
            ],
            unifiedDiff: '--- src/a.ts ---\n+const a = 2',
            suggestedImprovements: 'add a test',
          },
        },
      },
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('Chosen strategy: cache it')
    expect(report.rendered).toContain('Reason: fewer reads')
    expect(report.rendered).toContain('src/a.ts: Successfully replaced 1 occurrence')
    expect(report.rendered).toContain('+const a = 2')
    expect(report.rendered).toContain('Suggested improvements: add a test')
  })

  test('renders the applied-changes shape even when no diff was reported', () => {
    const message = spawnMessage([
      {
        agentName: 'Multi-Prompt Editor',
        agentType: 'editor-multi-prompt',
        value: {
          type: 'structuredOutput',
          value: {
            chosenStrategy: 'no-op',
            reason: 'nothing to do',
            toolResults: [],
            suggestedImprovements: 'none',
          },
        },
      },
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('Chosen strategy: no-op')
    expect(report.rendered).toContain('No diff was reported')
  })

  test('leaves unrelated tool messages untouched', () => {
    const message = ({
      role: 'tool',
      toolName: 'read_files',
      toolCallId: 'read-1',
      content: [{ type: 'json', value: [{ path: 'src/a.ts' }] }],
    }) as unknown as Message

    expect(renderSubagentToolMessage({ message })).toBe(message)
  })

  test('leaves a non-array spawn value untouched', () => {
    const message = ({
      role: 'tool',
      toolName: 'spawn_agents',
      toolCallId: 'spawn-1',
      content: [{ type: 'json', value: { message: 'ok' } }],
    }) as unknown as Message

    expect(renderSubagentToolMessage({ message })).toBe(message)
  })

  test('leaves an error report untouched', () => {
    const message = spawnMessage([
      { agentName: 'Code Editor', agentType: 'editor', value: { errorMessage: 'boom' } },
    ])

    expect(renderSubagentToolMessage({ message })).toBe(message)
  })

  test('leaves a lastMessage output untouched', () => {
    const message = spawnMessage([
      {
        agentName: 'Basher',
        agentType: 'basher',
        value: { type: 'lastMessage', value: [{ role: 'assistant', content: [] }] },
      },
    ])

    expect(renderSubagentToolMessage({ message })).toBe(message)
  })

  test('leaves a null structured output untouched', () => {
    const message = spawnMessage([
      {
        agentName: 'Code Editor',
        agentType: 'editor',
        value: { type: 'structuredOutput', value: null },
      },
    ])

    expect(renderSubagentToolMessage({ message })).toBe(message)
  })

  test('returns null from renderAgentOutput for unknown shapes', () => {
    expect(renderAgentOutput(null)).toBeNull()
    expect(renderAgentOutput([])).toBeNull()
    expect(renderAgentOutput({ error: 'x' })).toBeNull()
    expect(renderAgentOutput({ output: { messages: 'nope' } })).toBeNull()
  })

  test('keeps an unreadable replacement instead of silently dropping it', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'edit-1',
              toolName: 'str_replace',
              input: {
                path: 'src/a.ts',
                replacements: [
                  { oldString: 'first old', newString: 'first new' },
                  { old_str: 'unreadable old' },
                  { oldString: 'third old', newString: 'third new' },
                ],
              },
            },
          ],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('Change 1: new')
    expect(report.rendered).toContain('Change 2: (unreadable replacement)')
    expect(report.rendered).toContain('unreadable old')
    expect(report.rendered).toContain('Change 3: new')
    expect(report.rendered).toContain('third new')
  })

  test('attaches a failed edit result to the change it belongs to', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'edit-1',
              toolName: 'str_replace',
              input: {
                path: 'src/a.ts',
                replacements: [{ oldString: 'missing', newString: 'x' }],
              },
            },
          ],
        },
        {
          role: 'tool',
          toolName: 'str_replace',
          toolCallId: 'edit-1',
          content: [
            {
              type: 'json',
              value: { file: 'src/a.ts', errorMessage: 'Could not find oldString' },
            },
          ],
        },
      ]),
    ])

    const rendered = firstReport(renderSubagentToolMessage({ message }))
      .rendered as string

    expect(rendered).toContain('→ src/a.ts: Could not find oldString')
    expect(rendered.indexOf('Could not find oldString')).toBeGreaterThan(
      rendered.indexOf('Change 1: new'),
    )
  })

  test('never renders a missing write_file content as an empty file', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'write-1',
              toolName: 'write_file',
              input: { path: 'src/a.ts', instructions: 'reset it' },
            },
          ],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('(no content supplied)')
  })

  test('recognises the bare { messages } shape so reasoning cannot leak', () => {
    const message = spawnMessage([
      {
        agentName: 'Code Editor',
        agentType: 'editor',
        value: {
          type: 'structuredOutput',
          value: {
            messages: [
              {
                role: 'assistant',
                content: [
                  { type: 'reasoning', text: 'secret plan' },
                  { type: 'text', text: 'visible note' },
                ],
              },
            ],
          },
        },
      },
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('visible note')
    expect(report.rendered).not.toContain('secret plan')
  })

  test('reports an unreadable tool result instead of dropping it', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'edit-1',
              toolName: 'str_replace',
              input: {
                path: 'src/a.ts',
                replacements: [{ oldString: 'a', newString: 'b' }],
              },
            },
          ],
        },
        {
          role: 'tool',
          toolName: 'str_replace',
          toolCallId: 'edit-1',
          content: [{ type: 'json', value: '' }],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('(empty result)')
  })

  test('pairs results for several tool calls in one message', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'edit-a',
              toolName: 'str_replace',
              input: { path: 'src/a.ts', replacements: [{ oldString: 'a1', newString: 'a2' }] },
            },
            {
              type: 'tool-call',
              toolCallId: 'edit-b',
              toolName: 'str_replace',
              input: { path: 'src/b.ts', replacements: [{ oldString: 'b1', newString: 'b2' }] },
            },
          ],
        },
        {
          role: 'tool',
          toolName: 'str_replace',
          toolCallId: 'edit-a',
          content: [{ type: 'json', value: { file: 'src/a.ts', message: 'A applied' } }],
        },
        {
          role: 'tool',
          toolName: 'str_replace',
          toolCallId: 'edit-b',
          content: [{ type: 'json', value: { file: 'src/b.ts', errorMessage: 'B failed' } }],
        },
      ]),
    ])

    const rendered = firstReport(renderSubagentToolMessage({ message }))
      .rendered as string

    const aCall = rendered.indexOf('src/a.ts**')
    const aResult = rendered.indexOf('→ src/a.ts: A applied')
    const bCall = rendered.indexOf('src/b.ts**')
    const bResult = rendered.indexOf('→ src/b.ts: B failed')

    expect(aResult).toBeGreaterThan(aCall)
    expect(aResult).toBeLessThan(bCall)
    expect(bResult).toBeGreaterThan(bCall)
  })

  test('keeps sibling fields of a tool result that has a message', () => {
    const message = spawnMessage([
      editorReport([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'edit-1',
              toolName: 'str_replace',
              input: { path: 'src/a.ts', replacements: [{ oldString: 'a', newString: 'b' }] },
            },
          ],
        },
        {
          role: 'tool',
          toolName: 'run_terminal_command',
          toolCallId: 'edit-1',
          content: [{ type: 'json', value: { message: 'tests failed', exitCode: 1 } }],
        },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('tests failed')
    expect(report.rendered).toContain('"exitCode": 1')
  })

  test('reports non-text parts instead of collapsing the transcript', () => {
    const message = spawnMessage([
      editorReport([
        { role: 'assistant', content: [{ type: 'image', image: 'base64' }] },
      ]),
    ])

    const report = firstReport(renderSubagentToolMessage({ message }))

    expect(report.rendered).toContain('(non-text part: image)')
    expect(report.rendered).not.toContain('no readable output')
  })

  test('does not mutate the input message', () => {
    const message = spawnMessage([editorReport([editCall(), editResult()])])
    const snapshot = JSON.parse(JSON.stringify(message))

    renderSubagentToolMessage({ message })

    expect(message).toEqual(snapshot)
  })
})
