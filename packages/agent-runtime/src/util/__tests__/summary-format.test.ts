import { describe, expect, test } from 'bun:test'

import { isUsableSummary, summaryFromReply } from '../summary-format'

const LF = String.fromCharCode(10)

const HEADINGS = [
  '目標',
  '需求',
  '決策',
  '工作狀態',
  '下一步',
  '相關檔案',
  '重要背景',
  '最新交流',
]

function translatedSections(count: number, body = 'x'.repeat(60)): string {
  return HEADINGS.slice(0, count)
    .map((heading) => `## ${heading}${LF}${body}`)
    .join(`${LF}${LF}`)
}

const VALID = [
  '## Objective',
  'Fix the login bug in auth.ts and keep the existing session flow working end to end.',
  '## Requirements',
  'Keep the public login API unchanged: same status codes, same cookie names, same error strings.',
  '## Decisions',
  'Reused the existing token helper instead of adding a new dependency or changing the wire format.',
  '## Work State',
  'The fix is written but uncommitted; the auth suite has not been run and the old verifier is still deployed.',
  '## Next Move',
  'Run the auth test suite, then commit and push the change.',
  '## Relevant Files',
  'src/auth.ts — the token verifier that was corrected. src/auth.test.ts — regression coverage.',
  '## Important Context',
  'The failing error string was "invalid signature"; the old verifier compared against the raw key.',
  '## Latest Exchange',
  'The user reported the login failure; the assistant reproduced it and corrected the verifier.',
].join(LF)

describe('summaryFromReply', () => {
  test('returns the template summary as-is', () => {
    expect(VALID.length).toBeGreaterThanOrEqual(400)
    expect(summaryFromReply(VALID)).toBe(VALID)
  })

  test('drops a preamble before the first heading', () => {
    expect(summaryFromReply(`Sure, here is the summary.${LF}${LF}${VALID}`)).toBe(
      VALID,
    )
  })

  test('returns empty for a think-only reply', () => {
    expect(summaryFromReply('thinking about the summary')).toBe('')
    expect(summaryFromReply('<thinking>still thinking</thinking>')).toBe('')
  })

  test('returns empty when there are no headings', () => {
    expect(summaryFromReply('I need more information to summarize.')).toBe('')
  })

  test('falls back to shape when the model translated the headings', () => {
    const translated = translatedSections(8)
    expect(summaryFromReply(translated)).toBe(translated)
  })

  test('returns empty for too few translated sections', () => {
    expect(summaryFromReply(translatedSections(5))).toBe('')
  })

  test('refuses a body that contains the mechanical summary tag', () => {
    expect(
      summaryFromReply(
        `${VALID}${LF}<conversation_summary>old</conversation_summary>`,
      ),
    ).toBe('')
  })
})

describe('isUsableSummary', () => {
  test('accepts a template-shaped summary above the length floor', () => {
    expect(isUsableSummary(VALID)).toBe(true)
    expect(isUsableSummary(translatedSections(8))).toBe(true)
  })

  test('rejects a summary with all headings but almost no content', () => {
    const tiny = HEADINGS.map((heading) => `## ${heading}${LF}- x`).join(
      `${LF}${LF}`,
    )
    expect(summaryFromReply(tiny)).not.toBe('')
    expect(isUsableSummary(summaryFromReply(tiny))).toBe(false)
  })

  test('rejects an empty summary', () => {
    expect(isUsableSummary('')).toBe(false)
  })

  test('rejects an anchored reply truncated after one section', () => {
    const partial = `## Objective${LF}${'x'.repeat(600)}`
    const extracted = summaryFromReply(partial)
    expect(extracted).not.toBe('')
    expect(isUsableSummary(extracted)).toBe(false)
  })
})
