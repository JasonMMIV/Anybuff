import { describe, expect, test } from 'bun:test'

import { createMultiPromptEditor } from '../editor/best-of-n/editor-multi-prompt'

type YieldedCall = {
  toolName: string
  input: Record<string, unknown>
}

const createAgentState = (messageHistory: unknown[] = []) =>
  ({
    agentId: 'editor-multi-prompt-test',
    runId: 'test-run',
    parentId: undefined,
    messageHistory,
    output: undefined,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount: 0,
  }) as any

const CONTROL_TOOLS = new Set(['set_messages', 'set_output'])

/**
 * Drives `handleSteps` directly. `agents/` has no dependency on
 * `@codebuff/agent-runtime`, so `runProgrammaticStep` is not importable here —
 * a plain generator driver is both sufficient and closer to the real contract.
 */
const driveEditor = (
  params: Record<string, unknown>,
  toolResults: unknown[][],
): YieldedCall[] => {
  const editor = createMultiPromptEditor()
  const handleSteps = editor.handleSteps as any
  const generator = handleSteps({
    agentState: createAgentState([
      { role: 'user', content: [{ type: 'text', text: 'do the task' }] },
    ]),
    params,
  }) as Generator<any, any, any>

  const yielded: YieldedCall[] = []
  let resultIndex = 0
  let step = generator.next()

  while (!step.done) {
    const call = step.value as YieldedCall
    yielded.push(call)
    const toolResult = CONTROL_TOOLS.has(call.toolName)
      ? [{ type: 'json', value: { message: 'ok' } }]
      : toolResults[resultIndex++]
    step = generator.next({ toolResult })
  }

  if (resultIndex !== toolResults.length) {
    throw new Error(
      `driveEditor consumed ${resultIndex} tool results but received ${toolResults.length}`,
    )
  }

  return yielded
}

const implementorSpawnResult = (outputs: unknown[]) => [
  {
    type: 'json',
    value: outputs.map((output, index) => ({
      agentName: `Implementation Generator ${index}`,
      agentType: 'editor-implementor',
      value: { type: 'structuredOutput', value: output },
    })),
  },
]

const selectorSpawnResult = (implementationId: string) => [
  {
    type: 'json',
    value: [
      {
        agentName: 'Best-of-N Opus Diff Selector',
        agentType: 'best-of-n-selector2',
        value: {
          type: 'structuredOutput',
          value: {
            implementationId,
            reason: 'it is the simplest',
            suggestedImprovements: 'add a test',
          },
        },
      },
    ],
  },
]

const appliedEditResult = [
  {
    type: 'json',
    value: { file: 'src/a.ts', message: 'Successfully replaced 1 occurrence' },
  },
]

const lastOutput = (yielded: YieldedCall[]) => yielded[yielded.length - 1]

describe('editor-multi-prompt output', () => {
  test('surfaces the winning unified diff alongside the existing fields', () => {
    const yielded = driveEditor({ prompts: ['cache it', 'do not cache'] }, [
      implementorSpawnResult([
        {
          toolCalls: [
            {
              toolName: 'propose_str_replace',
              input: {
                path: 'src/a.ts',
                replacements: [{ oldString: 'a', newString: 'b' }],
              },
            },
          ],
          toolResults: [],
          unifiedDiffs: '--- src/a.ts ---\n+const a = 2',
        },
        {
          toolCalls: [],
          toolResults: [],
          unifiedDiffs: '--- src/a.ts ---\n+const a = 3',
        },
      ]),
      selectorSpawnResult('A'),
      appliedEditResult,
    ])

    const output = lastOutput(yielded)

    expect(output.toolName).toBe('set_output')
    expect(output.input.unifiedDiff).toBe('--- src/a.ts ---\n+const a = 2')
    expect(output.input.chosenStrategy).toBe('cache it')
    expect(output.input.reason).toBe('it is the simplest')
    expect(output.input.suggestedImprovements).toBe('add a test')
    expect(output.input.toolResults).toEqual([appliedEditResult])
  })

  test('omits unifiedDiff when the winner proposed no changes', () => {
    const yielded = driveEditor({ prompts: ['no-op'] }, [
      implementorSpawnResult([
        { toolCalls: [], toolResults: [], unifiedDiffs: '' },
      ]),
      selectorSpawnResult('A'),
    ])

    const output = lastOutput(yielded)

    expect(output.toolName).toBe('set_output')
    expect(output.input.chosenStrategy).toBe('no-op')
    expect(output.input).not.toHaveProperty('unifiedDiff')
  })

  test('omits unifiedDiff when the winning implementation failed', () => {
    const yielded = driveEditor({ prompts: ['first', 'second'] }, [
      [
        {
          type: 'json',
          value: [
            {
              agentName: 'Implementation Generator 0',
              agentType: 'editor-implementor',
              value: {
                type: 'structuredOutput',
                value: {
                  toolCalls: [],
                  toolResults: [],
                  unifiedDiffs: '--- src/a.ts ---\n+x',
                },
              },
            },
            {
              agentName: 'Implementation Generator 1',
              agentType: 'editor-implementor',
              value: { errorMessage: 'model unavailable' },
            },
          ],
        },
      ],
      selectorSpawnResult('B'),
    ])

    const output = lastOutput(yielded)

    expect(output.toolName).toBe('set_output')
    expect(output.input.chosenStrategy).toBe('second')
    expect(output.input).not.toHaveProperty('unifiedDiff')
    expect(output.input.toolResults).toEqual([])
  })

  test('omits unifiedDiff when the reported diff is only whitespace', () => {
    const yielded = driveEditor({ prompts: ['blank'] }, [
      implementorSpawnResult([
        { toolCalls: [], toolResults: [], unifiedDiffs: '   \n  ' },
      ]),
      selectorSpawnResult('A'),
    ])

    const output = lastOutput(yielded)

    expect(output.toolName).toBe('set_output')
    expect(output.input).not.toHaveProperty('unifiedDiff')
  })

  test('reports an error when no prompts are provided', () => {
    const yielded = driveEditor({ prompts: [] }, [])

    expect(yielded).toHaveLength(1)
    expect(yielded[0].toolName).toBe('set_output')
    expect(yielded[0].input.error).toContain('No prompts provided')
  })

  test('reports an error when the selector fails', () => {
    const yielded = driveEditor({ prompts: ['only'] }, [
      implementorSpawnResult([
        { toolCalls: [], toolResults: [], unifiedDiffs: '--- src/a.ts ---\n+x' },
      ]),
      [
        {
          type: 'json',
          value: [
            {
              agentName: 'Best-of-N Opus Diff Selector',
              agentType: 'best-of-n-selector2',
              value: { errorMessage: 'selector crashed' },
            },
          ],
        },
      ],
    ])

    const output = lastOutput(yielded)

    expect(output.toolName).toBe('set_output')
    expect(output.input.error).toContain('Selector failed')
    expect(output.input).not.toHaveProperty('unifiedDiff')
  })
})
