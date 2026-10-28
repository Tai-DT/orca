import { EmulatorError } from '../emulator-errors'
import type { EmulatorSessionInfo } from '../emulator-types'
import type { PhysicalIosDevice } from './ios-device-inventory'
import { resolveWdaSigning, type WdaSigningDeps } from './wda-signing'
import { ensureWdaBuild, type WdaBuildDeps } from './wda-build'
import { launchWda, stopWda, type WdaHandle, type WdaSessionDeps } from './wda-session'
import type { WdaWindowSize } from './wda-client'

export type WdaDeviceSessionDeps = {
  signing?: WdaSigningDeps
  build?: WdaBuildDeps
  session?: WdaSessionDeps
}

// Owns live WebDriverAgent runners keyed by hardware UDID.
export class WdaDeviceSessions {
  private readonly sessions = new Map<string, WdaHandle>()
  private readonly windowSizes = new Map<string, WdaWindowSize>()

  constructor(private readonly deps: WdaDeviceSessionDeps = {}) {}

  async start(device: PhysicalIosDevice): Promise<EmulatorSessionInfo> {
    const existing = this.sessions.get(device.udid)
    if (existing && isAlive(existing)) {
      try {
        await existing.client.status()
        return toSessionInfo(device, existing)
      } catch {
        await stopWda(existing).catch(() => undefined)
        this.sessions.delete(device.udid)
      }
    }
    const signing = await resolveWdaSigning(device.udid, this.deps.signing)
    const build = await ensureWdaBuild(device.udid, signing.teamId, this.deps.build)
    const handle = await launchWda(device.udid, build, this.deps.session)
    this.sessions.set(device.udid, handle)
    handle.process.once('exit', () => {
      if (this.sessions.get(device.udid) === handle) {
        this.sessions.delete(device.udid)
        this.windowSizes.delete(device.udid)
      }
    })
    return toSessionInfo(device, handle)
  }

  require(deviceUdid: string): WdaHandle {
    const handle = this.sessions.get(deviceUdid)
    if (!handle || !isAlive(handle)) {
      throw new EmulatorError(
        'emulator_no_active',
        'No WebDriverAgent session on this device — attach the physical iOS device first.'
      )
    }
    return handle
  }

  async stop(deviceUdid: string, helperPid?: number): Promise<void> {
    const handle = this.sessions.get(deviceUdid)
    if (!handle) {
      if (helperPid) {
        try {
          process.kill(helperPid, 'SIGTERM')
        } catch {
          // Helper already gone.
        }
      }
      return
    }
    this.sessions.delete(deviceUdid)
    this.windowSizes.delete(deviceUdid)
    await stopWda(handle)
  }

  async isLive(deviceUdid: string): Promise<boolean> {
    const handle = this.sessions.get(deviceUdid)
    if (!handle || !isAlive(handle)) {
      return false
    }
    try {
      await handle.client.status()
      return true
    } catch {
      return false
    }
  }

  async windowSize(handle: WdaHandle): Promise<WdaWindowSize> {
    const cached = this.windowSizes.get(handle.deviceUdid)
    if (cached) {
      return cached
    }
    const size = await handle.client.windowSize()
    this.windowSizes.set(handle.deviceUdid, size)
    return size
  }

  forgetWindowSize(deviceUdid: string): void {
    this.windowSizes.delete(deviceUdid)
  }
}

function isAlive(handle: WdaHandle): boolean {
  return handle.process.exitCode === null && !handle.process.killed
}

function toSessionInfo(device: PhysicalIosDevice, handle: WdaHandle): EmulatorSessionInfo {
  return {
    deviceUdid: device.udid,
    wsUrl: handle.baseUrl,
    streamUrl: handle.mjpegUrl,
    axUrl: `${handle.baseUrl}/source?format=json`,
    helperPid: handle.process.pid,
    streamCodec: 'mjpeg',
    backend: 'ios-device'
  }
}
