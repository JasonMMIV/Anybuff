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
  const { request } = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    includeRawChunks: false,
    ...(config.providerOptions
      ? { providerOptions: config.providerOptions }
      : {}),
  } as Parameters<typeof model.doStream>[0])
  const raw = request.body
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
