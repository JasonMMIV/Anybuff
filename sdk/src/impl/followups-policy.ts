/**
 * AnyBuff followups policy (PLAN.md §10.0 ledger).
 *
 * Freebuff/Codebuff has the model call `suggest_followups` at end-of-turn so
 * hosts can render clickable next-step cards. The suggestion content costs
 * output tokens on every turn and AnyBuff's desktop does not surface those
 * cards, so the feature is DISABLED by default:
 *
 * - `suggest_followups` is removed from every agent definition's toolNames,
 *   so it never reaches the model's wire tools (no call, no tokens).
 * - systemPrompt / instructionsPrompt lines that instruct the model to use
 *   suggest_followups are stripped, so the model is never told to call a
 *   tool that does not exist.
 *
 * Re-enable with ANYBUFF_FOLLOWUPS=1 (read once at module load; set before
 * process start) — definitions then pass through untouched and the upstream
 * behavior returns verbatim.
 */

const FOLLOWUPS_TOOL = 'suggest_followups'

export const FOLLOWUPS_ENABLED =
  process.env.ANYBUFF_FOLLOWUPS === '1' ||
  process.env.ANYBUFF_FOLLOWUPS === 'true'

function stripFollowupsFromDefinition<T extends object>(def: T): T {
  const patched = { ...(def as Record<string, unknown>) }

  const toolNames = patched.toolNames
  if (Array.isArray(toolNames)) {
    patched.toolNames = toolNames.filter(
      (name) => name !== FOLLOWUPS_TOOL,
    )
  }

  for (const key of ['systemPrompt', 'instructionsPrompt']) {
    const value = patched[key]
    if (typeof value === 'string' && value.includes(FOLLOWUPS_TOOL)) {
      patched[key] = value
        .split('\n')
        .filter((line) => !line.includes(FOLLOWUPS_TOOL))
        .join('\n')
    }
  }

  return patched as T
}

/**
 * Apply the followups policy to host-provided agent definitions before they
 * enter session state. Always returns a new array; input definitions are
 * shallow-copied before mutation so caller-owned objects are never touched.
 */
export function applyFollowupsPolicy<T extends object>(definitions: T[]): T[] {
  if (FOLLOWUPS_ENABLED) return definitions
  return definitions.map(stripFollowupsFromDefinition)
}
