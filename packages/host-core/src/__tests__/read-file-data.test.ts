/**
 * readFileData channel tests (gap #14 floating preview): text round-trip,
 * image base64 classification, size caps and binary rejection.
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileData } from '../channels/handlers-files'

const dir = mkdtempSync(join(tmpdir(), 'host-core-read-file-data-'))

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

function write(name: string, content: Buffer | string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

describe('readFileData', () => {
  test('returns utf-8 text for a small text file', () => {
    const p = write('hello.txt', 'hello 世界\nsecond line')
    const res = readFileData(p)
    expect(res.ok).toBe(true)
    expect(res.kind).toBe('text')
    expect(res.mime).toBe('text/plain')
    expect(res.text).toBe('hello 世界\nsecond line')
    expect(res.size).toBe(Buffer.byteLength('hello 世界\nsecond line'))
    expect(res.base64).toBeUndefined()
  })

  test('classifies markdown/code files as text', () => {
    const p = write('README.md', '# Title\n\nbody')
    const res = readFileData(p)
    expect(res.ok).toBe(true)
    expect(res.kind).toBe('text')
    expect(res.text).toContain('# Title')
  })

  test('returns base64 for known image extensions', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d])
    const p = write('photo.png', bytes)
    const res = readFileData(p)
    expect(res.ok).toBe(true)
    expect(res.kind).toBe('image')
    expect(res.mime).toBe('image/png')
    expect(res.base64).toBe(bytes.toString('base64'))
    expect(res.text).toBeUndefined()
  })

  test('treats svg as an image', () => {
    const p = write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const res = readFileData(p)
    expect(res.ok).toBe(true)
    expect(res.kind).toBe('image')
    expect(res.mime).toBe('image/svg+xml')
  })

  test('rejects text files larger than 4MB with code too-large', () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61)
    const p = write('big.log', big)
    const res = readFileData(p)
    expect(res.ok).toBe(false)
    expect(res.code).toBe('too-large')
    expect(res.size).toBe(big.length)
  })

  test('rejects images larger than 8MB with code too-large', () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x00)
    const p = write('big.png', big)
    const res = readFileData(p)
    expect(res.ok).toBe(false)
    expect(res.code).toBe('too-large')
  })

  test('rejects unknown binaries with code binary', () => {
    const p = write('blob.bin', Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]))
    const res = readFileData(p)
    expect(res.ok).toBe(false)
    expect(res.code).toBe('binary')
  })

  test('reports missing paths', () => {
    const res = readFileData(join(dir, 'nope.txt'))
    expect(res.ok).toBe(false)
    expect(res.code).toBe('missing')
  })
})
