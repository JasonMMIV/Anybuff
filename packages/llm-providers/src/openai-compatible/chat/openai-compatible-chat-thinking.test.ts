import { describe, expect, it } from 'bun:test'

import { OpenAICompatibleChatLanguageModel } from './openai-compatible-chat-language-model'

/**
 * ADR-25: `enable_thinking` is a DashScope-specific parameter. Strict
 * OpenAI-compatible gateways reject unknown body parameters with a 400, so it
 * must only be sent when the provider explicitly opts in — never as an
 * implicit companion of a `reasoning_effort` value.
 */
function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function chunk(delta: object, extra: object = {}): string {
  return JSON.stringify({
    id: 'cmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, ...extra }],
  })
}

async function requestBodyFor(config: {
  enableThinking?: boolean
  providerOptions?: Record<string, Record<string, unknown>>
}): Promise<Record<string, unknown>> {
  const model = new OpenAICompatibleChatLanguageModel('test-model', {
    provider: 'test-provider',
    headers: () => ({}),
    url: () => 'https://example.test/v1/chat/completions',
    fetch: (async () =>
      sseResponse([chunk({ content: 'hi' }, { finish_reason: 'stop' })])) as unknown as typeof fetch,
    ...(config.enableThinking !== undefined
      ? { enableThinking: config.enableThinking }
      : {}),
  })
  const response = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    includeRawChunks: false,
    ...(config.providerOptions
      ? { providerOptions: config.providerOptions }
      : {}),
  } as Parameters<typeof model.doStream>[0])
  const raw = response.request?.body
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<
    string,
    unknown
  >
}

describe('enable_thinking is opt-in (ADR-25)', () => {
  it('sends reasoning_effort WITHOUT enable_thinking when nothing opted in', async () => {
    const body = await requestBodyFor({
      providerOptions: { 'test-provider': { reasoningEffort: 'high' } },
    })
    expect(body.reasoning_effort).toBe('high')
    expect(body).not.toHaveProperty('enable_thinking')
  })

  it('sends enable_thinking when the provider config opts in (DashScope)', async () => {
    const body = await requestBodyFor({
      enableThinking: true,
      providerOptions: { 'test-provider': { reasoningEffort: 'high' } },
    })
    expect(body.reasoning_effort).toBe('high')
    expect(body.enable_thinking).toBe(true)
  })

  it('still honors a bare enableThinking provider option with no effort', async () => {
    const body = await requestBodyFor({
      providerOptions: { 'test-provider': { enableThinking: true } },
    })
    expect(body.enable_thinking).toBe(true)
    expect(body).not.toHaveProperty('reasoning_effort')
  })
})

describe('DeepSeek reasoning_content backfill (ADR-26)', () => {
  /**
   * A programmatic-agent history: the bare tool-call assistant message with
   * no reasoning part (run-programmatic-step pushes exactly this shape) plus
   * its tool result. The wire contract applies when the request carries
   * tools — these requests gate the backfill on the model id.
   */
  const deepseekPrompt = [
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tc-1',
          toolName: 'run_command',
          input: { command: 'ls' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'run_command',
          output: { type: 'text', value: 'ok' },
        },
      ],
    },
  ]

  async function messagesFor(opts: {
    modelId: string
    tools?: boolean
  }): Promise<Array<Record<string, unknown>>> {
    const model = new OpenAICompatibleChatLanguageModel(opts.modelId as any, {
      provider: 'test-provider',
      headers: () => ({}),
      url: () => 'https://example.test/v1/chat/completions',
      fetch: (async () =>
        sseResponse([
          chunk({ content: 'hi' }, { finish_reason: 'stop' }),
        ])) as unknown as typeof fetch,
    })
    const response = await model.doStream({
      prompt: deepseekPrompt as any,
      tools: opts.tools
        ? ([
            {
              type: 'function',
              name: 'run_command',
              description: 'Run a command',
              inputSchema: { type: 'object', properties: {} },
            },
          ] as any)
        : undefined,
      includeRawChunks: false,
    } as Parameters<typeof model.doStream>[0])
    const body =
      typeof response.request?.body === 'string'
        ? JSON.parse(response.request.body)
        : (response.request?.body as Record<string, unknown>)
    return body.messages as Array<Record<string, unknown>>
  }

  it('backfills reasoning_content on a deepseek model when the request carries tools', async () => {
    const messages = await messagesFor({
      modelId: 'deepseek/deepseek-v4.1-flash',
      tools: true,
    })
    const assistant = messages.find((m) => m.role === 'assistant')!

    expect(assistant.reasoning_content).toBe('')
    expect(Array.isArray(assistant.tool_calls)).toBe(true)
  })

  it('does not backfill when the request carries no tools', async () => {
    // The vendor contract scopes the requirement to tools-carrying requests;
    // no-tools requests ignore reasoning_content entirely, so the field is
    // not added there.
    const messages = await messagesFor({
      modelId: 'deepseek/deepseek-v4.1-flash',
    })

    expect(
      (messages.find((m) => m.role === 'assistant') as any).reasoning_content,
    ).toBeUndefined()
  })

  it('does not backfill for non-deepseek models', async () => {
    const messages = await messagesFor({ modelId: 'test-model', tools: true })

    expect(
      (messages.find((m) => m.role === 'assistant') as any).reasoning_content,
    ).toBeUndefined()
  })
})
