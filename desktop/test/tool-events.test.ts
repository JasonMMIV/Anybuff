import { describe, expect, test } from 'bun:test'

import {
  findToolResultIndex,
  sweepRunningCards,
  type MatchableToolItem
} from '../src/renderer/src/utils/tool-events'

const tool = (toolName: string, status: string, toolCallId?: string): MatchableToolItem => ({
  kind: 'tool',
  tool: { toolName, status, toolCallId }
})

const assistant = (): MatchableToolItem => ({ kind: 'assistant' })

describe('findToolResultIndex', () => {
  test('binds each batched result to its own card by toolCallId', () => {
    const items = [tool('glob', 'running', 'a'), tool('run_terminal_command', 'running', 'b')]
    expect(findToolResultIndex(items, { toolCallId: 'a', toolName: 'glob' })).toBe(0)
    expect(findToolResultIndex(items, { toolCallId: 'b', toolName: 'run_terminal_command' })).toBe(1)
  })

  test('resolves results in any order, even for same-name batches', () => {
    const items = [tool('read_url', 'running', 'x'), tool('read_url', 'running', 'y')]
    expect(findToolResultIndex(items, { toolCallId: 'y', toolName: 'read_url' })).toBe(1)
    expect(findToolResultIndex(items, { toolCallId: 'x', toolName: 'read_url' })).toBe(0)
  })

  test('MCP results bind by id even though their toolName is stripped', () => {
    // The runtime emits `context7__fetch_docs` on the call but `fetch_docs`
    // on the result — the id is the only matchable key. Never add a name
    // check to the id path.
    const items = [tool('context7__fetch_docs', 'running', 'mcp-1')]
    expect(findToolResultIndex(items, { toolCallId: 'mcp-1', toolName: 'fetch_docs' })).toBe(0)
  })

  test('only running cards are candidates', () => {
    const items = [assistant(), tool('glob', 'done', 'a'), tool('glob', 'running', 'b')]
    expect(findToolResultIndex(items, { toolCallId: 'a', toolName: 'glob' })).toBe(-1)
    expect(findToolResultIndex(items, { toolCallId: 'b', toolName: 'glob' })).toBe(2)
  })

  test('never guesses: an unmatched id is a no-op, an id match ignores the name', () => {
    const items = [tool('glob', 'running', 'a')]
    expect(findToolResultIndex(items, { toolCallId: 'other', toolName: 'glob' })).toBe(-1)
    // The id is authoritative — the name is only a fallback for id-less events.
    expect(findToolResultIndex(items, { toolCallId: 'a', toolName: 'run_terminal_command' })).toBe(0)
  })

  test('legacy id-less results fall back to the last running card of the same tool', () => {
    const items = [tool('read_url', 'running'), tool('read_url', 'running'), assistant()]
    expect(findToolResultIndex(items, { toolName: 'read_url' })).toBe(1)
    expect(findToolResultIndex(items, { toolName: 'glob' })).toBe(-1)
  })

  test('an id-less event with no toolName matches the default-named card', () => {
    const items = [tool('tool', 'running')]
    expect(findToolResultIndex(items, {})).toBe(0)
  })
})

describe('sweepRunningCards', () => {
  test('demotes every running card and leaves the rest untouched', () => {
    const items = [
      assistant(),
      tool('glob', 'running', 'a'),
      tool('read_url', 'done', 'b'),
      tool('run_terminal_command', 'running', 'c')
    ]
    const swept = sweepRunningCards(items, 'interrupted')
    expect(swept).not.toBe(items)
    expect(swept[1].tool?.status).toBe('interrupted')
    expect(swept[2].tool?.status).toBe('done')
    expect(swept[3].tool?.status).toBe('interrupted')
  })

  test('returns the same array reference when nothing is running', () => {
    const items = [assistant(), tool('glob', 'done', 'a')]
    expect(sweepRunningCards(items, 'done')).toBe(items)
  })
})
