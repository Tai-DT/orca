import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWdaSigning, type SecurityCommandRunner } from './wda-signing'

const DEVICE = '00008110-000C3D2A119A201E'

function plistXml(devices: string[], team = 'TEAM123456'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>TeamIdentifier</key><array><string>${team}</string></array>
<key>ProvisionedDevices</key><array>${devices.map((d) => `<string>${d}</string>`).join('')}</array>
</dict></plist>`
}

const IDENTITIES =
  '  1) AAAA "Apple Development: Dev (TEAM123456)"\n  2) BBBB "Apple Development: Other (OTHER99999)"\n'

function fakeSecurity(cmsOutput: string): SecurityCommandRunner {
  return async (args) => {
    if (args[0] === 'find-identity') {
      return { code: 0, stdout: IDENTITIES, stderr: '' }
    }
    if (args[0] === 'cms') {
      return { code: 0, stdout: cmsOutput, stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected security call' }
  }
}

describe('resolveWdaSigning', () => {
  let dir = ''
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = ''
    }
  })

  it('finds a profile covering the device for a team with a signing cert', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wda-signing-'))
    writeFileSync(join(dir, 'a.mobileprovision'), 'profile-bytes')
    const signing = await resolveWdaSigning(DEVICE, {
      runSecurity: fakeSecurity(plistXml([DEVICE])),
      profilesDir: dir
    })
    expect(signing.teamId).toBe('TEAM123456')
    expect(signing.profilePath).toBe(join(dir, 'a.mobileprovision'))
    expect(signing.bundleIdentifier).toContain('WebDriverAgentRunner')
  })

  it('rejects when no profile covers the device UDID', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wda-signing-'))
    writeFileSync(join(dir, 'a.mobileprovision'), 'profile-bytes')
    await expect(
      resolveWdaSigning(DEVICE, {
        runSecurity: fakeSecurity(plistXml(['SOME-OTHER-UDID'])),
        profilesDir: dir
      })
    ).rejects.toMatchObject({ code: 'emulator_wda_signing' })
  })

  it('rejects when the matching profile team has no Apple Development cert', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wda-signing-'))
    writeFileSync(join(dir, 'a.mobileprovision'), 'profile-bytes')
    await expect(
      resolveWdaSigning(DEVICE, {
        runSecurity: fakeSecurity(plistXml([DEVICE], 'TEAM-WITHOUT-CERT')),
        profilesDir: dir
      })
    ).rejects.toMatchObject({ code: 'emulator_wda_signing' })
  })

  it('rejects with no profiles on disk', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wda-signing-'))
    await expect(
      resolveWdaSigning(DEVICE, { runSecurity: fakeSecurity(plistXml([DEVICE])), profilesDir: dir })
    ).rejects.toMatchObject({ code: 'emulator_wda_signing' })
  })

  it('rejects when security cannot list identities', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wda-signing-'))
    const runSecurity: SecurityCommandRunner = async () => ({
      code: 1,
      stdout: '',
      stderr: 'denied'
    })
    await expect(
      resolveWdaSigning(DEVICE, { runSecurity, profilesDir: dir })
    ).rejects.toMatchObject({ code: 'emulator_wda_signing' })
  })
})
