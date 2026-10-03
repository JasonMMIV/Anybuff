/**
 * Tool-card status correlation (session store).
 *
 * Every tool_call/tool_result pair carries a stable toolCallId, and the store
 * must bind each result to its own card — even when a turn batches several
 * tool calls, so all the cards exist before the first result arrives. The old
 * single-slot "most recently started card" index mis-bound batched results:
 * earlier cards sat on "running" forever and the last card showed the wrong
 * output. This also covers the run-end / read-time sweeps that close out cards
 * left running by Stop, crashes, or lost results.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { installHostEnv } from '../index'
import {
  applyEvent,
  dropSession,
  finishRun,
  getOrCreateSession,
  getSession,
  getSessionSnapshot,
  markRunning
} from '../sessions/session-store'
import { saveTaskTranscript } from '../settings/settings'
import { noEncryptionSecrets } from './helpers'

const dataDir = mkdtempSync(join(tmpdir(), 'host-core-tool-corr-'))
process.env.ANYBUFF_PROVIDER_CONFIG = join(dataDir, 'anybuff.json')

beforeAll(() => {
  installHostEnv({
    paths: { dataDir, appDataDir: dataDir, homeDir: dataDir },
    secrets: noEncryptionSecrets()
  })
})

afterAll(() => {
  try {
    require('fs').rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

let seq = 0
function freshSession(): string {
  seq += 1
  const taskId = `tool-corr-${seq}`
  getOrCreateSession('/tmp/tool-corr-project', 'tool correlation task', taskId)
  return taskId
}

function toolAt(taskId: string, index: number) {
  const entry = getSession(taskId)
  const item = entry?.transcript[index]
  if (!item || item.kind !== 'tool' || !item.tool) {
    throw new Error(`expected a tool item at index ${index} of ${taskId}`)
  }
  return item.tool
}

describe('tool_result ↔ tool_call correlation', () => {
  test('a batched pair resolves both cards by toolCallId (results in order)', () => {
    const taskId = freshSession()
    applyEvent(taskId, { type: 'tool_call', toolName: 'glob', toolCallId: 'call-a' })
    applyEvent(taskId, { type: 'tool_call', toolName: 'run_terminal_command', toolCallId: 'call-b' })
    applyEvent(taskId, { type: 'tool_result', toolName: 'glob', toolCallId: 'call-a', message: 'A-OUT' })
    applyEvent(taskId, { type: 'tool_result', toolName: 'run_terminal_command', toolCallId: 'call-b', message: 'B-OUT' })

    expect(toolAt(taskId, 0).status).toBe('done')
    expect(toolAt(taskId, 0).detail).toBe('A-OUT')
    expect(toolAt(taskId, 1).status).toBe('done')
    expect(toolAt(taskId, 1).detail).toBe('B-OUT')
  })

  test('results arriving out of order still bind to their own cards', () => {
    const taskId = freshSession()
    applyEvent(taskId, { type: 'tool_call', toolName: 'run_terminal_command', toolCallId: 'call-a' })
    applyEvent(taskId, { type: 'tool_call', toolName: 'run_terminal_command', toolCallId: 'call-b' })
    applyEvent(taskId, { type: 'tool_result', toolName: 'run_terminal_command', toolCallId: 'call-b', message: 'B-OUT' })
    applyEvent(taskId, { type: 'tool_result', toolName: 'run_terminal_command', toolCallId: 'call-a', message: 'A-OUT' })

    expect(toolAt(taskId, 0).status).toBe('done')
    expect(toolAt(taskId, 0).detail).toBe('A-OUT')
    expect(toolAt(taskId, 1).status).toBe('done')
    expect(toolAt(taskId, 1).detail).toBe('B-OUT')
  })

  test('a three-way batch leaves no card running', () => {
    const taskId = freshSession()
    applyEvent(taskId, { type: 'tool_call', toolName: 'read_url', toolCallId: 'c1' })
    applyEvent(taskId, { type: 'tool_call', toolName: 'read_url', toolCallId: 'c2' })
    applyEvent(taskId, { type: 'tool_call', toolName: 'read_url', toolCallId: 'c3' })
    applyEvent(taskId, { type: 'tool_result', toolName: 'read_url', toolCallId: 'c1', message: 'OUT-1' })
    applyEvent(taskId, { type: 'tool_result', toolName: 'read_url', toolCallId: 'c3', message: 'OUT-3' })
    applyEvent(taskId, { type: 'tool_result', toolName: 'read_url', toolCallId: 'c2', message: 'OUT-2' })

    for (const [i, out] of ['OUT-1', 'OUT-2', 'OUT-3'].entries()) {
      expect(toolAt(taskId, i).status).toBe('done')
      expect(toolAt(taskId, i).detail).toBe(out)
    }
  })

  test('an unmatched toolCallId is a no-op — never guesses', () => {
    const taskId = freshSession()
    applyEvent(taskId, { type: 'tool_call', toolName: 'glob', toolCallId: 'call-a' })
    applyEvent(taskId, { type: 'tool_result', toolName: 'glob', toolCallId: 'call-other', message: 'WRONG' })

    expect(toolAt(taskId, 0).status).toBe('running')
    expect(toolAt(taskId, 0).detail).toBeUndefined()
  })

  test('legacy id-less results fall back to the last running card of the same tool', () => {
    const taskId = freshSession()
    applyEvent(taskId, { type: 'tool_call', toolName: 'read_url', toolCallId: 'call-x' })
    applyEvent(taskId, { type: 'tool_call', toolName: 'read_url', toolCallId: 'call-y' })
    applyEvent(taskId, { type: 'tool_result', toolName: 'read_url', message: 'LEGACY-OUT' })

    expect(toolAt(taskId, 0).status).toBe('running')
    expect(toolAt(taskId, 1).status).toBe('done')
    expect(toolAt(taskId, 1).detail).toBe('LEGACY-OUT')
  })

  test('an id-less result with no toolName still matches its default-named card', () => {
    const taskId = freshSession()
    applyEvent(taskId, { type: 'tool_call' }) // toolName defaults to 'tool'
    applyEvent(taskId, { type: 'tool_result', message: 'OUT' })

    expect(toolAt(taskId, 0).status).toBe('done')
    expect(toolAt(taskId, 0).detail).toBe('OUT')
  })
})

describe('running cards are swept when their run is over', () => {
  test('finishRun demotes leftovers: done on success, interrupted on stop', () => {
    const ok = freshSession()
    applyEvent(ok, { type: 'tool_call', toolName: 'glob', toolCallId: 'c1' })
    finishRun(ok, null, { interrupted: false })
    expect(toolAt(ok, 0).status).toBe('done')

    const stopped = freshSession()
    applyEvent(stopped, { type: 'tool_call', toolName: 'run_terminal_command', toolCallId: 'c2' })
    finishRun(stopped, null, { interrupted: true })
    expect(toolAt(stopped, 0).status).toBe('interrupted')
  })

  test('an idle in-memory session is demoted at snapshot time', () => {
    const taskId = freshSession()
    applyEvent(taskId, { type: 'tool_call', toolName: 'glob', toolCallId: 'c1' })

    const snap = getSessionSnapshot(taskId)
    expect(snap.exists).toBe(true)
    expect(snap.transcript[0]?.tool?.status).toBe('done')
  })

  test('a running session keeps its cards live until the run ends', () => {
    const taskId = freshSession()
    applyEvent(taskId, { type: 'tool_call', toolName: 'glob', toolCallId: 'c1' })
    markRunning(taskId)

    expect(getSessionSnapshot(taskId).transcript[0]?.tool?.status).toBe('running')

    finishRun(taskId, null, { interrupted: true })
    expect(toolAt(taskId, 0).status).toBe('interrupted')
  })

  test('a disk-only transcript is demoted at read time', () => {
    const taskId = freshSession()
    saveTaskTranscript(taskId, [
      {
        kind: 'tool',
        tool: { toolName: 'glob', status: 'running', toolCallId: 'legacy-call' },
        createdAt: Date.now()
      }
    ])
    expect(dropSession(taskId)).toBe(true)

    const snap = getSessionSnapshot(taskId)
    expect(snap.exists).toBe(true)
    expect(snap.transcript[0]?.tool?.status).toBe('done')
  })
})
