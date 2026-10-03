import { describe, expect, test } from 'bun:test'

import {
  buildChatNodes,
  findProcessGroup,
  isGroupOpen,
  type BodyNode,
  type ChatNode,
  type GroupableChatItem,
  type ProcessNode,
} from '../src/renderer/src/utils/chat-groups'

interface Item extends GroupableChatItem {
  kind: string
  text?: string
  reasoning?: string
  tool?: { status?: string }
}

const user = (text: string): Item => ({ kind: 'user', text })
const assistant = (text: string, reasoning?: string): Item => ({
  kind: 'assistant',
  text,
  reasoning,
})
const tool = (status: string): Item => ({ kind: 'tool', tool: { status } })

const types = (nodes: ChatNode<Item>[]): string[] =>
  nodes.map((node) => node.type)

const asGroup = (node: ChatNode<Item> | undefined): ProcessNode<Item> => {
  if (!node || node.type !== 'process')
    throw new Error('expected a process node')
  return node
}

const asBody = (node: ChatNode<Item> | undefined): BodyNode => {
  if (!node || node.type !== 'body') throw new Error('expected a body node')
  return node
}

describe('buildChatNodes', () => {
  test('folds thinking + tool cards of one turn into a single group', () => {
    const nodes = buildChatNodes(
      [
        user('Do the thing'),
        assistant('', 'look at the code first'),
        tool('done'),
        tool('done'),
        assistant('Done.', 'final reasoning'),
      ],
      { streaming: false },
    )

    expect(types(nodes)).toEqual(['plain', 'process', 'body'])

    const group = asGroup(nodes[1])
    expect(group.index).toBe(1)
    // The answer keeps its own row, so the group range stops at the last process item.
    expect(group.lastIndex).toBe(3)
    expect(group.entries.map((entry) => entry.type)).toEqual([
      'thought',
      'tool',
      'tool',
      'thought',
    ])
    expect(group.live).toBe(false)

    const body = asBody(nodes[2])
    expect(body.index).toBe(4)
    expect(body.text).toBe('Done.')
    expect(body.streaming).toBe(false)
  })

  test('a body block closes the group, so a later run opens a new one', () => {
    const nodes = buildChatNodes(
      [
        assistant('Intro'),
        tool('done'),
        assistant('Middle'),
        tool('done'),
        assistant('Done'),
      ],
      { streaming: false },
    )

    expect(types(nodes)).toEqual(['body', 'process', 'body', 'process', 'body'])
    expect(asGroup(nodes[1]).index).toBe(1)
    expect(asGroup(nodes[3]).index).toBe(3)
  })

  test('user / file-change / compaction / system rows break the group', () => {
    const nodes = buildChatNodes(
      [
        tool('done'),
        user('next'),
        tool('done'),
        { kind: 'compaction', text: 'trimmed' },
        tool('done'),
      ],
      { streaming: false },
    )
    expect(types(nodes)).toEqual([
      'process',
      'plain',
      'process',
      'plain',
      'process',
    ])
  })

  test('legacy think tags also land in the process group, not the bubble', () => {
    // Assembled from char codes: the editor tooling mangles raw closing-tag literals.
    const open = `${String.fromCharCode(60)}think>`
    const close = `${String.fromCharCode(60)}/think>`
    const nodes = buildChatNodes([assistant(`${open}hmm${close}Answer`)], {
      streaming: false,
    })

    expect(types(nodes)).toEqual(['process', 'body'])
    const group = asGroup(nodes[0])
    expect(group.entries).toHaveLength(1)
    expect(group.entries[0]).toMatchObject({
      type: 'thought',
      reasoning: 'hmm',
    })
    expect(asBody(nodes[1]).text).toBe('Answer')
  })

  test('plan-only items stay body rows (the plan box is prose)', () => {
    const nodes = buildChatNodes([assistant('<PLAN>Do X</PLAN>')], {
      streaming: false,
    })

    expect(types(nodes)).toEqual(['body'])
    expect(asBody(nodes[0]).plan).toBe('Do X')
  })

  test('a streaming turn with no output yet puts the dots inside the group', () => {
    const live = buildChatNodes([assistant('')], { streaming: true })
    expect(types(live)).toEqual(['process'])
    expect(asGroup(live[0]).entries.map((entry) => entry.type)).toEqual([
      'dots',
    ])
    expect(asGroup(live[0]).live).toBe(true)

    // Same item once the run is over: nothing left to show.
    expect(buildChatNodes([assistant('')], { streaming: false })).toEqual([])
  })

  test('Worked vs Working…: running tools, streaming thoughts, and the tail gap', () => {
    expect(
      asGroup(buildChatNodes([tool('running')], { streaming: true })[0]).live,
    ).toBe(true)
    expect(
      asGroup(buildChatNodes([tool('done')], { streaming: false })[0]).live,
    ).toBe(false)

    // Run still streaming and the group is the timeline tail (between events).
    expect(
      asGroup(buildChatNodes([tool('done')], { streaming: true })[0]).live,
    ).toBe(true)

    // The answer arrived → that segment is finished even while the run streams.
    const answered = buildChatNodes([tool('done'), assistant('Answer')], {
      streaming: true,
    })
    expect(asGroup(answered[0]).live).toBe(false)
    expect(asBody(answered[1]).streaming).toBe(true)

    // A streaming thought is live; the same thought once finished is not.
    const thinking = buildChatNodes([assistant('', 'weighing options')], {
      streaming: true,
    })
    expect(asGroup(thinking[0]).live).toBe(true)
    expect(
      asGroup(
        buildChatNodes([assistant('', 'weighed it')], { streaming: false })[0],
      ).live,
    ).toBe(false)
  })

  test('findProcessGroup locates the group wrapping a timeline index', () => {
    const nodes = buildChatNodes(
      [user('go'), tool('done'), tool('done'), assistant('Done')],
      { streaming: false },
    )

    expect(findProcessGroup(nodes, 1)?.key).toBe('process:1')
    expect(findProcessGroup(nodes, 2)?.key).toBe('process:1')
    // Plain rows and body rows are not hidden behind a group.
    expect(findProcessGroup(nodes, 0)).toBeUndefined()
    expect(findProcessGroup(nodes, 3)).toBeUndefined()
  })
})

describe('isGroupOpen', () => {
  test('an untouched group follows the run; a toggle pins it', () => {
    // No explicit choice → `live` decides: open while working, folded when done.
    expect(isGroupOpen(undefined, true)).toBe(true)
    expect(isGroupOpen(undefined, false)).toBe(false)
    // Once the user toggles, their choice wins even after the run finishes.
    expect(isGroupOpen(true, false)).toBe(true)
    expect(isGroupOpen(false, true)).toBe(false)
  })
})
