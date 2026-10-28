import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, resolveOrcadWebClientRoot } from './orcad-command-arguments'

describe('parseArgs', () => {
  it('turns on advertisement for --advertise', () => {
    const options = parseArgs(['--advertise'])
    expect(options.advertise).toBe(true)
    expect(options.advertisePair).not.toBe(true)
  })

  it('turns on both advertisement flags for --advertise-pair', () => {
    expect(parseArgs(['--advertise-pair'])).toMatchObject({
      advertise: true,
      advertisePair: true
    })
  })

  it.each(['--no-pairing', '--mobile-pairing'])(
    'rejects --advertise-pair combined with %s',
    (flag) => {
      expect(() => parseArgs(['--advertise-pair', flag])).toThrow(/advertise-pair/)
    }
  )
})

describe('resolveOrcadWebClientRoot', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), 'orcad-web-root-'))
    roots.push(root)
    return root
  }

  it('serves a directory that holds the web client index', () => {
    const root = scratch()
    writeFileSync(join(root, 'web-index.html'), '<html></html>')
    expect(resolveOrcadWebClientRoot(root)).toBe(root)
  })

  it('refuses a directory without the index, saying so, rather than advertising a dead URL', () => {
    const warn = vi.fn()
    expect(resolveOrcadWebClientRoot(scratch(), warn)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('web-index.html'))
  })

  it('stays without a web client when none was handed over', () => {
    const warn = vi.fn()
    expect(resolveOrcadWebClientRoot(undefined, warn)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})
