import { z } from 'zod/v4'

export type OpenAICompatibleChatModelId = string

export const openaiCompatibleProviderOptions = z.object({
  /**
   * A unique identifier representing your end-user, which can help the provider to
   * monitor and detect abuse.
   */
  user: z.string().optional(),

  /**
   * Reasoning effort for reasoning models. Defaults to `medium`.
   */
  reasoningEffort: z.string().optional(),

  /**
   * Controls the verbosity of the generated text. Defaults to `medium`.
   */
  textVerbosity: z.string().optional(),

  /**
   * Enable thinking / reasoning tokens on providers like DashScope
   * (Alibaba Cloud) for Qwen, DeepSeek-R1, etc.
   */
  enableThinking: z.boolean().optional(),

  /**
   * Thinking token budget for models supporting budget controls.
   */
  thinkingBudget: z.number().optional(),
})

export type OpenAICompatibleProviderOptions = z.infer<
  typeof openaiCompatibleProviderOptions
>
