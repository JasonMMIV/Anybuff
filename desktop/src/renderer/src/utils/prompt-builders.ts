/**
 * Prompt builders for the /interview and /review slash commands (#5 第二批).
 *
 * Ported from the upstream CLI (`cli/src/commands/prompt-builders.ts`) so both
 * commands behave identically to the CLI: they wrap the user's input in a
 * structured instruction and run as an ordinary message on the currently
 * selected model — no special agent, no gate.
 */

// Base prompt for /interview — multi-round ask_user interrogation that ends in
// a spec file. Note: the upstream version ends by calling `suggest_followups`,
// but AnyBuff strips that tool from every agent (followups-policy, see the
// maintenance ledger), so the closing line is replaced with a plain stop.
export const INTERVIEW_BASE_PROMPT =
  'Interview me to better understand my request and then create a spec file. First, gather any relevant context (read files, do research, etc.). Then, use several rounds of the ask_user tool to ask non-obvious clarifying questions — things you cannot easily infer from the codebase or my initial message. Ask about edge cases, preferences, constraints, and design decisions. All questions should be directed through the ask_user tool -- not written out as text. Keep coming up with new questions that get at unique aspects of the request. Aim for at least **3 rounds** with multiple questions each round. When satisfied, write a [INSERT_REQUEST_SHORT_NAME]-spec.md file with all the information you have gathered about the request. Aim for as much detail as possible. You should NOT make any code changes yet. Stop after creating the spec file. Here is my request:'

const REVIEW_BASE_PROMPT =
  'Please gather all relevant context and then carefully review:'

/** Review scope presets mirroring the upstream CLI ReviewScreen. */
export type ReviewScope = 'conversation' | 'uncommitted' | 'branch' | 'custom'

export interface ReviewScopeOption {
  id: ReviewScope
  label: string
  description: string
  /** Text injected after REVIEW_BASE_PROMPT (empty for custom). */
  scopeText: string
}

export const REVIEW_SCOPE_OPTIONS: ReviewScopeOption[] = [
  {
    id: 'conversation',
    label: 'This conversation',
    description: 'All changes made in this conversation',
    scopeText: 'all changes made in this conversation',
  },
  {
    id: 'uncommitted',
    label: 'Uncommitted changes',
    description: 'Everything in git status / staging right now',
    scopeText: 'uncommitted changes',
  },
  {
    id: 'branch',
    label: 'Branch vs main',
    description: 'This branch compared to main',
    scopeText: 'this branch compared to main',
  },
  {
    id: 'custom',
    label: 'Custom focus',
    description: 'Review specific files, a feature, or a concern you name',
    scopeText: '',
  },
]

/**
 * Build an interview prompt from user input.
 * @param input - The user's request to be interviewed about
 */
export function buildInterviewPrompt(input: string): string {
  const trimmedInput = input.trim()
  if (!trimmedInput) return INTERVIEW_BASE_PROMPT
  return `${INTERVIEW_BASE_PROMPT}\n\n${trimmedInput}`
}

/**
 * Build a review prompt from a scope preset or custom focus.
 * @param scope - One of the REVIEW_SCOPE_OPTIONS ids
 * @param customInput - Required when scope is 'custom'
 */
export function buildReviewPrompt(
  scope: ReviewScope,
  customInput?: string,
): string {
  if (scope === 'custom') {
    const trimmed = customInput?.trim()
    return trimmed ? `${REVIEW_BASE_PROMPT} ${trimmed}` : REVIEW_BASE_PROMPT
  }
  const option = REVIEW_SCOPE_OPTIONS.find((o) => o.id === scope)
  return (
    `${REVIEW_BASE_PROMPT} ${option?.scopeText ?? ''}`.trimEnd() +
    (option?.scopeText ? '' : ':')
  )
}
