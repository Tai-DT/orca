import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess, PipedProcessSpawner } from '@orca/process-host/process-spec'
import { EmulatorError } from '../emulator-errors'
import { WdaClient, type WdaFetch } from './wda-client'
import { extractXcodebuildErrorLines } from './xcodebuild-output'
import type { WdaBuild } from './wda-build'

const SERVER_URL_PATTERN = /ServerURLHere->(https?:\/\/[^\s<]+)<-ServerURLHere/
const READY_POLL_INTERVAL_MS = 750
const READY_TIMEOUT_MS = 120_000
const SERVER_URL_TIMEOUT_MS = 120_000

export type WdaHandle = {
  deviceUdid: string
  baseUrl: string
  mjpegUrl: string
  client: WdaClient
  process: PipedChildProcess
}

export type WdaSessionDeps = {
  spawn?: PipedProcessSpawner
  fetchFn?: WdaFetch
  readyTimeoutMs?: number
}

const defaultWdaSpawn: PipedProcessSpawner = (spec) => spawnProcess(spec)

function mjpegUrlFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    url.port = '9100'
    url.pathname = '/'
    return url.toString()
  } catch {
    return `${baseUrl.replace(/:\d+.*$/, '')}:9100/`
  }
}

function waitForServerUrl(proc: PipedChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new EmulatorError(
          'emulator_wda_launch',
          'WebDriverAgent did not publish its server URL in time. ' +
            'Check that the iPhone is unlocked and Settings → Developer → Enable UI Automation is on.'
        )
      )
    }, timeoutMs)

    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString()
      const match = output.match(SERVER_URL_PATTERN)
      if (match) {
        cleanup()
        resolve(match[1])
      }
    }
    const onExit = (code: number | null): void => {
      cleanup()
      const errors = extractXcodebuildErrorLines(output)
      reject(
        new EmulatorError(
          'emulator_wda_launch',
          `xcodebuild test-without-building exited (${code ?? 'signal'}) before WebDriverAgent started: ${errors.length > 0 ? errors.join('\n') : tail(output)}`
        )
      )
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      proc.stdout?.off('data', onData)
      proc.stderr?.off('data', onData)
      proc.off('exit', onExit)
    }

    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.once('exit', onExit)
  })
}

async function waitUntilReady(client: WdaClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: string | undefined
  while (Date.now() < deadline) {
    try {
      const status = await client.status()
      if (status.ready !== false) {
        return
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS))
  }
  throw new EmulatorError(
    'emulator_wda_unreachable',
    `WebDriverAgent server never became ready.${lastError ? ` Last error: ${lastError}` : ''}`
  )
}

function spawnWdaRunner(
  spawn: PipedProcessSpawner,
  deviceUdid: string,
  xctestrunPath: string
): PipedChildProcess {
  let proc: PipedChildProcess
  try {
    proc = spawn({
      program: 'xcodebuild',
      args: [
        'test-without-building',
        '-xctestrun',
        xctestrunPath,
        '-destination',
        `platform=iOS,id=${deviceUdid}`,
        '-allowProvisioningUpdates'
      ],
      detached: true
    })
  } catch (error) {
    throw new EmulatorError(
      'emulator_wda_launch',
      `Cannot launch xcodebuild: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  proc.stderr?.on('error', () => undefined)
  proc.stdout?.on('error', () => undefined)
  return proc
}

export async function launchWda(
  deviceUdid: string,
  build: WdaBuild,
  deps: WdaSessionDeps = {}
): Promise<WdaHandle> {
  const spawn = deps.spawn ?? defaultWdaSpawn
  const proc = spawnWdaRunner(spawn, deviceUdid, build.xctestrunPath)

  let baseUrl: string
  try {
    baseUrl = await waitForServerUrl(proc, SERVER_URL_TIMEOUT_MS)
  } catch (error) {
    proc.kill('SIGTERM')
    throw error
  }

  const client = new WdaClient(baseUrl, undefined, deps.fetchFn)
  try {
    await waitUntilReady(client, deps.readyTimeoutMs ?? READY_TIMEOUT_MS)
    await client.createSession()
  } catch (error) {
    proc.kill('SIGTERM')
    throw error
  }
  return { deviceUdid, baseUrl, mjpegUrl: mjpegUrlFor(baseUrl), client, process: proc }
}

export async function stopWda(handle: WdaHandle): Promise<void> {
  await handle.client.deleteSession()
  const proc = handle.process
  if (proc.exitCode !== null || proc.killed) {
    return
  }
  proc.kill('SIGTERM')
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  if (!exited) {
    proc.kill('SIGKILL')
  }
}

function tail(output: string, lines = 8): string {
  const split = output.trim().split('\n').filter(Boolean)
  return split.slice(-lines).join('\n')
}
