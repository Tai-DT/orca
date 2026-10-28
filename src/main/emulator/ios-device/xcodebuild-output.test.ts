import { describe, expect, it } from 'vitest'
import { extractXcodebuildErrorLines } from './xcodebuild-output'

describe('extractXcodebuildErrorLines', () => {
  it('pulls error and signing lines out of verbose output', () => {
    const output = [
      'note: Building targets in dependency order',
      '/tmp/wda/file.m:12:34: error: use of undeclared identifier x',
      'warning: something minor',
      'error: Provisioning profile "iOS Team" doesn\'t include the device',
      '** TEST FAILED **'
    ].join('\n')
    expect(extractXcodebuildErrorLines(output)).toEqual([
      '/tmp/wda/file.m:12:34: error: use of undeclared identifier x',
      'error: Provisioning profile "iOS Team" doesn\'t include the device',
      '** TEST FAILED **'
    ])
  })

  it('dedupes and caps the result', () => {
    const output = Array.from({ length: 12 }, (_, i) => `error: problem ${i % 3}`).join('\n')
    const lines = extractXcodebuildErrorLines(output, 2)
    expect(lines).toEqual(['error: problem 0', 'error: problem 1'])
  })

  it('returns an empty list for clean output', () => {
    expect(extractXcodebuildErrorLines('all good\nnote: fine')).toEqual([])
  })
})
