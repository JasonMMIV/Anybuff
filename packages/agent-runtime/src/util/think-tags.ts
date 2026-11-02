/**
 * Strip XML-style think scaffolding from a model response.
 *
 * Handles both ` thinking` and `<thinking>` spellings:
 * - Paired tags:  thinking...</think> or <thinking>...</thinking>
 * - Unclosed open tags:  thinking... (truncated mid-thought)
 * - Orphan close tags: </think> or </thinking>
 *
 * Orphan closes show up with native-reasoning models (notably Kimi via
 * Alibaba/Infron): reasoning lands in `reasoning_content`, then content is
 * sometimes just `"</think> "`. Treating that as real text ends the agent
 * turn with no tool calls. The `<thinking>` variant leaks the same way from
 * other providers and must not defeat the think-only guard.
 *
 * Deliberately case-sensitive, matching the previous behavior.
 */
export function stripThinkTags(text: string): string {
  return text
    .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/g, '')
    .replace(/<(?:think|thinking)>[\s\S]*$/g, '')
    .replace(/<\/(?:think|thinking)>/g, '')
    .trim()
}

/**
 * True when the response is non-empty but only think-tag scaffolding (no
 * other non-whitespace content). Such steps should continue rather than end
 * the turn.
 */
export function isThinkOnlyResponse(fullResponse: string): boolean {
  const trimmed = fullResponse.trim()
  if (trimmed.length === 0) {
    return false
  }
  return stripThinkTags(fullResponse).length === 0
}
