import { describe, expect, test } from 'bun:test'
import { resolveConfiguredAgentModelConfig } from '../../provider-config'
import { getRunOverrides, withRunOverrides } from '../run-overrides'

function loadedConfig(config: Record<string, unknown>) {
  return { config } as Parameters<typeof resolveConfiguredAgentModelConfig>[0]['loadedConfig']
}

describe('run overrides', () => {
  test('are scoped to the async run and disappear afterwards', async () => {
    expect(getRunOverrides()).toBeUndefined()
    await withRunOverrides({ defaultModel: 'task/model', defaultReasoningEffort: 'high' }, async () => {
      expect(getRunOverrides()).toEqual({
        defaultModel: 'task/model',
        defaultReasoningEffort: 'high',
      })
      await Promise.resolve()
      expect(getRunOverrides()?.defaultModel).toBe('task/model')
    })
    expect(getRunOverrides()).toBeUndefined()
  })

  test('keep two concurrent runs isolated', async () => {
    const seen: string[] = []
    await Promise.all([
      withRunOverrides({ defaultModel: 'task/a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        seen.push(getRunOverrides()?.defaultModel ?? 'missing')
      }),
      withRunOverrides({ defaultModel: 'task/b' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        seen.push(getRunOverrides()?.defaultModel ?? 'missing')
      }),
    ])
    expect(seen.sort()).toEqual(['task/a', 'task/b'])
  })

  test('replace the configured default model and effort', async () => {
    const loaded = loadedConfig({
      defaultModel: 'global/model',
      defaultReasoningEffort: 'low',
      agents: {},
      agentReasoningEfforts: {},
    })

    await withRunOverrides({ defaultModel: 'task/model', defaultReasoningEffort: 'high' }, async () => {
      expect(resolveConfiguredAgentModelConfig({ agentId: 'base2', loadedConfig: loaded })).toEqual({
        model: 'task/model',
        reasoningEffort: 'high',
      })
    })
  })

  test('do not override an explicit agent route', async () => {
    const loaded = loadedConfig({
      defaultModel: 'global/model',
      defaultReasoningEffort: 'low',
      agents: { base2: 'routed/model' },
      agentReasoningEfforts: { base2: 'medium' },
    })

    await withRunOverrides({ defaultModel: 'task/model', defaultReasoningEffort: 'high' }, async () => {
      expect(resolveConfiguredAgentModelConfig({ agentId: 'base2', loadedConfig: loaded })).toEqual({
        model: 'routed/model',
        reasoningEffort: 'medium',
      })
    })
  })
})
