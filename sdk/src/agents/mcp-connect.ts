import { disconnectMCPClient, getMCPClient, listMCPTools } from '@codebuff/common/mcp/client'

import type { MCPConfig } from '@codebuff/common/types/mcp'

/** One tool advertised by an MCP server (Test-connection surface). */
export interface McpToolInfo {
  name: string
  description?: string
}

/**
 * Connect to an MCP server config and list its advertised tools. Used by the
 * desktop Settings → MCP Tools "Test" buttons; this never feeds tool calls
 * into an agent run.
 *
 * @param config - MCP server config (stdio command or remote URL).
 * @param options.timeoutMs - Connect timeout in ms (default 20s).
 * @returns The server's advertised tools.
 */
export async function listMcpToolsForConfig(
  config: MCPConfig,
  options?: { timeoutMs?: number },
): Promise<McpToolInfo[]> {
  const timeoutMs = options?.timeoutMs ?? 20_000

  const run = (async () => {
    const clientId = await getMCPClient(config)
    try {
      const result = await listMCPTools(clientId)
      return result.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
      }))
    } finally {
      // One-shot probe: reap the spawned server process so repeated Test
      // clicks don't leak npx/uvx children (the runtime keeps clients alive
      // for real runs instead).
      await disconnectMCPClient(clientId)
    }
  })()

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out after ${Math.round(timeoutMs / 1000)}s while connecting to the MCP server. ` +
              'Check that the command/URL is correct, the package is installed, and required env vars are set.',
          ),
        ),
      timeoutMs,
    )
    // Don't keep the process alive waiting on a hung connection probe.
    const unref = (timer as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
  })

  return await Promise.race([run, timeout])
}
