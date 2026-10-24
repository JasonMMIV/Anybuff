import { describe, expect, test } from 'bun:test'
import { formatTokenCount } from '../src/renderer/src/utils/format-tokens'

describe('formatTokenCount', () => {
  test('keeps small counts as-is', () => {
    expect(formatTokenCount(512)).toBe('512')
    expect(formatTokenCount(0)).toBe('0')
  })

  test('uses K with one decimal below 10K', () => {
    expect(formatTokenCount(8192)).toBe('8.2K')
    expect(formatTokenCount(128_000)).toBe('128K')
  })

  test('uses M with one decimal below 10M', () => {
    expect(formatTokenCount(1_048_576)).toBe('1.0M')
    expect(formatTokenCount(4_000_000)).toBe('4.0M')
  })

  test('promotes a rounded 999.999K to 1.0M instead of 1000K', () => {
    expect(formatTokenCount(999_999)).toBe('1.0M')
  })
})
