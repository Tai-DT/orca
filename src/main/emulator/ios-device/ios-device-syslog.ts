import { runProcess, spawnProcess } from '@orca/process-host'
import type { PipedChildProcess, PipedProcessSpawner } from '@orca/process-host/process-spec'
import { EmulatorError } from '../emulator-errors'

const TOOL_PROBE_TIMEOUT_MS = 10_000
const DEFAULT_CAPTURE_MS = 3_000
const MAX_CAPTURE_MS = 60_000
const DEFAULT_LINE_LIMIT = 500
const MAX_LINE_LIMIT = 10_000
const TOOL_MISSING_MESSAGE =
  'Reading the iOS device console needs libimobiledevice (`brew install libimobiledevice`) ' +
  'or pymobiledevice3 (`pipx install pymobiledevice3`).'

export type IosSyslogEntry = {
  timestamp?: string
  process?: string
  pid?: number
  level?: string
  message: string
}

export type IosSyslogOptions = {
  lines?: number
  filters?: readonly string[]
  durationMs?: number
}

export type IosDeviceLogDeps = {
  spawn?: PipedProcessSpawner
  probe?: (program: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  run?: IosLogCommandRunner
}

export type IosLogCommandRunner = (spec: {
  program: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}) => Promise<{ code: number | null; stdout: string; stderr: string }>

const defaultSpawn: PipedProcessSpawner = (spec) => spawnProcess(spec)
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

async function probeCommand(program: string): Promise<boolean> {
  try {
    const result = await runProcess({
      program,
      args: ['--help'],
      timeoutMs: TOOL_PROBE_TIMEOUT_MS
    })
    return result.code === 0 || result.stdout.length > 0 || result.stderr.length > 0
  } catch {
    return false
  }
}

// idevicesyslog is the fast native path; pymobiledevice3 covers setups without homebrew.
async function detectSyslogTool(
  probe: (program: string) => Promise<boolean>
): Promise<'idevicesyslog' | 'pymobiledevice3'> {
  if (await probe('idevicesyslog')) {
    return 'idevicesyslog'
  }
  if (await probe('pymobiledevice3')) {
    return 'pymobiledevice3'
  }
  throw new EmulatorError('emulator_unsupported', TOOL_MISSING_MESSAGE)
}

function syslogArgs(
  tool: 'idevicesyslog' | 'pymobiledevice3',
  udid: string,
  filters: readonly string[]
): { program: string; args: string[]; env?: NodeJS.ProcessEnv } {
  if (tool === 'idevicesyslog') {
    // -K (suppress kernel) disables -p process matching in libimobiledevice, so only
    // suppress kernel noise when no process filter is active.
    const args = ['-u', udid, '--no-colors']
    if (!filters.some((filter) => filter.startsWith('proc:'))) {
      args.push('-K')
    }
    for (const filter of filters) {
      if (filter.startsWith('proc:')) {
        args.push('-p', filter.slice('proc:'.length))
      } else {
        args.push('-m', filter)
      }
    }
    return { program: 'idevicesyslog', args }
  }
  return {
    program: 'pymobiledevice3',
    args: ['syslog', 'live'],
    env: { ...process.env, PYMOBILEDEVICE3_UDID: udid, PYMOBILEDEVICE3_NATIVE: '0' }
  }
}

// `Oct 28 10:26:50.373461 audiomxd(AudioToolbox)[117] <Debug>: message`
const SYSLOG_LINE =
  /^([A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2}\.\d+)\s+(\S+)\[(\d+)\]\s+<(\w+)>:\s*(.*)$/

export function parseIosSyslogLine(line: string): IosSyslogEntry | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('[connected:') || trimmed.startsWith('[disconnected')) {
    return null
  }
  const match = SYSLOG_LINE.exec(trimmed)
  if (!match) {
    return { message: trimmed }
  }
  return {
    timestamp: match[1],
    process: match[2],
    pid: Number.parseInt(match[3], 10),
    level: match[4],
    message: match[5].trim()
  }
}

// idevicesyslog only streams live output, so a bounded capture window stands in for
// Android's `logcat -d` buffer dump.
export async function captureIosDeviceSyslog(
  udid: string,
  options: IosSyslogOptions = {},
  deps: IosDeviceLogDeps = {}
): Promise<IosSyslogEntry[]> {
  const spawn = deps.spawn ?? defaultSpawn
  const probe = deps.probe ?? probeCommand
  const sleep = deps.sleep ?? defaultSleep
  const tool = await detectSyslogTool(probe)
  const filters = options.filters ?? []
  const lineLimit = Math.min(options.lines ?? DEFAULT_LINE_LIMIT, MAX_LINE_LIMIT)
  const captureMs = Math.min(options.durationMs ?? DEFAULT_CAPTURE_MS, MAX_CAPTURE_MS)

  const spec = syslogArgs(tool, udid, filters)
  let proc: PipedChildProcess
  try {
    proc = spawn({ program: spec.program, args: spec.args, env: spec.env })
  } catch (error) {
    throw new EmulatorError(
      'emulator_unsupported',
      `Cannot start ${tool}: ${error instanceof Error ? error.message : String(error)}. ${TOOL_MISSING_MESSAGE}`
    )
  }

  return new Promise<IosSyslogEntry[]>((resolve) => {
    let buffer = ''
    const entries: IosSyslogEntry[] = []
    let done = false
    const finish = (): void => {
      if (done) {
        return
      }
      done = true
      flush()
      if (proc.exitCode === null && !proc.killed) {
        proc.kill('SIGTERM')
      }
      resolve(entries)
    }
    const flush = (): void => {
      for (const line of buffer.split('\n')) {
        const entry = parseIosSyslogLine(line)
        if (entry) {
          entries.push(entry)
        }
      }
      buffer = ''
    }
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      const lastBreak = buffer.lastIndexOf('\n')
      if (lastBreak !== -1) {
        const complete = buffer.slice(0, lastBreak + 1)
        buffer = buffer.slice(lastBreak + 1)
        for (const line of complete.split('\n')) {
          const entry = parseIosSyslogLine(line)
          if (entry) {
            entries.push(entry)
          }
        }
      }
      if (entries.length >= lineLimit) {
        finish()
      }
    }
    proc.stdout?.on('data', onData)
    proc.stdout?.on('error', () => undefined)
    proc.stderr?.on('data', () => undefined)
    proc.stderr?.on('error', () => undefined)
    proc.once('exit', finish)
    void sleep(captureMs).then(finish)
  })
}

function pymobiledeviceSpec(
  udid: string,
  args: string[]
): {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
} {
  return {
    program: 'pymobiledevice3',
    args,
    env: { ...process.env, PYMOBILEDEVICE3_UDID: udid }
  }
}

const defaultRun: IosLogCommandRunner = async (spec) => {
  const result = await runProcess(spec)
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

async function runPymobiledevice(
  udid: string,
  args: string[],
  deps: IosDeviceLogDeps
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const probe = deps.probe ?? probeCommand
  if (!(await probe('pymobiledevice3'))) {
    throw new EmulatorError(
      'emulator_unsupported',
      `Crash reports need pymobiledevice3 (\`pipx install pymobiledevice3\`).`
    )
  }
  const spec = pymobiledeviceSpec(udid, args)
  return (deps.run ?? defaultRun)({ ...spec, timeoutMs: 120_000 })
}

// `crash flush` moves freshly generated reports into the shared CrashReports directory.
export async function listIosDeviceCrashReports(
  udid: string,
  deps: IosDeviceLogDeps = {}
): Promise<string[]> {
  await runPymobiledevice(udid, ['crash', 'flush'], deps).catch(() => undefined)
  const result = await runPymobiledevice(udid, ['crash', 'ls'], deps)
  if (result.code !== 0) {
    throw new EmulatorError(
      'emulator_error',
      `pymobiledevice3 crash ls failed: ${result.stderr.trim() || result.stdout.trim() || 'unknown error'}`
    )
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => line.endsWith('.ips') || line.endsWith('.ips.synced') || line.endsWith('.crash')
    )
}

export async function pullIosDeviceCrashReports(
  udid: string,
  destinationDir: string,
  match?: string,
  deps: IosDeviceLogDeps = {}
): Promise<{ directory: string; files: string[] }> {
  const args = ['crash', 'pull', '--remote-file', '/', destinationDir]
  if (match) {
    args.push('-m', match)
  }
  const result = await runPymobiledevice(udid, args, deps)
  if (result.code !== 0) {
    throw new EmulatorError(
      'emulator_error',
      `pymobiledevice3 crash pull failed: ${result.stderr.trim() || result.stdout.trim() || 'unknown error'}`
    )
  }
  // pm3 reports pulls as INFO lines on stderr ("INFO /remote.ips --> /local/remote.ips");
  // bare basenames may also appear on stdout.
  const text = `${result.stderr}\n${result.stdout}`
  const names = new Set<string>()
  for (const match of text.matchAll(/\/([^\s>]+\.(?:ips|crash)(?:\.synced)?)\s*-->/g)) {
    names.add(match[1])
  }
  for (const match of text.matchAll(/^([\w.+-]+\.(?:ips|crash)(?:\.synced)?)\s*$/gm)) {
    names.add(match[1])
  }
  return { directory: destinationDir, files: [...names] }
}
