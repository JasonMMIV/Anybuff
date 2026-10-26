import { DynamicAgentTemplateSchema } from '@codebuff/common/types/dynamic-agent-template'
import { describe, expect, test } from 'bun:test'

import { OPUS_MODEL } from '../constants'
import { createReviewer } from '../reviewer/code-reviewer'
import reviewerLite from '../reviewer/code-reviewer-lite'
import reviewerMultiPrompt from '../reviewer/multi-prompt/code-reviewer-multi-prompt'

describe('reviewer context curation', () => {
  test('the generic reviewer opts into the review-context filter', () => {
    const reviewer = createReviewer(OPUS_MODEL)

    expect(reviewer.includeMessageHistory).toBe(true)
    expect(reviewer.messageHistoryFilter).toBe('review-context')
    expect(reviewer.inheritParentSystemPrompt).toBe(false)
    expect(reviewer.toolNames).toEqual([])
  })

  test('the lite reviewer inherits the same filter', () => {
    expect(reviewerLite.messageHistoryFilter).toBe('review-context')
  })

  test('the filter survives schema parsing (zod strips unknown keys)', () => {
    const parsed = DynamicAgentTemplateSchema.parse({
      id: 'code-reviewer',
      displayName: 'Nit Pick Nick',
      model: OPUS_MODEL,
      includeMessageHistory: true,
      messageHistoryFilter: 'review-context',
      systemPrompt: '',
      instructionsPrompt: '',
      stepPrompt: '',
    })

    expect(parsed.messageHistoryFilter).toBe('review-context')
  })

  test('the multi-prompt relay keeps raw history for its own bookkeeping', () => {
    // It never calls an LLM; each leaf reviewer applies the filter itself.
    expect(reviewerMultiPrompt.includeMessageHistory).toBe(true)
    expect(reviewerMultiPrompt.messageHistoryFilter).toBeUndefined()
  })
})
