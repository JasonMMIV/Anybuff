import { describe, expect, it } from 'bun:test'

import {
  compactMessages,
  DEFAULT_CACHE_EXPIRY_MIN_TOKENS,
  DEFAULT_CACHE_EXPIRY_MS,
  evaluateCompactionTrigger,
  maybeCompactHistory,
  promptCacheGapMs,
} from '../compact-history'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const MINUTE = 60 * 1000

const user = (text: string, tags?: string[]): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...(tags ? { tags } : {}),
  sentAt: 1,
})

const assistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  sentAt: 1,
})

const assistantToolCall = (
  toolName: string,
  input: Record<string, unknown>,
): Message => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: 'c1', toolName, input }],
  sentAt: 1,
})

const toolResult = (toolName: string, value: unknown): Message => ({
  role: 'tool',
  toolCallId: 'c1',
  toolName,
  content: [{ type: 'json', value: value as any }],
})

/** A user prompt that landed `gapMinutes` after the assistant's last message. */
const idleTurn = (gapMinutes: number): Message[] => [
  { ...assistant('previous turn answer'), sentAt: 1_000_000 },
  {
    ...user('the new question', ['USER_PROMPT']),
    sentAt: 1_000_000 + gapMinutes * MINUTE,
  },
]

const textOf = (message: Message): string =>
  Array.isArray(message.content)
    ? message.content
        .map((part) => ('text' in part ? part.text : ''))
        .join('\n')
    : String(message.content)

const compact = (messages: Message[]) => compactMessages({ messages }).messages

describe('compactMessages', () => {
  it('replaces history with a mechanical summary and keeps the live user prompt', () => {
    const result = compact([
      user('old question'),
      assistant('old answer'),
      user('the live question', ['USER_PROMPT']),
    ])

    expect(result).toHaveLength(2)
    expect(textOf(result[0])).toContain('<conversation_summary>')
    expect(textOf(result[0])).toContain('old question')
    expect(textOf(result[0])).toContain('old answer')
    expect(result[1].role).toBe('user')
    expect(textOf(result[1])).toContain('the live question')
  })

  it('keeps the concrete details of the work: files, edits, commands', () => {
    const summary = textOf(
      compactMessages({
        messages: [
          user('fix the bug', ['USER_PROMPT']),
          assistantToolCall('read_files', {
            paths: [{ path: 'src/server.ts', offset: 0, limit: 200 }],
          }),
          assistantToolCall('str_replace', { path: 'src/server.ts' }),
          assistantToolCall('run_terminal_command', { command: 'bun test' }),
          toolResult('run_terminal_command', { exitCode: 1 }),
        ],
        // Tail off: this test locks the summarizer's one-line descriptions;
        // with the tail on, the whole exchange moves there verbatim.
        tailBudget: 0,
      }).messages[0],
    )

    expect(summary).toContain('inspected files: src/server.ts')
    expect(summary).toContain('edited file: src/server.ts')
    expect(summary).toContain('ran command: bun test')
    expect(summary).toContain('Command failed with exit code: 1')
  })

  it('appends a continuation prompt on a mid-turn prune', () => {
    const result = compact([
      user('the live question', ['USER_PROMPT']),
      assistant('working on it'),
    ])

    expect(result).toHaveLength(2)
    expect(textOf(result[1])).toContain('Continue the existing assistant turn')
    // Mid-turn, the live prompt moves into the memory instead of being dropped.
    expect(textOf(result[0])).toContain('the live question')
  })

  it('keeps the live prompt readable mid-turn even when it is enormous', () => {
    // The user budget is what protects the request the agent is working on. It
    // is the newest user entry, so the budget walk reaches it first, and the
    // per-message truncation caps it far below the budget.
    const huge = `IMPORTANT REQUEST ${'x'.repeat(500_000)} FINAL LINE`
    const summary = textOf(
      compact([
        user(huge, ['USER_PROMPT']),
        ...Array.from({ length: 50 }, (_, i) => assistant(`step ${i}`)),
      ])[0],
    )

    expect(summary).toContain('IMPORTANT REQUEST')
    expect(summary).toContain('FINAL LINE')
  })

  it('drops per-step scaffolding and re-appends the instructions prompt', () => {
    const result = compact([
      user('older work'),
      assistant('older answer'),
      user('THE INSTRUCTIONS', ['INSTRUCTIONS_PROMPT']),
      user('THE STEP SCAFFOLD', ['STEP_PROMPT']),
      user('the live question', ['USER_PROMPT']),
    ])

    expect(result).toHaveLength(3)
    expect(textOf(result[0])).not.toContain('THE INSTRUCTIONS')
    expect(textOf(result[0])).not.toContain('THE STEP SCAFFOLD')
    expect(result[1].tags).toContain('INSTRUCTIONS_PROMPT')
    expect(textOf(result[1])).toContain('THE INSTRUCTIONS')
    expect(textOf(result[2])).toContain('the live question')
  })

  it('folds a previous summary back in on a second compaction', () => {
    const first = compact([
      user('the original request', ['USER_PROMPT']),
      assistant('working on it'),
    ])
    const second = compact([...first, assistant('more work')])

    expect(second).toHaveLength(2)
    expect(textOf(second[0])).toContain('the original request')
    expect(textOf(second[0])).toContain('more work')
    // The old summary wrapper is not nested inside the new one.
    expect(textOf(second[0]).match(/<conversation_summary>/g)).toHaveLength(1)
    expect(textOf(second[1])).toContain('Continue the existing assistant turn')
  })

  it('does not mistake a user message that mentions the tag for a summary', () => {
    // A summary is dropped from the history and re-parsed into entries, so a
    // false positive silently eats the user's message. Asking about this very
    // module is an easy way to send the bare tag.
    const asking = user(
      'why does the code emit <conversation_summary> around the memory?',
    )
    const result = compact([
      asking,
      assistant('because the model needs a delimiter'),
      user('got it, now fix the bug', ['USER_PROMPT']),
    ])

    expect(textOf(result[0])).toContain('why does the code emit')
  })

  it('still recognizes a real summary it produced itself', () => {
    const first = compact([
      user('the original request', ['USER_PROMPT']),
      assistant('working on it'),
    ])
    // The genuine artifact carries the header, so it is folded in rather than
    // re-summarized as if it were ordinary user text.
    const second = compactMessages({
      messages: [...first, assistant('more work')],
    })

    expect(second.stats.previous_summary_entry_count).toBeGreaterThan(0)
    expect(
      textOf(second.messages[0]).match(/<conversation_summary>/g),
    ).toHaveLength(1)
  })

  it('spends the two budgets independently: a flood of tool work keeps user prompts', () => {
    const { messages, stats } = compactMessages({
      messages: [
        user('the first request I made'),
        ...Array.from({ length: 200 }, (_, i) =>
          assistant(`step ${i}: ${'x'.repeat(500)}`),
        ),
        user('the live question', ['USER_PROMPT']),
      ],
      assistantToolBudget: 1_000,
      userBudget: 50_000,
    })

    expect(textOf(messages[0])).toContain('the first request I made')
    expect(stats.dropped_assistant_tool_entry_count).toBeGreaterThan(0)
    expect(stats.dropped_user_entry_count).toBe(0)
  })

  it('always keeps the newest entry even when it alone blows its budget', () => {
    const { messages, stats } = compactMessages({
      messages: [
        user('old', ['USER_PROMPT']),
        assistant(`HUGE ${'y'.repeat(50_000)}`),
      ],
      assistantToolBudget: 10,
      userBudget: 10,
    })

    expect(stats.newest_entry_forced).toBe(true)
    expect(textOf(messages[0])).toContain('HUGE')
  })

  it('carries the most recent images forward as real image parts', () => {
    const withImage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ],
      sentAt: 1,
    }
    const result = compact([
      withImage,
      assistant('I see it'),
      user('now?', ['USER_PROMPT']),
    ])

    const imageParts = (result[0].content as any[]).filter(
      (part) => part.type === 'image',
    )
    expect(imageParts).toHaveLength(1)
    expect(textOf(result[0])).toContain('[image(s) were attached]')
  })

  it('produces a summary well under the budget it was called for', () => {
    const { summaryText } = compactMessages({
      messages: [
        user('do the thing', ['USER_PROMPT']),
        ...Array.from({ length: 400 }, (_, i) =>
          i % 2 === 0
            ? assistant(`assistant turn ${i} ${'z'.repeat(2_000)}`)
            : toolResult('read_files', { content: 'z'.repeat(20_000) }),
        ),
      ],
    })

    // Default budgets are 20k assistant/tool + 50k user estimated tokens.
    expect(Math.ceil(summaryText.length / 3)).toBeLessThan(75_000)
  })
})

describe('promptCacheGapMs', () => {
  it('measures from the last assistant message to the live prompt', () => {
    expect(promptCacheGapMs(idleTurn(42))).toBe(42 * MINUTE)
  })

  it('skips tool messages, which carry no timestamp', () => {
    const [prevAssistant, prompt] = idleTurn(10)
    expect(
      promptCacheGapMs([
        prevAssistant,
        { role: 'tool', toolCallId: 'c1', toolName: 'read_files', content: [] },
        prompt,
      ]),
    ).toBe(10 * MINUTE)
  })

  it('is null when there is nothing to measure between', () => {
    expect(promptCacheGapMs([])).toBeNull()
    expect(
      promptCacheGapMs([user('only a prompt', ['USER_PROMPT'])]),
    ).toBeNull()
    expect(
      promptCacheGapMs([user('untagged'), user('prompt', ['USER_PROMPT'])]),
    ).toBeNull()
    expect(
      promptCacheGapMs([
        { ...assistant('no timestamp'), sentAt: undefined },
        user('prompt', ['USER_PROMPT']),
      ]),
    ).toBeNull()
  })
})

describe('evaluateCompactionTrigger', () => {
  /** Over the size floor, still well under the context limit. */
  const WORTH_COMPACTING = DEFAULT_CACHE_EXPIRY_MIN_TOKENS + 1

  const triggerFor = (
    messages: Message[],
    contextTokenCount: number,
    cacheExpiryMs?: number | null,
  ) =>
    evaluateCompactionTrigger({
      messages,
      contextTokenCount,
      maxContextLength: 400_000,
      cacheExpiryMs,
    }).trigger

  it('does nothing while the context fits and the cache is warm', () => {
    expect(triggerFor(idleTurn(5), WORTH_COMPACTING)).toBeNull()
  })

  it('fires on the context limit even with a warm cache', () => {
    expect(triggerFor(idleTurn(5), 500_000)).toBe('context_limit')
  })

  it('fires on a cold cache even when the context still fits', () => {
    const result = evaluateCompactionTrigger({
      messages: idleTurn(45),
      contextTokenCount: WORTH_COMPACTING,
      maxContextLength: 400_000,
    })
    expect(result.trigger).toBe('cache_expiry')
    expect(result.cacheGapMs).toBe(45 * MINUTE)
    expect(result.cacheExpiryMs).toBe(DEFAULT_CACHE_EXPIRY_MS)
    expect(result.cacheExpiryMinTokens).toBe(DEFAULT_CACHE_EXPIRY_MIN_TOKENS)
  })

  it('leaves a small conversation alone however cold the cache is', () => {
    // Compaction always costs detail; below the floor there is too little to
    // reclaim to be worth it, and the budget walk would evict nothing anyway.
    const result = evaluateCompactionTrigger({
      messages: idleTurn(600),
      contextTokenCount: DEFAULT_CACHE_EXPIRY_MIN_TOKENS - 1,
      maxContextLength: 400_000,
    })
    expect(result.trigger).toBeNull()
    // No point measuring a gap that cannot fire.
    expect(result.cacheGapMs).toBeNull()

    // One token more and it is worth doing.
    expect(triggerFor(idleTurn(600), DEFAULT_CACHE_EXPIRY_MIN_TOKENS)).toBe(
      'cache_expiry',
    )
  })

  it('honours a custom floor, and null removes it', () => {
    const tiny = 1_000
    expect(triggerFor(idleTurn(45), tiny)).toBeNull()
    expect(
      evaluateCompactionTrigger({
        messages: idleTurn(45),
        contextTokenCount: tiny,
        maxContextLength: 400_000,
        cacheExpiryMinTokens: 500,
      }).trigger,
    ).toBe('cache_expiry')
    expect(
      evaluateCompactionTrigger({
        messages: idleTurn(45),
        contextTokenCount: tiny,
        maxContextLength: 400_000,
        cacheExpiryMinTokens: null,
      }).trigger,
    ).toBe('cache_expiry')
  })

  it('the floor never blocks the context-limit trigger', () => {
    // A context over the limit must be compacted whatever the floor says.
    expect(
      evaluateCompactionTrigger({
        messages: idleTurn(45),
        contextTokenCount: 500_000,
        maxContextLength: 400_000,
        cacheExpiryMinTokens: 10_000_000,
      }).trigger,
    ).toBe('context_limit')
  })

  it('reports both when both are true', () => {
    expect(triggerFor(idleTurn(45), 500_000)).toBe(
      'context_limit_and_cache_expiry',
    )
  })

  it('honours a custom TTL in both directions', () => {
    expect(triggerFor(idleTurn(10), WORTH_COMPACTING)).toBeNull()
    expect(triggerFor(idleTurn(10), WORTH_COMPACTING, 5 * MINUTE)).toBe(
      'cache_expiry',
    )
    expect(triggerFor(idleTurn(45), WORTH_COMPACTING, 60 * MINUTE)).toBeNull()
  })

  it('a null TTL disables the opportunistic trigger entirely', () => {
    const result = evaluateCompactionTrigger({
      messages: idleTurn(600),
      contextTokenCount: WORTH_COMPACTING,
      maxContextLength: 400_000,
      cacheExpiryMs: null,
    })
    expect(result.trigger).toBeNull()
    expect(result.cacheGapMs).toBeNull()
    // The context limit still fires.
    expect(triggerFor(idleTurn(600), 500_000, null)).toBe('context_limit')
  })

  it('does not re-fire on the steps that follow a cache-expiry compaction', () => {
    const history = idleTurn(45)
    expect(triggerFor(history, WORTH_COMPACTING)).toBe('cache_expiry')

    // Compaction restamps every surviving message and drops the assistant
    // messages that preceded the live prompt, so the gap is gone.
    const compacted = compact(history)
    expect(triggerFor(compacted, WORTH_COMPACTING)).toBeNull()

    // ...and stays gone as the turn accumulates more work.
    expect(
      triggerFor(
        [...compacted, assistant('one'), assistant('two')],
        WORTH_COMPACTING,
      ),
    ).toBeNull()
  })

  it('fires again on the next turn if the user idles again', () => {
    const nextTurn: Message[] = [
      ...compact(idleTurn(45)),
      { ...assistant('done'), sentAt: 2_000_000 },
      {
        ...user('another question', ['USER_PROMPT']),
        sentAt: 2_000_000 + 45 * MINUTE,
      },
    ]
    expect(triggerFor(nextTurn, WORTH_COMPACTING)).toBe('cache_expiry')
  })
})

describe('maybeCompactHistory', () => {
  const overBudget = {
    contextTokenCount: 500_000,
    maxContextLength: 400_000,
  }

  it('returns null when no trigger fires', () => {
    expect(
      maybeCompactHistory({
        messages: idleTurn(5),
        contextTokenCount: DEFAULT_CACHE_EXPIRY_MIN_TOKENS,
        maxContextLength: 400_000,
      }),
    ).toBeNull()
  })

  it('compacts when a trigger fires', () => {
    const result = maybeCompactHistory({
      messages: [user('question', ['USER_PROMPT']), assistant('answer')],
      ...overBudget,
    })
    expect(result).not.toBeNull()
    expect(textOf(result![0])).toContain('<conversation_summary>')
  })

  it('logs the trigger, the cache gap and the pruner-compatible stats', () => {
    const logs: Array<Record<string, any>> = []
    const logger = {
      debug: () => {},
      info: (data: Record<string, any>) => logs.push(data),
      warn: () => {},
      error: () => {},
    } as any

    maybeCompactHistory({
      messages: idleTurn(45),
      contextTokenCount: DEFAULT_CACHE_EXPIRY_MIN_TOKENS,
      maxContextLength: 400_000,
      logger,
      runId: 'run-1',
    })

    expect(logs).toHaveLength(1)
    const [event] = logs
    expect(event.axiomEvent).toBe('context_compaction_completed')
    expect(event.agent_run_id).toBe('run-1')
    expect(event.trigger_reason).toBe('cache_expiry')
    expect(event.cache_gap_ms).toBe(45 * MINUTE)
    expect(event.cache_expiry_ms).toBe(DEFAULT_CACHE_EXPIRY_MS)
    // Field names the context-pruner already emits, so the two can be queried
    // as one series. Every key must be snake_case.
    for (const key of [
      'mid_turn',
      'user_budget',
      'assistant_tool_budget',
      'previous_summary_entry_count',
      'user_entry_count',
      'dropped_user_entry_count',
      'assistant_tool_entry_count',
      'dropped_assistant_tool_entry_count',
      'newest_entry_forced',
      'live_user_prompt_found',
      'summary_estimated_tokens',
      'cache_expiry_min_tokens',
    ]) {
      expect(event).toHaveProperty(key)
    }
    expect(Object.keys(event).filter((k) => /[A-Z]/.test(k))).toEqual([
      'axiomEvent',
    ])
  })

  it('omits the cache fields when the trigger is disabled', () => {
    const logs: Array<Record<string, any>> = []
    const logger = {
      debug: () => {},
      info: (data: Record<string, any>) => logs.push(data),
      warn: () => {},
      error: () => {},
    } as any

    maybeCompactHistory({
      messages: idleTurn(600),
      ...overBudget,
      cacheExpiryMs: null,
      logger,
    })

    expect(logs[0].trigger_reason).toBe('context_limit')
    expect(logs[0]).not.toHaveProperty('cache_gap_ms')
    expect(logs[0]).not.toHaveProperty('cache_expiry_ms')
  })

  it('never throws when the logger does', () => {
    const brokenLogger = {
      debug: () => {},
      info: () => {
        throw new Error('logger unavailable')
      },
      warn: () => {},
      error: () => {},
    } as any

    expect(() =>
      maybeCompactHistory({
        messages: [user('question', ['USER_PROMPT']), assistant('answer')],
        ...overBudget,
        logger: brokenLogger,
      }),
    ).not.toThrow()
  })

  it('reports P1.5 telemetry: trigger_source window and scaled budgets', () => {
    const logs: Array<Record<string, any>> = []
    const logger = {
      debug: () => {},
      info: (data: Record<string, any>) => logs.push(data),
      warn: () => {},
      error: () => {},
    } as any

    maybeCompactHistory({
      messages: idleTurn(600),
      contextTokenCount: 1_000_000,
      // 1M window → trigger 700k → scale 1.75
      maxContextLength: 700_000,
      cacheExpiryMs: null,
      logger,
    })

    expect(logs[0].trigger_source).toBe('window')
    expect(logs[0].budget_scale).toBeCloseTo(1.75)
    expect(logs[0].assistant_tool_budget).toBe(35_000)
    expect(logs[0].user_budget).toBe(87_500)
    expect(logs[0].tail_budget).toBe(17_500)
    expect(logs[0]).toHaveProperty('tail_tokens')
    expect(logs[0]).toHaveProperty('tail_pair_count')
    expect(logs[0]).toHaveProperty('knowledge_block_tokens')
  })
})

describe('P1.5 tail window (C4)', () => {
  const atc = assistantToolCall
  const tr = toolResult

  it('keeps the newest tool exchange verbatim and drops it from the summary', () => {
    const history = [
      user('old request', ['USER_PROMPT']),
      assistant('working on it'),
      atc('read_files', { paths: ['old.ts'] }),
      atc('run_terminal_command', { command: 'bun test' }),
      tr('run_terminal_command', { exitCode: 1 }),
    ]

    const result = compactMessages({ messages: history })
    const summary = textOf(result.messages[0])
    const tail = result.messages.slice(1, -1) // between summary and live/continuation

    // The live exchange is verbatim in the final messages...
    expect(tail.some((m) => m.role === 'tool' && (m as any).toolName === 'run_terminal_command')).toBe(true)
    expect(tail.some((m) => m.role === 'assistant')).toBe(true)
    // ...and not duplicated in the summary.
    expect(summary).not.toContain('ran command: bun test')
    expect(summary).not.toContain('Command failed with exit code: 1')
    expect(result.stats.tail_pair_count).toBe(2)
    expect(result.stats.tail_tokens).toBeGreaterThan(0)
  })

  it('trims a dangling tool result at the tail boundary', () => {
    const history = [
      user('request', ['USER_PROMPT']),
      atc('str_replace', { path: 'a.ts' }),
      tr('str_replace', { message: 'ok' }),
      assistant('done with the edit'),
    ]

    const result = compactMessages({ messages: history, tailBudget: 1 })
    const tail = result.messages.slice(1, -1)

    // The lone trailing prose message cannot form a pair — no tail at all.
    expect(tail).toHaveLength(0)
    expect(result.stats.tail_pair_count).toBe(0)
  })

  it('respects tailBudget: 0 disables the tail entirely', () => {
    const history = [
      user('request', ['USER_PROMPT']),
      atc('read_files', { paths: ['a.ts'] }),
      tr('read_files', { content: 'body' }),
    ]

    const result = compactMessages({ messages: history, tailBudget: 0 })
    const summary = textOf(result.messages[0])

    expect(result.stats.tail_pair_count).toBe(0)
    expect(summary).toContain('inspected files: a.ts')
  })

  it('keeps interleaved plain messages with their surrounding pairs', () => {
    const history = [
      user('request', ['USER_PROMPT']),
      assistant('starting'),
      atc('read_files', { paths: ['a.ts'] }),
      tr('read_files', { content: 'body' }),
      assistant('now editing'),
      atc('str_replace', { path: 'a.ts' }),
      tr('str_replace', { message: 'ok' }),
    ]

    const result = compactMessages({ messages: history })
    // [summary, live prompt, ...tail] — mid-turn puts the prompt into the
    // summary and appends the continuation, so slice by role.
    const tailStart = result.messages.findIndex(
      (m, i) => i > 0 && m.role === 'assistant',
    )
    const tail = result.messages.slice(tailStart, -1)

    expect(tail.map((m) => m.role)).toEqual([
      'assistant',
      'assistant',
      'tool',
      'assistant',
      'assistant',
      'tool',
    ])
    expect(textOf(tail[0])).toContain('starting')
    expect(textOf(tail[3])).toContain('now editing')
  })
})

describe('P1.5 knowledge block (C3)', () => {
  it('pins Goal / Files / Edits / Next ahead of the historical memory', () => {
    const history: Message[] = [
      user('build the export feature', ['USER_PROMPT']),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'read_files', input: { paths: ['src/a.ts'] } },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'str_replace', input: { path: 'src/b.ts' } },
        ],
        sentAt: 1,
      },
      toolResult('str_replace', { message: 'ok' }),
      assistant('final note'),
      user('ok', ['USER_PROMPT']),
    ]

    const result = compactMessages({ messages: history, tailBudget: 0 })
    const summary = textOf(result.messages[0])

    expect(summary).toContain('<knowledge_memory>')
    expect(summary).toContain('Goal: build the export feature')
    expect(summary).toContain('- src/a.ts')
    expect(summary).toContain('Edits Made:')
    expect(summary).toContain('- src/b.ts')
    expect(summary).toContain('Next Action: final note')
    // The noise reply is not taken as the goal.
    expect(summary).not.toContain('Goal: ok')
  })

  it('carries entries from the previous block across compaction cycles', () => {
    const first = compactMessages({
      messages: [
        user('first request', ['USER_PROMPT']),
        assistantToolCall('read_files', { paths: ['one.ts'] }),
        toolResult('read_files', { content: 'x' }),
      ],
      tailBudget: 0,
    })

    const second = compactMessages({
      messages: [
        ...first.messages.slice(0, -1), // summary + continuation
        assistantToolCall('read_files', { paths: ['two.ts'] }),
        toolResult('read_files', { content: 'y' }),
        user('second request', ['USER_PROMPT']),
      ],
      tailBudget: 0,
    })
    const summary = textOf(second.messages[0])

    expect(summary).toContain('- one.ts')
    expect(summary).toContain('- two.ts')
  })
})

describe('P1.5 C2 recent assistant exemption', () => {
  it('keeps the newest assistant prose under the relaxed cap', () => {
    // 8k chars = ~2.7k tokens: under the 6k exempt cap, over the 1.3k base
    // cap. It is the newest prose assistant, so it survives un-truncated.
    const longText = 'B'.repeat(8000)
    const result = compactMessages({
      messages: [user('request', ['USER_PROMPT']), assistant(longText)],
      tailBudget: 0,
    })
    const summary = textOf(result.messages[0])

    expect(summary).toContain('BBBBBBBBBB')
    expect(summary).not.toContain('[...truncated')
  })

  it('still truncates older assistant prose at 1.3k tokens', () => {
    // 8k chars ≈ 2.7k tokens, over the 1.3k base cap. Five later prose
    // assistants exhaust the exemption before reaching it. The 80/20 split
    // keeps the prefix, so assert on a middle marker instead of the text.
    const longText =
      'B'.repeat(4000) + '_LONG_MIDDLE_MARKER_' + 'B'.repeat(3900)
    const result = compactMessages({
      messages: [
        user('request', ['USER_PROMPT']),
        assistant(longText),
        ...Array.from({ length: 5 }, (_, i) => assistant(`later ${i}`)),
      ],
      tailBudget: 0,
    })
    const summary = textOf(result.messages[0])

    expect(summary).not.toContain('_LONG_MIDDLE_MARKER_')
    expect(summary).toContain('[...truncated')
  })
})

describe('P1.5 C1 budget scaling', () => {
  it('scales budgets with maxContextLength and honors overrides', () => {
    const history = [
      user('request', ['USER_PROMPT']),
      assistant('answer'),
    ]

    const scaled = compactMessages({ messages: history, maxContextLength: 700_000, tailBudget: 0 })
    expect(scaled.stats.budget_scale).toBeCloseTo(1.75)
    expect(scaled.stats.assistant_tool_budget).toBe(35_000)
    expect(scaled.stats.user_budget).toBe(87_500)

    // Explicit overrides always win (existing semantics).
    const overridden = compactMessages({
      messages: history,
      maxContextLength: 700_000,
      assistantToolBudget: 11_000,
      userBudget: 26_000,
      tailBudget: 5_000,
    })
    expect(overridden.stats.assistant_tool_budget).toBe(11_000)
    expect(overridden.stats.user_budget).toBe(26_000)
    expect(overridden.stats.tail_budget).toBe(5_000)

    // Small windows clamp at scale 0.5.
    const small = compactMessages({ messages: history, maxContextLength: 100_000, tailBudget: 0 })
    expect(small.stats.budget_scale).toBe(0.5)
    expect(small.stats.assistant_tool_budget).toBe(10_000)
    expect(small.stats.user_budget).toBe(25_000)
  })

  it('reproduces the pre-P1.5 budgets at the 400k anchor', () => {
    const history = [user('request', ['USER_PROMPT']), assistant('answer')]
    const result = compactMessages({ messages: history })

    expect(result.stats.budget_scale).toBe(1)
    expect(result.stats.assistant_tool_budget).toBe(20_000)
    expect(result.stats.user_budget).toBe(50_000)
    expect(result.stats.tail_budget).toBe(10_000)
    expect(result.stats.trigger_source).toBe('baked')
  })
})
