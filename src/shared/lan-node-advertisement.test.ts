import { describe, expect, it } from 'vitest'
import {
  decodeLanNodeTxt,
  encodeLanNodeTxt,
  LAN_NODE_ADVERTISEMENT_VERSION,
  type LanNodeAdvertisement
} from './lan-node-advertisement'

const baseAdvertisement: LanNodeAdvertisement = {
  v: LAN_NODE_ADVERTISEMENT_VERSION,
  name: 'win-test-box',
  platform: 'win32',
  arch: 'x64',
  orcaVersion: '1.4.240',
  runtimeId: 'rt-123',
  caps: ['desktop-control', 'adb']
}

describe('lan-node-advertisement', () => {
  it('round-trips an advertisement without a pairing payload', () => {
    const txt = encodeLanNodeTxt(baseAdvertisement)
    expect(decodeLanNodeTxt(txt)).toEqual(baseAdvertisement)
  })

  it('round-trips a chunked pairing payload across indexed keys', () => {
    const pair = 'p'.repeat(600)
    const txt = encodeLanNodeTxt({ ...baseAdvertisement, pair })
    const pairKeys = Object.keys(txt).filter((key) => key.startsWith('pair'))
    expect(pairKeys.length).toBeGreaterThan(1)
    for (const key of pairKeys) {
      expect(new TextEncoder().encode(txt[key]!).length).toBeLessThanOrEqual(249)
    }
    expect(decodeLanNodeTxt(txt)).toEqual({ ...baseAdvertisement, pair })
  })

  it('keeps multi-byte characters intact inside chunked values', () => {
    const pair = `${'é'.repeat(120)}${'中'.repeat(120)}`
    const txt = encodeLanNodeTxt({ ...baseAdvertisement, pair })
    expect(decodeLanNodeTxt(txt)).toEqual({ ...baseAdvertisement, pair })
  })

  it('rejects an oversized advertisement', () => {
    expect(() => encodeLanNodeTxt({ ...baseAdvertisement, pair: 'x'.repeat(1300) })).toThrow(
      /exceeds/
    )
  })

  it('keeps every encoded record within the 255-byte wire limit', () => {
    const txt = encodeLanNodeTxt({ ...baseAdvertisement, pair: 'p'.repeat(900) })
    for (const [key, value] of Object.entries(txt)) {
      expect(new TextEncoder().encode(`${key}=${value}`).length).toBeLessThanOrEqual(255)
    }
  })

  it('counts each record length prefix in the total TXT budget', () => {
    // Base fields plus a 5-chunk pair reach exactly 1300 raw bytes; the 12
    // length prefixes must still push the encoding over the wire budget.
    const advertisement = {
      ...baseAdvertisement,
      name: 'n'.repeat(120),
      pair: 'p'.repeat(1094)
    }
    expect(() => encodeLanNodeTxt(advertisement)).toThrow(/exceeds/)
  })

  it('rejects metadata that cannot fit one 255-byte record', () => {
    expect(() => encodeLanNodeTxt({ ...baseAdvertisement, name: '中'.repeat(90) })).toThrow(/255/)
  })

  it('returns null for a different version', () => {
    expect(
      decodeLanNodeTxt({ v: '2', name: 'x', platform: 'linux', arch: 'x64', ov: '1' })
    ).toBeNull()
  })

  it('returns null when a pair chunk is missing', () => {
    const txt = encodeLanNodeTxt({ ...baseAdvertisement, pair: 'p'.repeat(600) })
    delete txt.pair1
    expect(decodeLanNodeTxt(txt)).toBeNull()
  })

  it('returns null for an aliased pair chunk index', () => {
    const txt = encodeLanNodeTxt({ ...baseAdvertisement, pair: 'p'.repeat(600) })
    txt.pair01 = 'alias'
    expect(decodeLanNodeTxt(txt)).toBeNull()
  })

  it('returns null for a bare pair key alongside the chunks', () => {
    const txt = encodeLanNodeTxt({ ...baseAdvertisement, pair: 'p'.repeat(600) })
    txt.pair = 'not-a-chunk'
    expect(decodeLanNodeTxt(txt)).toBeNull()
  })

  it('returns null when an array value holds a non-string piece', () => {
    expect(
      decodeLanNodeTxt({ v: '1', name: ['x', 5], platform: 'linux', arch: 'x64', ov: '1' })
    ).toBeNull()
  })

  it('returns null when a pair chunk arrives as a non-string array piece', () => {
    const txt: Record<string, unknown> = encodeLanNodeTxt({
      ...baseAdvertisement,
      pair: 'p'.repeat(600)
    })
    txt.pair1 = ['p', 7]
    expect(decodeLanNodeTxt(txt)).toBeNull()
  })

  it('returns null when an inbound record exceeds the 255-byte budget', () => {
    expect(
      decodeLanNodeTxt({
        v: '1',
        name: 'x',
        platform: 'linux',
        arch: 'x64',
        ov: '1',
        junk: 'j'.repeat(300)
      })
    ).toBeNull()
  })

  it('returns null when inbound records exceed the total byte budget', () => {
    const txt: Record<string, unknown> = {
      v: '1',
      name: 'x',
      platform: 'linux',
      arch: 'x64',
      ov: '1'
    }
    for (let index = 0; index < 8; index += 1) {
      txt[`junk${index}`] = 'j'.repeat(200)
    }
    expect(decodeLanNodeTxt(txt)).toBeNull()
  })

  it('returns null for hostile nested record values', () => {
    expect(
      decodeLanNodeTxt({
        v: '1',
        name: { nested: true },
        platform: 'linux',
        arch: 'x64',
        ov: '1'
      })
    ).toBeNull()
  })

  it('returns null for malformed platform values', () => {
    expect(
      decodeLanNodeTxt({ v: '1', name: 'x', platform: 'amigaos', arch: 'x64', ov: '1' })
    ).toBeNull()
  })
})
