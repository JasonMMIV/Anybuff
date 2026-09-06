import { describe, expect, it } from 'bun:test'

import { compactMessagesForResume } from '../resume-compaction'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], sentAt: 1 }
}

const longHistory: Message[] = Array.from({ length: 15 }, (_, i) =>
  userMsg(
    `conversation turn number ${i} with plenty of prose that the summarizer budgets will evict. `.repeat(1000),
  ),
)
longHistory.push(userMsg('the live prompt'))

describe('compactMessagesForResume', () => {
  it('is a no-op when the history already fits maxTokens', () => {
    const res = compactMessagesForResume({
      messages: longHistory,
      maxTokens: 1_000_000,
    })
    expect(res.compacted).toBe(false)
    expect(res.messages).toBe(longHistory)
    expect(res.estimatedTokens).toBeGreaterThan(0)
  })

  it('compacts an oversized history below its previous size', () => {
    const res = compactMessagesForResume({
      messages: longHistory,
      maxTokens: 2_000,
    })
    expect(res.compacted).toBe(true)
    expect(res.estimatedTokens).toBeLessThan(
      compactMessagesForResume({ messages: longHistory, maxTokens: 1_000_000 }).estimatedTokens,
    )
    // The result must remain a usable conversation shape (summary + prompt).
    expect(res.messages.length).toBeGreaterThanOrEqual(1)
  })

  it('is deterministic: identical input → identical output', () => {
    const first = compactMessagesForResume({ messages: longHistory, maxTokens: 2_000 })
    const second = compactMessagesForResume({ messages: longHistory, maxTokens: 2_000 })
    // compactMessages stamps fresh sentAt timestamps; strip them before
    // comparing so a millisecond boundary never flaps the determinism check.
    const strip = (msgs: Message[]) =>
      msgs.map((m) => ({ ...m, sentAt: undefined }))
    expect(strip(second.messages)).toEqual(strip(first.messages))
    expect(second.estimatedTokens).toBe(first.estimatedTokens)
  })

  it('handles an empty history without throwing', () => {
    const res = compactMessagesForResume({ messages: [], maxTokens: 100 })
    expect(res.compacted).toBe(false)
    expect(res.messages).toEqual([])
  })
})
