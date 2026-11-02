import { stripThinkTags } from './think-tags'

/**
 * A summary shorter than this carries too little to replace a conversation.
 * 400 chars is roughly 5-8 short bullets per section for a template that asks
 * for eight sections.
 */
const MIN_CHARS = 400

/** Shape fallback: the template asks for eight sections. */
const MIN_SECTIONS = 6

/**
 * Pulls the summary body out of a model reply.
 *
 * 1. Prefer the exact `## Objective` anchor (the template's normal path).
 * 2. Otherwise accept any reply shaped like the template: at least
 *    MIN_SECTIONS `## ` headings.
 *
 * The shape fallback exists because models sometimes translate the headings;
 * upstream observed GLM 5.3 Flash doing it about 12% of the time. No anchor and
 * too few headings yields '', which the caller treats as an unusable summary
 * and keeps the history.
 *
 * The function name and string return type deliberately match upstream to keep
 * merge friction low.
 */
export function summaryFromReply(reply: string): string {
  const text = stripThinkTags(reply)
  // `context-pruner` only matches the literal `<conversation_summary>` string.
  // If the summary body contained it, the next mechanical compaction would
  // mistake this message for a previous summary. Refuse instead; the caller
  // keeps the history.
  if (text.includes('<conversation_summary>')) return ''
  const english = text.indexOf('## Objective')
  if (english >= 0) return text.slice(english).trim()
  const sections = [...text.matchAll(/^## /gm)]
  if (sections.length < MIN_SECTIONS) return ''
  const firstIndex = sections[0]?.index
  if (firstIndex === undefined) return ''
  return text.slice(firstIndex).trim()
}

/**
 * A structurally valid summary that is also long enough to be worth keeping.
 *
 * The section count is checked here as well as in the shape fallback: a reply
 * that starts with the `## Objective` anchor but is truncated after one or two
 * sections can still clear MIN_CHARS, and `summaryFromReply` returns it as-is.
 * Rejecting it keeps the history instead of replacing it with a fragment.
 */
export function isUsableSummary(summary: string): boolean {
  if (summary.length < MIN_CHARS) return false
  return [...summary.matchAll(/^## /gm)].length >= MIN_SECTIONS
}
