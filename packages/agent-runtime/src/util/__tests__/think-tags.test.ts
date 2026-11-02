import { describe, expect, it } from 'bun:test'

import { isThinkOnlyResponse, stripThinkTags } from '../think-tags'

// Tags are assembled from char codes: literal tag-like sequences in written
// tool content can be rewritten by the host editor pipeline.
const LT = String.fromCharCode(60)
const LF = String.fromCharCode(10)
const OPEN = (name: string) => `${LT}${name}>`
const CLOSE = (name: string) => `${LT}/${name}>`

describe('stripThinkTags', () => {
  it('strips <thinking> pairs, unclosed opens, and orphan closes', () => {
    expect(stripThinkTags(`${OPEN('thinking')}x${CLOSE('thinking')}`)).toBe('')
    expect(stripThinkTags(`${OPEN('thinking')}partial`)).toBe('')
    expect(stripThinkTags(CLOSE('thinking'))).toBe('')
  })

  it('strips mixed think / thinking scaffolding', () => {
    expect(
      stripThinkTags(
        `${OPEN('think')}a${CLOSE('think')}${OPEN('thinking')}b${CLOSE('thinking')}`,
      ),
    ).toBe('')
    expect(
      stripThinkTags(`${OPEN('thinking')}a${CLOSE('thinking')} Done.`),
    ).toBe('Done.')
  })

  it('strips paired think tags', () => {
    expect(
      stripThinkTags(`${OPEN('think')}plan the change${CLOSE('think')}`),
    ).toBe('')
    expect(
      stripThinkTags(
        `${OPEN('think')}a${CLOSE('think')}${LF}${LF}${OPEN('think')}b${CLOSE('think')}`,
      ),
    ).toBe('')
  })

  it('strips unclosed open think tags', () => {
    expect(stripThinkTags(`${OPEN('think')}partial thought`)).toBe('')
  })

  it('strips orphan close think tags', () => {
    expect(stripThinkTags(CLOSE('think'))).toBe('')
    expect(stripThinkTags(`${CLOSE('think')} `)).toBe('')
    expect(stripThinkTags(`   ${CLOSE('think')}${LF}`)).toBe('')
  })

  it('preserves non-think content around tags', () => {
    expect(
      stripThinkTags(
        `${OPEN('think')}x${CLOSE('think')}${LF}I will edit the file.`,
      ),
    ).toBe('I will edit the file.')
    expect(
      stripThinkTags(`${CLOSE('think')}${LF}Next I will spawn the editor.`),
    ).toBe('Next I will spawn the editor.')
  })
})

describe('isThinkOnlyResponse', () => {
  it('treats <thinking>-only responses as thinking', () => {
    expect(isThinkOnlyResponse(`${OPEN('thinking')}x${CLOSE('thinking')}`)).toBe(
      true,
    )
    expect(isThinkOnlyResponse(`${OPEN('thinking')}partial`)).toBe(true)
    expect(isThinkOnlyResponse(CLOSE('thinking'))).toBe(true)
    expect(
      isThinkOnlyResponse(`${OPEN('thinking')}x${CLOSE('thinking')} Done.`),
    ).toBe(false)
  })

  it('is false for empty / whitespace-only responses', () => {
    expect(isThinkOnlyResponse('')).toBe(false)
    expect(isThinkOnlyResponse(`   ${LF}`)).toBe(false)
  })

  it('is true for paired, unclosed, and orphan think scaffolding', () => {
    expect(
      isThinkOnlyResponse(`${OPEN('think')}reasoning${CLOSE('think')}`),
    ).toBe(true)
    expect(isThinkOnlyResponse(`${OPEN('think')}partial`)).toBe(true)
    expect(isThinkOnlyResponse(CLOSE('think'))).toBe(true)
    expect(isThinkOnlyResponse(`${CLOSE('think')} `)).toBe(true)
  })

  it('is false when there is real content besides think tags', () => {
    expect(isThinkOnlyResponse('Done.')).toBe(false)
    expect(
      isThinkOnlyResponse(`${OPEN('think')}x${CLOSE('think')} Done.`),
    ).toBe(false)
    expect(isThinkOnlyResponse(`${CLOSE('think')} Done.`)).toBe(false)
  })
})
