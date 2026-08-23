import { getAnybuffApiKeyFromEnv, getCodebuffApiKeyFromEnv } from './env'
import { run } from './run'

import type { RunOptions, CodebuffClientOptions } from './run'
import type { RunState } from './run-state'

export class CodebuffClient {
  public options: CodebuffClientOptions & {
    apiKey: string
    fingerprintId: string
  }

  constructor(options: CodebuffClientOptions) {
    // Local BYOK: the hosted API key is optional. Provider credentials live in
    // anybuff.json (apiKeyEnv or host-injected keyMap); a hosted key is still
    // accepted for hosts that proxy through the Codebuff backend.
    const foundApiKey =
      options.apiKey ??
      getAnybuffApiKeyFromEnv() ??
      getCodebuffApiKeyFromEnv() ??
      ''

    this.options = {
      apiKey: foundApiKey,
      handleEvent: (event) => {
        if (event.type === 'error') {
          throw new Error(
            `Received error: ${event.message}.\n\nProvide a handleEvent function to handle this error.`,
          )
        }
      },
      fingerprintId: `codebuff-sdk-${Math.random().toString(36).substring(2, 15)}`,
      ...options,
    }
  }

  /**
   * Run an agent with the specified options.
   *
   * @param agent - The agent to run. Use 'base' for the default agent, or specify a custom agent ID if you made your own agent config.
   * @param prompt - The user prompt describing what you want the agent to do.
   * @param params - (Optional) Additional parameters for the agent.
   * @param handleEvent - (Optional) Callback function that receives every event during execution (assistant messages, tool calls, etc.).
   * @param previousRun - (Optional) JSON state returned from a previous run() call.
   * @param projectFiles - (Optional) All the files in your project as a plain JavaScript object.
   * @param knowledgeFiles - (Optional) Knowledge files to inject into every run() call.
   * @param agentDefinitions - (Optional) Array of custom agent definitions.
   * @param customToolDefinitions - (Optional) Array of custom tool definitions that extend the agent's capabilities.
   * @param skillsDir - (Optional) Path to a directory containing skills to load.
   * @param maxAgentSteps - (Optional) Maximum number of steps the agent can take before stopping.
   * @param env - (Optional) Environment variables to pass to terminal commands executed by the agent.
   *
   * @returns A Promise that resolves to a RunState JSON object which you can pass to a subsequent run() call to continue the run. Use result.output to get the agent's output.
   */
  public async run(
    options: RunOptions & CodebuffClientOptions,
  ): Promise<RunState> {
    return run({ ...this.options, ...options })
  }

  /**
   * Local BYOK has no backend to check. Provided for upstream API
   * compatibility; always reports healthy.
   */
  public async checkConnection(): Promise<boolean> {
    return true
  }
}
