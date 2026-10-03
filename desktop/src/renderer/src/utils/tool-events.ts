/**
 * Tool-call ↔ tool-result correlation for the chat timeline.
 *
 * Mirrors the host session store (`packages/host-core/src/sessions/session-store.ts`):
 * every tool_call/tool_result pair carries a stable `toolCallId`. When a turn
 * batches several tool calls, all their cards exist before the first result
 * arrives — positional matching ("the most recently started card") then binds
 * every result to the wrong card: earlier tools sit on "Running…" forever and
 * the last one shows the wrong output. Matching by id resolves any batch order.
 *
 * Pure logic (no React, no DOM) — unit-tested in `desktop/test/tool-events.test.ts`.
 */

/** Minimum shape the matcher needs from a timeline item (structural, not nominal). */
export interface MatchableToolItem {
  kind: string
  tool?: {
    toolName?: string
    status?: string
    toolCallId?: string
  }
}

/**
 * Find the index of the tool card an event belongs to, scanning from the end.
 *
 * Preference order:
 *  1. exact `toolCallId` among running cards — the normal path; immune to
 *     batch order and to name mismatches (MCP results carry the STRIPPED name:
 *     `context7__fetch_docs` on the call vs `fetch_docs` on the result — never
 *     add a name check to the id path);
 *  2. legacy events without an id: the last running card of the same tool;
 *  -1 when nothing matches (never guess — a wrong match corrupts details).
 */
export function findToolResultIndex<T extends MatchableToolItem>(
  items: readonly T[],
  ev: { toolCallId?: string; toolName?: string },
): number {
  if (ev.toolCallId) {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind === 'tool' && item.tool?.status === 'running' && item.tool.toolCallId === ev.toolCallId) {
        return i
      }
    }
    return -1
  }
  // Cards store the `?? 'tool'` default, so match the same normalized name.
  const name = ev.toolName ?? 'tool'
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'tool' && item.tool?.status === 'running' && item.tool.toolName === name) {
      return i
    }
  }
  return -1
}

/**
 * Close out any card still marked running once its run is over (Stop mid-tool,
 * a result event that never arrived). Returns the SAME array reference when
 * nothing changed so memoized rows stay untouched — mirrors the host session
 * store's `sweepRunningTools`.
 */
export function sweepRunningCards<T extends MatchableToolItem>(
  items: readonly T[],
  status: 'done' | 'interrupted',
): readonly T[] {
  let changed = false
  const next = items.map((item): T => {
    if (item.kind === 'tool' && item.tool?.status === 'running') {
      changed = true
      // Callers pass plain item unions and read the same union back; the spread
      // preserves every field — only `status` changes on the tool.
      return { ...item, tool: { ...item.tool, status } } as T
    }
    return item
  })
  return changed ? next : items
}
