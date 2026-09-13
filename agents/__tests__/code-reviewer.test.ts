import { describe, test, expect } from 'bun:test'

import { LITE_MODEL, OPUS_MODEL } from '../constants'
import codeReviewer from '../reviewer/code-reviewer'
import codeReviewerLite from '../reviewer/code-reviewer-lite'

import type { AgentState } from '../types/agent-definition'
import type { Message, ToolResultOutput } from '../types/util-types'

// ADR-28: the reviewer sees a curated transcript — reasoning parts stripped
// from assistant messages except the final assistant run, which must replay
// verbatim for the Claude thinking contract. These tests lock that curation
// and the AnyBuff reviewer fixes around it.

describe('code-reviewer agent', () => {
  const createMockAgentState = (
    messageHistory: Message[] = [],
  ): AgentState => ({
    agentId: 'code-reviewer-test',
    runId: 'test-run',
    parentId: undefined,
    messageHistory,
    output: undefined,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount: 0,
  })

  const mockLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }

  // Runs handleSteps to the first yield. The history curation happens
  // synchronously before that yield, so the mock state can be asserted on
  // directly afterwards.
  const runHandleSteps = (agentState: AgentState) => {
    const generator = codeReviewer.handleSteps!({
      agentState,
      logger: mockLogger as any,
      params: {},
    })
    const result = generator.next()
    expect(result.value).toBe('STEP')
  }

  const textPart = (text: string) => ({ type: 'text' as const, text })

  const reasoningPart = (text: string) => ({
    type: 'reasoning' as const,
    text,
  })

  const toolOutput = (value: string): ToolResultOutput[] => [
    { type: 'json', value },
  ]

  describe('definition', () => {
    test('has correct id', () => {
      expect(codeReviewer.id).toBe('code-reviewer')
    })

    test('has display name', () => {
      expect(codeReviewer.displayName).toBe('Nit Pick Nick')
    })

    test('uses opus model', () => {
      expect(codeReviewer.model).toBe(OPUS_MODEL)
    })

    test('includes message history', () => {
      expect(codeReviewer.includeMessageHistory).toBe(true)
    })

    test('does not inherit the parent system prompt (AnyBuff fix)', () => {
      expect(codeReviewer.inheritParentSystemPrompt).toBe(false)
    })

    test('has empty tool names', () => {
      expect(codeReviewer.toolNames).toHaveLength(0)
    })

    test('has empty spawnable agents', () => {
      expect(codeReviewer.spawnableAgents).toHaveLength(0)
    })

    test('lite runs the same factory, curated history included', () => {
      expect(codeReviewerLite.id).toBe('code-reviewer-lite')
      expect(codeReviewerLite.model).toBe(LITE_MODEL)
      // Separate spread copies — the source text must be identical so the
      // lite reviewer strips exactly like the generic one.
      expect(String(codeReviewerLite.handleSteps)).toBe(
        String(codeReviewer.handleSteps),
      )
    })
  })

  describe('instructions prompt', () => {
    test('notes the curated history', () => {
      expect(codeReviewer.instructionsPrompt).toContain(
        'intentionally curated',
      )
      expect(codeReviewer.instructionsPrompt).toContain(
        "author's internal reasoning",
      )
    })

    test('places the curation note between the request and the task', () => {
      const prompt = codeReviewer.instructionsPrompt!
      // The note must sit between the original request block and the task
      // section — a future prompt edit relocating it would bury it.
      expect(prompt.indexOf('intentionally curated')).toBeGreaterThan(
        prompt.indexOf('</user_message>'),
      )
      expect(prompt.indexOf('intentionally curated')).toBeLessThan(
        prompt.indexOf('# Task'),
      )
    })

    test('lite gets the same curated-history note', () => {
      expect(codeReviewerLite.instructionsPrompt).toContain(
        'intentionally curated',
      )
    })

    test('still carries the original user request placeholder', () => {
      expect(codeReviewer.instructionsPrompt).toContain(
        '{CODEBUFF_USER_INPUT_PROMPT}',
      )
    })
  })

  describe('handleSteps reasoning strip', () => {
    test('strips old reasoning, keeps facts, preserves the final run', () => {
      const messages: Message[] = [
        { role: 'user', content: [textPart('Fix the login bug')] },
        {
          role: 'assistant',
          content: [
            reasoningPart('internal deliberation about the approach'),
            textPart('Reading the auth file first.'),
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'read_files',
              input: { paths: ['auth.ts'] },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          toolName: 'read_files',
          content: toolOutput('auth.ts contents'),
        },
        {
          // Isolated reasoning-only turn: the user message after it breaks
          // the assistant run, so it is outside the verbatim final run.
          role: 'assistant',
          content: [reasoningPart('abandoned intermediate tangent')],
        },
        { role: 'user', content: [textPart('Now apply the fix')] },
        {
          role: 'assistant',
          content: [
            reasoningPart('final deliberation before spawning the reviewer'),
            textPart('Changes are ready for review'),
          ],
        },
      ]
      const agentState = createMockAgentState(messages)

      runHandleSteps(agentState)

      const curated = agentState.messageHistory
      // The reasoning-only turn drops; everything else survives.
      expect(curated).toHaveLength(5)

      // Old assistant: reasoning gone, visible text + tool call kept, and
      // the message is a rebuilt object — never the shared original.
      const oldAssistant = curated[1]
      expect(oldAssistant).not.toBe(messages[1])
      expect(oldAssistant.role).toBe('assistant')
      expect(
        (oldAssistant.content as unknown as Array<{ type: string }>).map(
          (part) => part.type,
        ),
      ).toEqual(['text', 'tool-call'])

      // User / tool messages pass through as the same objects.
      expect(curated[0]).toBe(messages[0])
      expect(curated[2]).toBe(messages[2])
      expect(curated[3]).toBe(messages[4])

      // Final assistant run preserved verbatim — same object, reasoning kept.
      expect(curated[4]).toBe(messages[5])
      expect(
        (curated[4].content as unknown as Array<{ type: string }>)[0].type,
      ).toBe('reasoning')
    })

    test('never mutates the original history array or message objects', () => {
      const oldAssistant: Message = {
        role: 'assistant',
        content: [
          reasoningPart('private reasoning'),
          textPart('Visible narration'),
        ],
      }
      const finalAssistant: Message = {
        role: 'assistant',
        content: [
          reasoningPart('final run reasoning'),
          textPart('Ready for review'),
        ],
      }
      const messages: Message[] = [
        { role: 'user', content: [textPart('Fix it')] },
        oldAssistant,
        { role: 'user', content: [textPart('Now finish')] },
        finalAssistant,
      ]
      const snapshot = JSON.stringify(messages)
      const agentState = createMockAgentState(messages)

      runHandleSteps(agentState)

      // Parent-line history untouched: the shared originals keep their
      // reasoning (ADR-26 governs the parent line, not this child-side
      // curation).
      expect(JSON.stringify(messages)).toBe(snapshot)
      expect(
        (oldAssistant.content as unknown as Array<{ type: string }>)[0].type,
      ).toBe('reasoning')

      // The child works on a fresh array, not the shared one.
      expect(agentState.messageHistory).not.toBe(messages)
      expect(agentState.messageHistory).toHaveLength(4)
    })

    test('preserves a contiguous trailing assistant run verbatim', () => {
      const runStart: Message = {
        role: 'assistant',
        content: [reasoningPart('run part 1 reasoning')],
      }
      const runEnd: Message = {
        role: 'assistant',
        content: [reasoningPart('run part 2 reasoning'), textPart('Done')],
      }
      const messages: Message[] = [
        { role: 'user', content: [textPart('Go')] },
        runStart,
        runEnd,
      ]
      const agentState = createMockAgentState(messages)

      runHandleSteps(agentState)

      // Adjacent assistant messages merge on the wire — the whole trailing
      // run replays verbatim (splitTail boundary semantics), reasoning
      // included.
      expect(agentState.messageHistory).toHaveLength(3)
      expect(agentState.messageHistory[1]).toBe(runStart)
      expect(agentState.messageHistory[2]).toBe(runEnd)
      expect(
        (runStart.content as unknown as Array<{ type: string }>)[0].type,
      ).toBe('reasoning')
    })

    test('passes a history with no assistant messages through unchanged', () => {
      const messages: Message[] = [
        { role: 'user', content: [textPart('Hello')] },
        { role: 'user', content: [textPart('Anyone there?')] },
      ]
      const agentState = createMockAgentState(messages)

      runHandleSteps(agentState)

      expect(agentState.messageHistory).toEqual(messages)
      expect(agentState.messageHistory[0]).toBe(messages[0])
      expect(agentState.messageHistory[1]).toBe(messages[1])
    })

    test('passes string-content assistant messages through defensively', () => {
      const stringAssistant = {
        role: 'assistant',
        content: 'Simple string response',
      } as unknown as Message
      const messages: Message[] = [
        stringAssistant,
        { role: 'user', content: [textPart('Thanks')] },
        { role: 'assistant', content: [textPart('Done')] },
      ]
      const agentState = createMockAgentState(messages)

      runHandleSteps(agentState)

      expect(agentState.messageHistory).toHaveLength(3)
      expect(agentState.messageHistory[0]).toBe(stringAssistant)
    })

    test('leaves a reasoning-free history untouched', () => {
      const messages: Message[] = [
        { role: 'user', content: [textPart('Fix it')] },
        {
          role: 'assistant',
          content: [
            textPart('On it'),
            {
              type: 'tool-call',
              toolCallId: 'call-2',
              toolName: 'read_files',
              input: {},
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call-2',
          toolName: 'read_files',
          content: toolOutput('contents'),
        },
        { role: 'assistant', content: [textPart('Done')] },
      ]
      const agentState = createMockAgentState(messages)

      runHandleSteps(agentState)

      // Nothing to strip: every message keeps its identity (the final
      // assistant is the last run; the earlier one short-circuits the
      // filter).
      expect(agentState.messageHistory).toEqual(messages)
      expect(agentState.messageHistory[1]).toBe(messages[1])
      expect(agentState.messageHistory[3]).toBe(messages[3])
    })

    test('handleSteps can be serialized for sandbox execution', () => {
      const handleStepsString = codeReviewer.handleSteps!.toString()

      // Verify it's a valid generator function string
      expect(handleStepsString).toMatch(/^function\*\s*\(/)

      // Should be able to create a new function from it
      const isolatedFunction = new Function(
        `return (${handleStepsString})`,
      )()
      expect(typeof isolatedFunction).toBe('function')

      // The serialized copy still curates history and yields STEP.
      const agentState = createMockAgentState([
        {
          role: 'assistant',
          content: [reasoningPart('secret deliberation'), textPart('Visible')],
        },
        { role: 'user', content: [textPart('Go on')] },
        { role: 'assistant', content: [textPart('Done')] },
      ])
      const generator = isolatedFunction({
        agentState,
        logger: mockLogger as any,
      })
      expect(generator.next().value).toBe('STEP')
      expect(
        (
          agentState.messageHistory[0]
            .content as unknown as Array<{ type: string }>
        )[0].type,
      ).toBe('text')
    })
  })
})
