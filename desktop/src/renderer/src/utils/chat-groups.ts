/**
 * Chat timeline grouping (過程收闔 / process folding).
 *
 * Coding-app convention: the agent's *process* (thinking + tool calls) is
 * background noise; only prose is body content. This builder folds every
 * non-body block of a work segment into ONE collapsible group rendered behind a
 * single `> Working…` / `> Worked` header:
 *
 * - group  = maximal run of thinking cards + tool cards (+ the streaming
 *            "thinking dots" placeholder) between two body blocks;
 * - body   = an assistant item with visible prose or a <PLAN> box (the only
 *            assistant items that still render a bubble); its reasoning is
 *            lifted OUT of the bubble and into the preceding group, so a turn
 *            reads: user → `> Worked` → answer;
 * - plain  = user messages / file-change summaries / compaction notes / system
 *            rows — they close the current group.
 *
 * `live` (→ `Working…`) is true while the group still holds a running tool or
 * a streaming thought, or while the run is streaming and the group is the tail
 * of the timeline (the gap between "tool finished" and "next event arrived").
 * Once the segment's thinking and/or tools finish, the header becomes `Worked`.
 *
 * Pure logic (no React, no DOM) — unit-tested in
 * `desktop/test/chat-groups.test.ts`. The assistant-text parsers live with the
 * bubble components (single home: components/ChatMessage.tsx).
 */

import { extractPlanBlocks, extractThinkTags } from '../components/ChatMessage'

/** Minimum shape the builder needs from a timeline item (structural, not nominal). */
export interface GroupableChatItem {
  kind: string
  text?: string
  reasoning?: string
  ts?: number
  /** Tool rows only — read for the live (`Working…`) verdict. */
  tool?: { status?: string }
}

/** One row inside a process group. */
export type ProcessEntry<T> =
  | {
      type: 'thought'
      key: string
      index: number
      reasoning: string
      streaming: boolean
    }
  | { type: 'tool'; key: string; index: number; item: T }
  | { type: 'dots'; key: string; index: number }

export type ProcessNode<T> = {
  type: 'process'
  key: string
  /** Timeline index of the group's first source item (also the group's own row id). */
  index: number
  /** Timeline index of the group's last source item. */
  lastIndex: number
  live: boolean
  entries: ProcessEntry<T>[]
}

/** Assistant item that still renders a body bubble (prose and/or plan). */
export type BodyNode = {
  type: 'body'
  key: string
  index: number
  text: string
  plan?: string
  streaming: boolean
  ts?: number
}

/** User / file-changes / compaction / system rows — rendered as before. */
export type PlainNode<T> = {
  type: 'plain'
  key: string
  index: number
  item: T
}

export type ChatNode<T> = ProcessNode<T> | BodyNode | PlainNode<T>

/**
 * Split one assistant item into its process half (reasoning / legacy think tag)
 * and its body half (prose + <PLAN> box). The parsers strip anything that must
 * never reach the visible bubble (leaked suggest_followups calls).
 */
export function parseAssistant(item: GroupableChatItem): {
  body: string
  plan?: string
  thought?: string
  thinking: boolean
} {
  const extracted = extractThinkTags(item.text ?? '')
  const planExtracted = extractPlanBlocks(extracted.text)
  // Legacy think tags and the structured reasoning field merge into one card.
  const thought = [item.reasoning?.trim(), extracted.reasoning?.trim()]
    .filter(Boolean)
    .join('\n\n')
  return {
    body: planExtracted.text,
    plan: planExtracted.plan,
    thought: thought || undefined,
    thinking: extracted.isThinking,
  }
}

/**
 * Fold a timeline into render nodes. `streaming` is the run-level flag
 * (`viewRunning && chatItems.length > 0`); a node is only "live" when it is the
 * tail of the timeline, so finished segments never flash `Working…`.
 */
export function buildChatNodes<T extends GroupableChatItem>(
  items: readonly T[],
  opts: { streaming: boolean },
): ChatNode<T>[] {
  const nodes: ChatNode<T>[] = []
  const lastIndex = items.length - 1
  let group: ProcessNode<T> | null = null

  const closeGroup = (): void => {
    group = null
  }
  const openGroup = (index: number): ProcessNode<T> => {
    if (group) return group
    const node: ProcessNode<T> = {
      type: 'process',
      key: `process:${index}`,
      index,
      lastIndex: index,
      live: false,
      entries: [],
    }
    group = node
    nodes.push(node)
    return node
  }

  items.forEach((item, i) => {
    const isLast = i === lastIndex

    if (item.kind === 'tool' && item.tool) {
      const g = openGroup(i)
      g.entries.push({ type: 'tool', key: `tool:${i}`, index: i, item })
      g.lastIndex = i
      return
    }

    if (item.kind === 'assistant') {
      const parsed = parseAssistant(item)
      const hasBody = Boolean(parsed.body.trim() || parsed.plan)

      // Reasoning (and open legacy think tags) = process, not prose.
      if (parsed.thought) {
        const g = openGroup(i)
        g.entries.push({
          type: 'thought',
          key: `thought:${i}`,
          index: i,
          reasoning: parsed.thought,
          streaming: opts.streaming && isLast && !hasBody,
        })
        // A body item keeps its own row: the group's range must not swallow it,
        // so a search jump lands on the bubble instead of expanding the group.
        if (!hasBody) g.lastIndex = i
      } else if (!hasBody && opts.streaming && isLast) {
        // Streaming assistant item with nothing on it yet (the old thinking-dots
        // row) — keep it inside the group so a fresh turn still shows `Working…`.
        const g = openGroup(i)
        g.entries.push({ type: 'dots', key: `dots:${i}`, index: i })
        g.lastIndex = i
      }

      if (hasBody) {
        nodes.push({
          type: 'body',
          key: `body:${i}`,
          index: i,
          text: parsed.body,
          plan: parsed.plan,
          streaming: opts.streaming && isLast,
          ts: item.ts,
        })
        closeGroup()
      }
      return
    }

    nodes.push({ type: 'plain', key: `${item.kind}:${i}`, index: i, item })
    closeGroup()
  })

  nodes.forEach((node, i) => {
    if (node.type !== 'process') return
    node.live =
      node.entries.some(
        (entry) =>
          entry.type === 'dots' ||
          (entry.type === 'tool' && entry.item.tool?.status === 'running') ||
          (entry.type === 'thought' && entry.streaming),
      ) ||
      (opts.streaming && i === nodes.length - 1)
  })

  return nodes
}

/**
 * Fold state for one group. A group the user has never toggled follows the run:
 * open while it works (`Working…`), folded again once it finishes (`Worked`).
 * `explicit` is the user's pinned choice — once set it wins forever, so a group
 * the user expanded stays expanded after the run ends.
 */
export function isGroupOpen(
  explicit: boolean | undefined,
  live: boolean,
): boolean {
  return explicit ?? live
}

/** The process group wrapping a timeline index, if any (search jumps use it to auto-expand). */
export function findProcessGroup<T extends GroupableChatItem>(
  nodes: readonly ChatNode<T>[],
  index: number,
): ProcessNode<T> | undefined {
  return nodes.find(
    (node): node is ProcessNode<T> =>
      node.type === 'process' && index >= node.index && index <= node.lastIndex,
  )
}
