/**
 * Host diagnostics snapshot (feature gap #15 — /diagnostics panel).
 *
 * Data is gathered in the HOST process — the same process where the engine
 * runs and where terminal-tool children are spawned — so the numbers the user
 * sees are the ones that explain "why is it slow / what is it stuck on".
 *
 * ADR-12 redaction: the snapshot deliberately carries NO command text, NO
 * environment and NO keys. Terminal children are reported as bare
 * pid/PGID pairs (the SDK registry already withholds command text for the
 * same reason: reports get pasted into bug tickets).
 */

import { getActiveTerminalCommandProcesses } from '@codebuff/sdk'
import { getRunningTaskId } from './sessions/session-store'

export interface DiagnosticsSnapshot {
  product: string
  runtime: string
  platform: string
  architecture: string
  pid: number
  parentPid: number
  uptimeSeconds: number
  cpuUserMicros: number
  cpuSystemMicros: number
  memory: {
    rss: number
    heapTotal: number
    heapUsed: number
    external: number
    arrayBuffers?: number
  }
  /** In-flight `run_terminal_command` / `!command` subprocesses (pid only). */
  activeTools: Array<{ pid: number; processGroupId?: number }>
  /** Task id of the currently active run (null while idle). */
  runningTaskId: string | null
}

/** AnyBuff:getDiagnostics — current process snapshot. */
export function getDiagnostics(): DiagnosticsSnapshot {
  const cpu = process.cpuUsage()
  const mem = process.memoryUsage()
  return {
    product: 'AnyBuff',
    runtime: process.version,
    platform: process.platform,
    architecture: process.arch,
    pid: process.pid,
    parentPid: process.ppid,
    uptimeSeconds: process.uptime(),
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      ...(mem.arrayBuffers !== undefined ? { arrayBuffers: mem.arrayBuffers } : {}),
    },
    activeTools: getActiveTerminalCommandProcesses(),
    runningTaskId: getRunningTaskId(),
  }
}
