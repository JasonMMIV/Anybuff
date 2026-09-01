import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { listMcpToolsForConfig } from '@codebuff/sdk'

import { getSecret, loadSettings, saveSecret, saveSettings } from './settings'

import type { MCPConfig } from '@codebuff/sdk'

/**
 * MCP server management for the desktop app.
 *
 * Servers come from two sources:
 * - App-managed servers persisted in AnyBuff-app-settings.json (fully editable
 *   from Settings → MCP Tools).
 * - Servers discovered from `.agents/mcp.json` (project/parent/home), which
 *   are read-only here except for their enabled state and target agents.
 *
 * Inline env/header values are stored in the DPAPI vault (ADR-11) and replaced
 * in the record by {@link MCP_SECRET_PLACEHOLDER}. `$VAR` references are kept
 * plaintext and substituted by the MCP client at runtime.
 */

/** Sentinel stored in a record's env/headers slot for a DPAPI-encrypted value. */
export const MCP_SECRET_PLACEHOLDER = '__ANYBUFF_KEEP_SECRET__'

export type McpServerType = 'stdio' | 'http' | 'sse'

/** An app-managed MCP server persisted in AnyBuff-app-settings.json. */
export interface McpServerRecord {
  id: string
  name: string
  type: McpServerType
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  params?: Record<string, string>
  enabled: boolean
  /** Agent ids this server's tools are exposed to. */
  targetAgents: string[]
}

/** App-level override for servers discovered from mcp.json files. */
export interface McpServerOverride {
  enabled: boolean
  targetAgents: string[]
}

/** Row the renderer renders in Settings → MCP Tools. */
export interface McpServerView extends McpServerRecord {
  source: 'app' | 'file'
  /** For file servers: the mcp.json it was loaded from. */
  filePath?: string
  /** Whether any inline secret is stored in the DPAPI vault (UI hint). */
  hasSecrets: boolean
}

/** Draft sent from the renderer when adding/editing a server. */
export interface McpServerDraft {
  id?: string
  name: string
  type: McpServerType
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  params?: Record<string, string>
  enabled: boolean
  targetAgents: string[]
}

const DEFAULT_TARGET_AGENTS = ['base2', 'base2-plan']

function overrideKey(filePath: string, name: string): string {
  return `file:${filePath}:${name}`
}

function vaultKey(recordId: string, kind: 'env' | 'headers', key: string): string {
  return `mcp:${recordId}:${kind}:${key}`
}

let seq = 0
function newMcpServerId(): string {
  seq += 1
  return `mcp-${Date.now().toString(36)}-${seq.toString(36)}`
}

function hasRecordSecrets(rec: Pick<McpServerRecord, 'env' | 'headers'>): boolean {
  return (
    Object.values(rec.env ?? {}).some((v) => v === MCP_SECRET_PLACEHOLDER) ||
    Object.values(rec.headers ?? {}).some((v) => v === MCP_SECRET_PLACEHOLDER)
  )
}

function saveAppMcpServers(servers: McpServerRecord[]): void {
  const s = loadSettings()
  s.mcpServers = servers
  saveSettings(s)
}

/** Resolve sentinel placeholders to their decrypted vault values. */
function resolveRecordValues(
  recordId: string,
  kind: 'env' | 'headers',
  values: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values ?? {})) {
    out[k] = v === MCP_SECRET_PLACEHOLDER ? (getSecret(vaultKey(recordId, kind, k)) ?? '') : v
  }
  return out
}

/** Build the runtime MCPConfig for a record (decrypts stored secrets). */
export function recordToMCPConfig(
  record: Pick<McpServerRecord, 'id' | 'type' | 'command' | 'args' | 'url' | 'env' | 'headers' | 'params'>,
): MCPConfig {
  if (record.type === 'stdio') {
    return {
      type: 'stdio',
      command: record.command ?? '',
      args: record.args ?? [],
      env: resolveRecordValues(record.id, 'env', record.env),
    }
  }
  return {
    type: record.type,
    url: record.url ?? '',
    params: record.params ?? {},
    headers: resolveRecordValues(record.id, 'headers', record.headers),
  }
}

/**
 * When a sentinel-valued env/header row is renamed in the UI, the secret must
 * move with it: copy the old key's vault entry onto the new key before
 * {@link pruneRecordVault} deletes the old entry.
 */
function migrateRenamedSecrets(
  prev: Pick<McpServerRecord, 'env' | 'headers'>,
  draft: Pick<McpServerDraft, 'env' | 'headers'>,
  id: string,
): void {
  for (const kind of ['env', 'headers'] as const) {
    const prevValues = prev[kind] ?? {}
    const draftValues = draft[kind] ?? {}
    // Encrypted keys present before but gone from the draft (renamed or removed).
    const removedEncrypted = Object.keys(prevValues).filter(
      (k) => prevValues[k] === MCP_SECRET_PLACEHOLDER && !(k in draftValues),
    )
    if (removedEncrypted.length === 0) continue
    for (const [k, v] of Object.entries(draftValues)) {
      // Sentinel rows that lost their vault entry (renamed) need a value copied in.
      if (v !== MCP_SECRET_PLACEHOLDER) continue
      if (getSecret(vaultKey(id, kind, k)) !== undefined) continue
      const oldKey = removedEncrypted.shift()
      if (!oldKey) break
      const secret = getSecret(vaultKey(id, kind, oldKey))
      if (secret !== undefined) saveSecret(vaultKey(id, kind, k), secret)
    }
  }
}

/** Drop vault entries for env/header keys no longer present on a record. */
function pruneRecordVault(record: Pick<McpServerRecord, 'id' | 'env' | 'headers'>): void {
  const s = loadSettings()
  const envKeys = new Set(Object.keys(record.env ?? {}))
  const headerKeys = new Set(Object.keys(record.headers ?? {}))
  const prefix = `mcp:${record.id}:`
  for (const key of Object.keys(s.encryptedKeys ?? {})) {
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    const sep = rest.indexOf(':')
    if (sep < 0) continue
    const kind = rest.slice(0, sep)
    const name = rest.slice(sep + 1)
    const keep = kind === 'env' ? envKeys : kind === 'headers' ? headerKeys : new Set<string>()
    if (!keep.has(name)) saveSecret(key, '')
  }
}

export function saveMcpServer(draft: McpServerDraft): McpServerView {
  const s = loadSettings()
  const servers = s.mcpServers ?? []
  const isEdit = Boolean(draft.id) && servers.some((r) => r.id === draft.id)
  const id = isEdit ? (draft.id as string) : newMcpServerId()

  // Encrypt inline (non-$VAR) env/header values into the DPAPI vault and store
  // a sentinel in the record. $VAR references stay plaintext.
  for (const kind of ['env', 'headers'] as const) {
    const values = draft[kind]
    if (!values) continue
    for (const [k, v] of Object.entries(values)) {
      if (!v) {
        saveSecret(vaultKey(id, kind, k), '')
        delete values[k]
      } else if (v !== MCP_SECRET_PLACEHOLDER && !v.startsWith('$')) {
        saveSecret(vaultKey(id, kind, k), v)
        values[k] = MCP_SECRET_PLACEHOLDER
      }
    }
  }

  // Editing a server whose env/header key was renamed while holding a stored
  // secret: the sentinel moves to the new key but its vault entry still lives
  // under the old key. Migrate it before pruning, so the secret survives.
  if (isEdit) {
    const prev = servers.find((r) => r.id === id)
    if (prev) migrateRenamedSecrets(prev, draft, id)
  }

  const record: McpServerRecord = {
    id,
    name: draft.name,
    type: draft.type,
    command: draft.type === 'stdio' ? draft.command : undefined,
    args: draft.type === 'stdio' ? (draft.args ?? []) : undefined,
    url: draft.type !== 'stdio' ? draft.url : undefined,
    env: draft.type === 'stdio' ? (draft.env ?? {}) : undefined,
    headers: draft.type !== 'stdio' ? (draft.headers ?? {}) : undefined,
    params: draft.type !== 'stdio' ? (draft.params ?? {}) : undefined,
    enabled: draft.enabled,
    targetAgents: draft.targetAgents,
  }

  if (isEdit) {
    servers[servers.findIndex((r) => r.id === id)] = record
  } else {
    servers.push(record)
  }
  saveAppMcpServers(servers)
  // Remove vault entries for env/header keys that were renamed or deleted.
  pruneRecordVault(record)
  return { ...record, source: 'app', hasSecrets: hasRecordSecrets(record) }
}

export function deleteMcpServer(id: string): void {
  const s = loadSettings()
  const servers = s.mcpServers ?? []
  const rec = servers.find((r) => r.id === id)
  if (!rec) throw new Error('MCP server not found')
  pruneRecordVault({ id: rec.id, env: {}, headers: {} })
  saveAppMcpServers(servers.filter((r) => r.id !== id))
}

/** Update enabled state and/or target agents for an app or file server. */
export function updateMcpServerSettings(
  cwd: string | null,
  input: { id: string; enabled?: boolean; targetAgents?: string[] },
): McpServerView | null {
  const s = loadSettings()
  const servers = s.mcpServers ?? []
  const appIdx = servers.findIndex((r) => r.id === input.id)
  if (appIdx >= 0) {
    const rec: McpServerRecord = {
      ...servers[appIdx],
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.targetAgents !== undefined ? { targetAgents: input.targetAgents } : {}),
    }
    servers[appIdx] = rec
    saveAppMcpServers(servers)
    return { ...rec, source: 'app', hasSecrets: hasRecordSecrets(rec) }
  }

  // File-discovered server: the view id IS the opaque override key.
  s.mcpOverrides = s.mcpOverrides ?? {}
  const prev = s.mcpOverrides[input.id]
  s.mcpOverrides[input.id] = {
    enabled: input.enabled ?? prev?.enabled ?? true,
    targetAgents: input.targetAgents ?? prev?.targetAgents ?? [...DEFAULT_TARGET_AGENTS],
  }
  saveSettings(s)
  return getMcpServersView(cwd).find((v) => v.id === input.id) ?? null
}

interface ScannedFileServer {
  name: string
  filePath: string
  config: MCPConfig
}

/**
 * Scan `.agents/mcp.json` (project/parent/home) with raw $VAR refs intact.
 *
 * Each file is read individually and its servers tagged with the exact path
 * they came from (the SDK's merged `_sourceFilePath` only tracks the last file
 * loaded, which would mislabel project servers when a home file also exists
 * and break the override keys). Later files take precedence by name, matching
 * the SDK's merge order: home > parent > project.
 */
function scanMcpFileServers(cwd: string | null): ScannedFileServer[] {
  if (!cwd) return []
  const dirs = [
    join(cwd, '.agents'),
    join(cwd, '..', '.agents'),
    join(homedir(), '.agents'),
  ]
  const out: ScannedFileServer[] = []
  for (const dir of dirs) {
    const configPath = join(dir, 'mcp.json')
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      continue
    }
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers
    if (!servers || typeof servers !== 'object') continue
    for (const [name, config] of Object.entries(servers as Record<string, unknown>)) {
      if (!config || typeof config !== 'object') continue
      out.push({ name, filePath: configPath, config: config as MCPConfig })
    }
  }
  // Later files take precedence — keep the last entry per server name.
  const byName = new Map<string, ScannedFileServer>()
  for (const s of out) byName.set(s.name, s)
  return [...byName.values()]
}

/** Combined view (app-managed + mcp.json servers) for the Settings tab. */
export function getMcpServersView(cwd: string | null): McpServerView[] {
  const s = loadSettings()
  const appServers = s.mcpServers ?? []

  const views: McpServerView[] = appServers.map((rec) => ({
    ...rec,
    targetAgents: rec.targetAgents ?? [...DEFAULT_TARGET_AGENTS],
    source: 'app',
    hasSecrets: hasRecordSecrets(rec),
  }))

  for (const fs of scanMcpFileServers(cwd)) {
    if (appServers.some((a) => a.name === fs.name)) continue
    const override = s.mcpOverrides?.[overrideKey(fs.filePath, fs.name)]
    views.push({
      id: overrideKey(fs.filePath, fs.name),
      name: fs.name,
      type: fs.config.type === 'stdio' ? 'stdio' : fs.config.type,
      ...(fs.config.type === 'stdio'
        ? { command: fs.config.command, args: fs.config.args, env: fs.config.env }
        : { url: fs.config.url, params: fs.config.params, headers: fs.config.headers }),
      enabled: override?.enabled ?? true,
      targetAgents: override?.targetAgents ?? [...DEFAULT_TARGET_AGENTS],
      source: 'file',
      filePath: fs.filePath,
      hasSecrets: false,
    })
  }
  return views
}

export interface EnabledMcpServer {
  name: string
  config: MCPConfig
  targetAgents: string[]
}

/** Enabled servers (app-managed + mcp.json) with their target agents, for a run. */
export function getEnabledMcpServers(cwd: string): EnabledMcpServer[] {
  const s = loadSettings()
  const appServers = s.mcpServers ?? []
  const out: EnabledMcpServer[] = []

  for (const fs of scanMcpFileServers(cwd)) {
    if (appServers.some((a) => a.name === fs.name)) continue
    const override = s.mcpOverrides?.[overrideKey(fs.filePath, fs.name)]
    if (override?.enabled === false) continue
    out.push({
      name: fs.name,
      config: fs.config,
      targetAgents: override?.targetAgents ?? [...DEFAULT_TARGET_AGENTS],
    })
  }
  for (const rec of appServers) {
    if (!rec.enabled) continue
    out.push({
      name: rec.name,
      config: recordToMCPConfig(rec),
      targetAgents: rec.targetAgents ?? [...DEFAULT_TARGET_AGENTS],
    })
  }
  return out
}

/** Mount enabled servers onto their target agents within the merged definitions. */
export function applyMcpServersToAgents(
  definitions: Record<string, Record<string, unknown>>,
  servers: EnabledMcpServer[],
): void {
  for (const server of servers) {
    for (const agentId of server.targetAgents) {
      const def = definitions[agentId]
      if (!def) continue
      const existing = (def.mcpServers as Record<string, unknown> | undefined) ?? {}
      definitions[agentId] = {
        ...def,
        mcpServers: {
          ...existing,
          [server.name]: server.config,
        },
      }
    }
  }
}

/** Connect to a server (as drafted in the UI) and list its tools. */
export async function testMcpServer(
  draft: McpServerDraft,
): Promise<{ ok: true; tools: { name: string; description?: string }[] } | { ok: false; error: string }> {
  try {
    const config = recordToMCPConfig({
      id: draft.id ?? 'draft',
      type: draft.type,
      command: draft.command,
      args: draft.args,
      url: draft.url,
      env: draft.env,
      headers: draft.headers,
      params: draft.params,
    })
    const tools = await listMcpToolsForConfig(config)
    return { ok: true, tools }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
