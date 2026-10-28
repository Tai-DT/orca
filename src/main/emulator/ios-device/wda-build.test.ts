import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureWdaBuild, type WdaCommandRunner } from './wda-build'

const UDID = '00008110-000C3D2A119A201E'

function runnerThatBuilds(built: string[]): WdaCommandRunner {
  return async (spec) => {
    built.push(spec.args.join(' '))
    const derivedIndex = spec.args.indexOf('-derivedDataPath')
    if (spec.program === 'xcodebuild' && derivedIndex !== -1) {
      const products = join(spec.args[derivedIndex + 1], 'Build', 'Products')
      mkdirSync(products, { recursive: true })
      writeFileSync(join(products, 'WebDriverAgentRunner_iphoneos.xctestrun'), 'xctestrun')
    }
    return { code: 0, stdout: 'ok', stderr: '' }
  }
}

describe('ensureWdaBuild', () => {
  let dir = ''
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = ''
    }
  })

  function makeSource(): string {
    const src = join(dir, 'wda-src')
    mkdirSync(join(src, 'WebDriverAgent.xcodeproj'), { recursive: true })
    return src
  }

  it('builds with the resolved team and caches the xctestrun product', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wda-build-'))
    const built: string[] = []
    const build = await ensureWdaBuild(UDID, 'TEAM123456', {
      runCommand: runnerThatBuilds(built),
      sourceDir: makeSource(),
      buildRootDir: join(dir, 'builds')
    })
    expect(build.xctestrunPath).toContain('.xctestrun')
    expect(built[0]).toContain('build-for-testing')
    expect(built[0]).toContain('DEVELOPMENT_TEAM=TEAM123456')
    expect(built[0]).toContain(`platform=iOS,id=${UDID}`)
    expect(built[0]).toContain('CODE_SIGN_IDENTITY=Apple Development')
  })

  it('reuses a cached build instead of invoking xcodebuild again', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wda-build-'))
    const built: string[] = []
    const deps = {
      runCommand: runnerThatBuilds(built),
      sourceDir: makeSource(),
      buildRootDir: join(dir, 'builds')
    }
    const first = await ensureWdaBuild(UDID, 'TEAM123456', deps)
    const second = await ensureWdaBuild(UDID, 'TEAM123456', deps)
    expect(built).toHaveLength(1)
    expect(second.xctestrunPath).toBe(first.xctestrunPath)
  })

  it('classifies xcodebuild failures', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wda-build-'))
    const runCommand: WdaCommandRunner = async () => ({
      code: 65,
      stdout: '',
      stderr: 'error: signing requires a development team'
    })
    await expect(
      ensureWdaBuild(UDID, 'TEAM123456', {
        runCommand,
        sourceDir: makeSource(),
        buildRootDir: join(dir, 'builds')
      })
    ).rejects.toMatchObject({ code: 'emulator_wda_launch' })
  })

  it('rejects a configured source dir without the Xcode project', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wda-build-'))
    await expect(
      ensureWdaBuild(UDID, 'TEAM123456', {
        runCommand: runnerThatBuilds([]),
        sourceDir: join(dir, 'empty'),
        buildRootDir: join(dir, 'builds')
      })
    ).rejects.toMatchObject({ code: 'emulator_wda_launch' })
  })
})
