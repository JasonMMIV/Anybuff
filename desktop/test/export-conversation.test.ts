import { describe, expect, test } from 'bun:test'

import {
  serializeConversationToMarkdown,
  suggestExportFileName,
  type ExportMessage,
  type ExportToolMessage
} from '../src/renderer/src/utils/export-conversation'

const toolMsg = (tool: ExportToolMessage): ExportMessage => ({ kind: 'tool', tool })

describe('serializeConversationToMarkdown', () => {
  test('renders role headings, reasoning, and tool input + output (upstream /copy format)', () => {
    const messages: ExportMessage[] = [
      { kind: 'user', text: 'Read the config file' },
      {
        kind: 'assistant',
        text: 'Sure — reading it now.',
        reasoning: 'Need to find config.ts first.\nIt might be in src/.'
      },
      toolMsg({
        toolName: 'read_files',
        status: 'done',
        toolInput: { paths: ['src/config.ts'] },
        detail: '[{"type":"json","value":{"content":"export const x = 1","ok":true}}]'
      })
    ]

    const { text, messageCount } = serializeConversationToMarkdown(messages)

    expect(messageCount).toBe(2) // user + assistant only — tool rows are not "messages"
    expect(text).toContain('# AnyBuff conversation')
    expect(text).toContain('## User')
    expect(text).toContain('Read the config file')
    expect(text).toContain('## Assistant')
    expect(text).toContain('Sure — reading it now.')
    // Reasoning renders as a blockquote under its own label.
    expect(text).toContain('> _Reasoning_')
    expect(text).toContain('> Need to find config.ts first.\n> It might be in src/.')
    // Tool call: display name, input, and pretty-printed output all present.
    expect(text).toContain('**🛠 Read Files**')
    expect(text).toContain('src/config.ts')
    expect(text).toContain('"content": "export const x = 1"')
    // JSON envelope pretty-printed (multi-line), not a dense one-liner.
    expect(text).not.toContain('{"type":"json","value"')
  })

  test('keeps tool output byte-for-byte (no newline normalization inside fences)', () => {
    // Consecutive blank lines are content — the exporter must not collapse them.
    const detail = 'line one\n\n\n\nline five\n'
    const messages = [
      toolMsg({
        toolName: 'run_terminal_command',
        status: 'done',
        toolInput: { command: 'x' },
        detail
      })
    ]
    const { text } = serializeConversationToMarkdown(messages)
    expect(text).toContain('line one\n\n\n\nline five')
    expect(text).toContain(detail)
  })

  test('renders sub-agent cards, subagent-scoped tools, and todo checklists', () => {
    const messages: ExportMessage[] = [
      toolMsg({
        toolName: 'agent:researcher-web',
        status: 'done',
        agentType: 'researcher-web',
        agentName: 'Web Researcher',
        detail: 'I investigated the issue.'
      }),
      toolMsg({
        toolName: 'code_search',
        status: 'done',
        agentType: 'researcher-web',
        toolInput: { query: 'bug' },
        detail: 'match in foo.ts'
      }),
      toolMsg({
        toolName: 'write_todos',
        status: 'done',
        todos: [
          { task: 'Add tests', completed: false },
          { task: 'Run typecheck', completed: true }
        ],
        detail: 'created 2 todos'
      })
    ]

    const { text } = serializeConversationToMarkdown(messages)

    expect(text).toContain('### ⤷ Subagent: Web Researcher (researcher-web)')
    expect(text).toContain('I investigated the issue.')
    expect(text).toContain('### ⤶ End subagent')
    expect(text).toContain('> _subagent: researcher-web_')
    expect(text).toContain('**🛠 Code Search**')
    expect(text).toContain('match in foo.ts')
    // Todo checklist + its tool result are both kept.
    expect(text).toContain('**Todo list**')
    expect(text).toContain('- [ ] Add tests')
    expect(text).toContain('- [x] Run typecheck')
    expect(text).toContain('created 2 todos')
  })

  test('notes sensitive-file blocks and renders file-change summaries', () => {
    const messages: ExportMessage[] = [
      toolMsg({
        toolName: 'read_files',
        status: 'done',
        toolInput: { paths: ['src/a.ts', '.env'] },
        blockedPaths: ['.env'],
        detail: 'ok'
      }),
      { kind: 'file-changes', files: [{ path: 'src/a.ts', action: 'modify' }] }
    ]
    const { text } = serializeConversationToMarkdown(messages)
    expect(text).toContain('> _Blocked by the sensitive-file filter: .env_')
    expect(text).toContain('**Changed files:**')
    expect(text).toContain('- src/a.ts (modify)')
  })

  test('renders compaction notes as quotes and system notices under ## Error', () => {
    const messages: ExportMessage[] = [
      { kind: 'compaction', text: 'Earlier messages were summarized to fit the context window.' },
      { kind: 'system', text: 'Rate limit exceeded' }
    ]
    const { text, messageCount } = serializeConversationToMarkdown(messages)
    expect(text).toContain('> _Earlier messages were summarized to fit the context window._')
    expect(text).toContain('## Error')
    expect(text).toContain('Rate limit exceeded')
    expect(messageCount).toBe(1) // only the system (error) notice is a role message
  })

  test('skips empty placeholders and unknown entries keep their text', () => {
    const messages: ExportMessage[] = [
      { kind: 'assistant', text: '', reasoning: '' },
      { kind: 'user', text: '' },
      { kind: 'weird-legacy', text: 'legacy payload' }
    ]
    const { text, messageCount } = serializeConversationToMarkdown(messages)
    expect(text).toContain('legacy payload')
    expect(text).not.toContain('## Assistant')
    expect(text).not.toContain('## User')
    expect(messageCount).toBe(0)
  })

  test('tool call with no input or output renders a compact one-liner', () => {
    const { text } = serializeConversationToMarkdown([toolMsg({ toolName: 'end_turn', status: 'running' })])
    expect(text).toContain('_(no input or output)_')
  })

  test('empty conversation still produces a header', () => {
    const { text, messageCount } = serializeConversationToMarkdown([])
    expect(text).toMatch(/# AnyBuff conversation/)
    expect(messageCount).toBe(0)
  })
})

describe('suggestExportFileName', () => {
  test('date-prefixes the slugged prompt and strips Windows-invalid characters', () => {
    const fn = suggestExportFileName('fix: zero/division "handling"?', 'demo')
    expect(fn).toMatch(/^\d{4}-\d{2}-\d{2}-fix-zero-division-handling\.md$/)
  })

  test('falls back to project name then a generic name', () => {
    expect(suggestExportFileName('', 'my-project')).toMatch(/^\d{4}-\d{2}-\d{2}-my-project\.md$/)
    expect(suggestExportFileName('', '')).toMatch(/^\d{4}-\d{2}-\d{2}-conversation\.md$/)
  })
})
