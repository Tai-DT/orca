import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { EmulatorError } from '../emulator-errors'
import { extractXcodebuildErrorLines } from './xcodebuild-output'
import { getAppEnvironment } from '../../../shared/app-environment'

const WDA_REPO_URL = 'https://github.com/appium/WebDriverAgent'
const WDA_REPO_REF = process.env.ORCA_WDA_REPO_REF ?? 'master'
const WDA_BUNDLE_IDENTIFIER = 'com.orca.WebDriverAgentRunner'
const BUILD_TIMEOUT_MS = 20 * 60_000

export type WdaCommandRunner = (spec: {
  program: string
  args: readonly string[]
  cwd?: string
  input?: string
  timeoutMs?: number | null
}) => Promise<{ code: number | null; stdout: string; stderr: string }>

const defaultRunner: WdaCommandRunner = async (spec) => {
  const result = await runProcess(spec)
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

export type WdaBuildDeps = {
  runCommand?: WdaCommandRunner
  sourceDir?: string
  buildRootDir?: string
}

export type WdaBuild = {
  xctestrunPath: string
  bundleIdentifier: string
  cacheKey: string
}

function wdaBuildRootDir(): string {
  return join(getAppEnvironment().getPath('userData'), 'wda-builds')
}

async function ensureWdaSource(deps: WdaBuildDeps, runCommand: WdaCommandRunner): Promise<string> {
  const configured = deps.sourceDir ?? process.env.ORCA_WDA_SOURCE_DIR
  if (configured) {
    if (!existsSync(join(configured, 'WebDriverAgent.xcodeproj'))) {
      throw new EmulatorError(
        'emulator_wda_launch',
        `ORCA_WDA_SOURCE_DIR '${configured}' does not contain WebDriverAgent.xcodeproj.`
      )
    }
    return configured
  }
  const cacheDir = join(wdaBuildRootDir(), 'source', sanitizeRef(WDA_REPO_REF))
  if (existsSync(join(cacheDir, 'WebDriverAgent.xcodeproj'))) {
    return cacheDir
  }
  await mkdir(cacheDir, { recursive: true })
  const clone = await runCommand({
    program: 'git',
    args: ['clone', '--depth', '1', '--branch', WDA_REPO_REF, WDA_REPO_URL, cacheDir],
    timeoutMs: BUILD_TIMEOUT_MS
  })
  if (clone.code !== 0) {
    throw new EmulatorError(
      'emulator_wda_launch',
      `Cannot download WebDriverAgent (${WDA_REPO_REF}): ${tail(clone.stderr)}`
    )
  }
  if (!existsSync(join(cacheDir, 'WebDriverAgent.xcodeproj'))) {
    throw new EmulatorError(
      'emulator_wda_launch',
      'WebDriverAgent checkout is missing its Xcode project.'
    )
  }
  return cacheDir
}

function sanitizeRef(ref: string): string {
  return ref.replace(/[^A-Za-z0-9._-]/g, '_')
}

async function findXctestrun(productsDir: string): Promise<string | null> {
  if (!existsSync(productsDir)) {
    return null
  }
  for (const entry of await readdir(productsDir)) {
    if (entry.endsWith('.xctestrun')) {
      return join(productsDir, entry)
    }
  }
  return null
}

function buildCacheKey(deviceUdid: string, teamId: string): string {
  return createHash('sha256')
    .update(`${deviceUdid}:${teamId}:${WDA_REPO_REF}`)
    .digest('hex')
    .slice(0, 16)
}

export async function ensureWdaBuild(
  deviceUdid: string,
  teamId: string,
  deps: WdaBuildDeps = {}
): Promise<WdaBuild> {
  const runCommand = deps.runCommand ?? defaultRunner
  const cacheKey = buildCacheKey(deviceUdid, teamId)
  const derivedData = join(deps.buildRootDir ?? wdaBuildRootDir(), 'derived', cacheKey)
  const productsDir = join(derivedData, 'Build', 'Products')

  const cached = await findXctestrun(productsDir)
  if (cached) {
    return { xctestrunPath: cached, bundleIdentifier: WDA_BUNDLE_IDENTIFIER, cacheKey }
  }

  const sourceDir = await ensureWdaSource(deps, runCommand)
  const result = await runCommand({
    program: 'xcodebuild',
    args: [
      '-project',
      join(sourceDir, 'WebDriverAgent.xcodeproj'),
      '-scheme',
      'WebDriverAgentRunner',
      '-destination',
      `platform=iOS,id=${deviceUdid}`,
      '-derivedDataPath',
      derivedData,
      'CODE_SIGN_STYLE=Automatic',
      `DEVELOPMENT_TEAM=${teamId}`,
      'CODE_SIGN_IDENTITY=Apple Development',
      `PRODUCT_BUNDLE_IDENTIFIER=${WDA_BUNDLE_IDENTIFIER}`,
      'build-for-testing'
    ],
    timeoutMs: BUILD_TIMEOUT_MS
  })
  if (result.code !== 0) {
    const output = `${result.stderr}\n${result.stdout}`
    const errors = extractXcodebuildErrorLines(output)
    throw new EmulatorError(
      'emulator_wda_launch',
      `WebDriverAgent build-for-testing failed: ${errors.length > 0 ? errors.join('\n') : tail(output)}`
    )
  }
  const xctestrun = await findXctestrun(productsDir)
  if (!xctestrun) {
    throw new EmulatorError(
      'emulator_wda_launch',
      'xcodebuild succeeded but produced no .xctestrun product.'
    )
  }
  await writeFile(
    join(derivedData, 'orca-wda-build.json'),
    JSON.stringify({ deviceUdid, teamId, sourceRef: WDA_REPO_REF, xctestrunPath: xctestrun })
  )
  return { xctestrunPath: xctestrun, bundleIdentifier: WDA_BUNDLE_IDENTIFIER, cacheKey }
}

function tail(output: string, lines = 12): string {
  const split = output.trim().split('\n')
  return split.slice(-lines).join('\n')
}
