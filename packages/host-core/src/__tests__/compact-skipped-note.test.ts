/**
 * A skipped `/compact` must be visible in the persisted transcript — a warn
 * log is not a user-visible outcome (context-compaction plan Phase 0).
 */

import { afterAll, describe, expect, test } from 'bun:test'

import {
  COMPACT_SKIPPED_ACTION,
  COMPACT_SKIPPED_MESSAGE,
} from '@codebuff/common/constants/compaction'

import { installHostEnv } from '../index'
import { normalizeEvent } from '../run/start-run'
import {
  applyEvent,
  getOrCreateSession,
  getSession,
} from '../sessions/session-store'
import { makeTestEnv, noEncryptionSecrets } from './helpers'

const env = makeTestEnv()

installHostEnv({
  paths: {
    dataDir: env.dataDir,
    appDataDir: env.dataDir,
    homeDir: env.dataDir,
  },
  secrets: noEncryptionSecrets(),
})

afterAll(() => {
  env.cleanup()
})

let seq = 0
function freshSession(): string {
  seq += 1
  const taskId = `compact-note-${seq}`
  getOrCreateSession('/tmp/compact-note-project', 'compact note task', taskId)
  return taskId
}

describe('context_compaction transcript notes', () => {
  test('normalizeEvent preserves the runtime message on the UiEvent', () => {
    expect(
      normalizeEvent({
        type: 'context_compaction',
        action: COMPACT_SKIPPED_ACTION,
        message: COMPACT_SKIPPED_MESSAGE,
      }),
    ).toMatchObject({
      type: 'context_compaction',
      action: COMPACT_SKIPPED_ACTION,
      message: COMPACT_SKIPPED_MESSAGE,
    })
  })

  test('a skipped /compact becomes a visible system message', () => {
    const taskId = freshSession()

    applyEvent(taskId, {
      type: 'context_compaction',
      action: COMPACT_SKIPPED_ACTION,
      message: COMPACT_SKIPPED_MESSAGE,
    } as unknown as Parameters<typeof applyEvent>[1])

    const transcript = getSession(taskId)?.transcript ?? []
    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toMatchObject({
      kind: 'system',
      text: COMPACT_SKIPPED_MESSAGE,
    })
  })

  test('mechanical compaction keeps the informational note', () => {
    const taskId = freshSession()

    applyEvent(taskId, {
      type: 'context_compaction',
      action: 'mechanical_trim',
    } as unknown as Parameters<typeof applyEvent>[1])

    const transcript = getSession(taskId)?.transcript ?? []
    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toMatchObject({
      kind: 'compaction',
      text: 'Older tool outputs were trimmed to fit the context window.',
    })
  })
})
