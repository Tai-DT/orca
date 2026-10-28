import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import { EmulatorError } from '../emulator-errors'

export const WDA_BUNDLE_IDENTIFIER = 'com.orca.WebDriverAgentRunner'

const COMMAND_TIMEOUT_MS = 30_000

const stringArraySchema = z.array(z.string())

export type WdaSigning = {
  teamId: string
  profilePath: string
  bundleIdentifier: string
}

export type WdaSigningDeps = {
  runSecurity?: typeof defaultSecurityCommand
  profilesDir?: string
}

export type SecurityCommandRunner = (
  args: readonly string[]
) => Promise<{ code: number; stdout: string; stderr: string }>

const defaultSecurityCommand: SecurityCommandRunner = async (args) => {
  const result = await runProcess({ program: 'security', args, timeoutMs: COMMAND_TIMEOUT_MS })
  return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr }
}

function parseSigningTeams(identityOutput: string): Set<string> {
  // Accept any Apple codesigning identity (Development, Distribution, legacy iPhone Developer):
  // the trailing parenthesized code in the certificate CN is the team ID.
  const teams = new Set<string>()
  for (const line of identityOutput.split('\n')) {
    const match = line.match(/"\s*([^"]*)\(([A-Z0-9]{10})\)\s*"/)
    if (match && /Apple|iPhone|Developer|Distribution/i.test(match[1])) {
      teams.add(match[2])
    }
  }
  return teams
}

const provisioningProfilesDir = () =>
  join(homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles')

async function extractPlistStringArray(plistXml: string, key: string): Promise<string[]> {
  const json = await runProcess({
    program: 'plutil',
    args: ['-extract', key, 'json', '-o', '-', '--', '-'],
    input: plistXml,
    timeoutMs: COMMAND_TIMEOUT_MS
  })
  if (json.code !== 0) {
    return []
  }
  try {
    const parsed = stringArraySchema.safeParse(JSON.parse(json.stdout))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

type ProvisioningProfileInfo = {
  TeamIdentifier: string[]
  ProvisionedDevices: string[]
}

async function readProvisioningProfile(
  runSecurity: SecurityCommandRunner,
  path: string
): Promise<ProvisioningProfileInfo | null> {
  const cms = await runSecurity(['cms', '-D', '-i', path])
  const trimmed = cms.stdout.trim()
  if (cms.code !== 0 || !trimmed.startsWith('<?xml')) {
    return null
  }
  // `plutil -extract` on just the needed keys avoids <data> blobs that break whole-plist JSON output.
  const [TeamIdentifier, ProvisionedDevices] = await Promise.all([
    extractPlistStringArray(trimmed, 'TeamIdentifier'),
    extractPlistStringArray(trimmed, 'ProvisionedDevices')
  ])
  return { TeamIdentifier, ProvisionedDevices }
}

export async function resolveWdaSigning(
  deviceUdid: string,
  deps: WdaSigningDeps = {}
): Promise<WdaSigning> {
  const runSecurity = deps.runSecurity ?? defaultSecurityCommand
  const profilesDir = deps.profilesDir ?? provisioningProfilesDir()

  const identities = await runSecurity(['find-identity', '-v', '-p', 'codesigning'])
  if (identities.code !== 0) {
    throw new EmulatorError(
      'emulator_wda_signing',
      'Cannot list signing identities. Open Xcode once so Apple certificates are installed.'
    )
  }
  const certTeams = parseSigningTeams(identities.stdout)

  let profiles: string[] = []
  try {
    profiles = (await readdir(profilesDir)).filter((name) => name.endsWith('.mobileprovision'))
  } catch {
    profiles = []
  }

  const candidates: { teamId: string; path: string }[] = []
  for (const file of profiles) {
    const path = join(profilesDir, file)
    const profile = await readProvisioningProfile(runSecurity, path)
    if (!profile || !profile.ProvisionedDevices.includes(deviceUdid)) {
      continue
    }
    const teamId = profile.TeamIdentifier[0]
    if (teamId && certTeams.has(teamId)) {
      candidates.push({ teamId, path })
    }
  }

  if (candidates.length === 0) {
    throw new EmulatorError(
      'emulator_wda_signing',
      `No Apple Development team with a provisioning profile covering device ${deviceUdid}. ` +
        'In Xcode: Settings → Accounts → add the Apple ID used to develop on this iPhone, ' +
        'then build any app to the device once so Xcode creates a provisioning profile.'
    )
  }
  const chosen = candidates[0]
  return {
    teamId: chosen.teamId,
    profilePath: chosen.path,
    bundleIdentifier: WDA_BUNDLE_IDENTIFIER
  }
}
