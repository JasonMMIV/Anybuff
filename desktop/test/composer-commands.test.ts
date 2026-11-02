import { expect, test } from 'bun:test'

import { SLASH_COMMANDS } from '../src/renderer/src/utils/composer-commands'

test('the slash menu offers /compact exactly once', () => {
  const compact = SLASH_COMMANDS.filter((command) => command.id === 'compact')
  expect(compact).toHaveLength(1)
  expect(compact[0]?.label).toBe('compact')
})

test('slash command ids are unique', () => {
  expect(new Set(SLASH_COMMANDS.map((command) => command.id)).size).toBe(
    SLASH_COMMANDS.length,
  )
})
