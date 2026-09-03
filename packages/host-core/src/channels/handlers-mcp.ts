/**
 * MCP-server handlers (AnyBuff:listMcpServers / saveMcpServer / deleteMcpServer /
 * updateMcpServerSettings / testMcpServer).
 *
 * Ported verbatim from the Electron shell's registerIpc().
 */

import {
  getMcpServersView,
  saveMcpServer as saveMcpServerFn,
  deleteMcpServer as deleteMcpServerFn,
  updateMcpServerSettings as updateMcpServerSettingsFn,
  testMcpServer as testMcpServerFn,
  type McpServerDraft,
} from '../mcp/mcp-settings'

/** AnyBuff:listMcpServers */
export function listMcpServers(cwd: string | null): unknown {
  return getMcpServersView(cwd)
}

/** AnyBuff:saveMcpServer */
export function saveMcpServer(payload: McpServerDraft): unknown {
  try {
    const server = saveMcpServerFn(payload)
    return { ok: true, server }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** AnyBuff:deleteMcpServer */
export function deleteMcpServer(payload: { id: string }): unknown {
  try {
    deleteMcpServerFn(payload.id)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** AnyBuff:updateMcpServerSettings */
export function updateMcpServerSettings(payload: {
  cwd: string | null
  id: string
  enabled?: boolean
  targetAgents?: string[]
}): unknown {
  try {
    const server = updateMcpServerSettingsFn(payload.cwd, {
      id: payload.id,
      enabled: payload.enabled,
      targetAgents: payload.targetAgents,
    })
    return { ok: true, server }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** AnyBuff:testMcpServer */
export async function testMcpServer(payload: { record: McpServerDraft }): Promise<unknown> {
  return await testMcpServerFn(payload.record)
}
