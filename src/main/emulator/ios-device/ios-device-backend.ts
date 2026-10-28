import { platform } from 'node:os'
import { isAbsolute } from 'node:path'
import { EmulatorError } from '../emulator-errors'
import type { EmulatorSessionInfo } from '../emulator-types'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'
import { parseServeSimCommandArgs } from '../serve-sim-execution'
import { normalizedToDevicePixels } from '../android/android-input-mapping'
import { execDevicectlCommand, type DevicectlCommandRunner } from './devicectl-execution'
import { listPhysicalIosDevices, type PhysicalIosDevice } from './ios-device-inventory'
import {
  captureIosDeviceScreenshot,
  getIosDeviceLockState,
  installIosDeviceApp,
  launchIosDeviceApp,
  listIosDeviceApps
} from './ios-device-operations'
import { WdaDeviceSessions, type WdaDeviceSessionDeps } from './wda-device-sessions'
import {
  captureIosDeviceSyslog,
  listIosDeviceCrashReports,
  pullIosDeviceCrashReports,
  type IosDeviceLogDeps,
  type IosSyslogOptions
} from './ios-device-syslog'
import { checkIosDeviceAvailability, toEmulatorDevice } from './ios-device-availability'
import type {
  BackendAvailability,
  EmulatorBackend,
  EmulatorBackendCapabilities,
  EmulatorDevice
} from '../backends/emulator-backend'

export type IosDeviceBackendOptions = {
  runDevicectl?: DevicectlCommandRunner
  hostPlatform?: NodeJS.Platform
  wda?: WdaDeviceSessionDeps
  log?: IosDeviceLogDeps
}

type WdaButton = 'home' | 'volumeUp' | 'volumeDown'

function toWdaButton(name: string): WdaButton | null {
  switch (name) {
    case 'home':
      return 'home'
    case 'volumeUp':
    case 'volumeup':
      return 'volumeUp'
    case 'volumeDown':
    case 'volumedown':
      return 'volumeDown'
    default:
      return null
  }
}

export class IosDeviceBackend implements EmulatorBackend {
  readonly kind = 'ios-device' as const
  readonly streamCodec = 'mjpeg' as const
  readonly capabilities: EmulatorBackendCapabilities = {
    install: true,
    launch: true,
    permissions: false,
    accessibilityTree: true,
    logcat: true
  }

  private readonly runDevicectl: DevicectlCommandRunner
  private readonly hostPlatform: NodeJS.Platform
  private readonly wdaSessions: WdaDeviceSessions
  private readonly logDeps: IosDeviceLogDeps

  constructor(options: IosDeviceBackendOptions = {}) {
    this.runDevicectl = options.runDevicectl ?? execDevicectlCommand
    this.hostPlatform = options.hostPlatform ?? platform()
    this.wdaSessions = new WdaDeviceSessions(options.wda)
    this.logDeps = options.log ?? {}
  }

  isSupportedOnHost(): boolean {
    return this.hostPlatform === 'darwin'
  }

  private async devices(): Promise<PhysicalIosDevice[]> {
    return listPhysicalIosDevices(this.runDevicectl)
  }

  async checkAvailability(): Promise<BackendAvailability> {
    if (!this.isSupportedOnHost()) {
      return {
        available: false,
        devices: [],
        message: 'Physical iOS devices require macOS with Xcode installed.'
      }
    }
    try {
      return checkIosDeviceAvailability(await this.devices())
    } catch (error) {
      return {
        available: false,
        devices: [],
        message: error instanceof Error ? error.message : 'devicectl is unavailable.'
      }
    }
  }

  async listDevices(): Promise<EmulatorDevice[]> {
    return (await this.devices()).map(toEmulatorDevice)
  }

  async listRunningDeviceIds(): Promise<string[] | null> {
    try {
      const devices = await this.devices()
      return devices
        .filter(
          (device) => device.pairingState === 'paired' && device.connectionState === 'connected'
        )
        .map((device) => device.udid)
    } catch {
      return null
    }
  }

  async ownsDevice(id: string): Promise<boolean> {
    if (!this.isSupportedOnHost()) {
      return false
    }
    try {
      return (await this.devices()).some(
        (device) => device.udid === id || device.identifier === id || device.name === id
      )
    } catch {
      return false
    }
  }

  private async resolveDevice(deviceOrName: string): Promise<PhysicalIosDevice> {
    const devices = await this.devices()
    const exact = devices.find(
      (device) =>
        device.udid === deviceOrName ||
        device.identifier === deviceOrName ||
        device.name === deviceOrName
    )
    if (exact) {
      return exact
    }
    const needle = deviceOrName.toLowerCase()
    const partial = devices.find(
      (device) =>
        device.name.toLowerCase().includes(needle) || device.model.toLowerCase().includes(needle)
    )
    if (partial) {
      return partial
    }
    throw new EmulatorError(
      'emulator_device_not_found',
      `Physical iOS device "${deviceOrName}" not found. Pair it over USB first.`
    )
  }

  async resolveDeviceId(deviceOrName: string): Promise<string> {
    return (await this.resolveDevice(deviceOrName)).identifier
  }

  async startSession(deviceId: string): Promise<EmulatorSessionInfo> {
    if (!this.isSupportedOnHost()) {
      throw new EmulatorError('emulator_not_macos', 'Physical iOS devices require macOS.')
    }
    return this.wdaSessions.start(await this.resolveDevice(deviceId))
  }

  async stopHelperForDevice(
    deviceId: string,
    options?: { helperPid?: number; includeOrphaned?: boolean }
  ): Promise<void> {
    const udid = await this.resolveDevice(deviceId)
      .then((device) => device.udid)
      .catch(() => deviceId)
    await this.wdaSessions.stop(udid, options?.helperPid)
  }

  async shutdownDevice(_deviceId: string): Promise<void> {
    throw new EmulatorError(
      'emulator_unsupported',
      'Orca will not power off a physical iOS device.'
    )
  }

  async isSessionReusable(info: EmulatorSessionInfo): Promise<boolean> {
    return this.wdaSessions.isLive(info.deviceUdid)
  }

  private async sessionFor(deviceId: string) {
    const device = await this.resolveDevice(deviceId).catch(() => null)
    return this.wdaSessions.require(device?.udid ?? deviceId)
  }

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    const handle = await this.sessionFor(deviceId)
    const point = normalizedToDevicePixels(x, y, await this.wdaSessions.windowSize(handle))
    await handle.client.tap(point.x, point.y)
  }

  async gesture(deviceId: string, points: EmulatorGesturePoint[]): Promise<void> {
    const handle = await this.sessionFor(deviceId)
    const size = await this.wdaSessions.windowSize(handle)
    await handle.client.touchSequence(
      points.map((point) => ({
        type: point.type,
        ...normalizedToDevicePixels(point.x, point.y, size)
      }))
    )
  }

  async type(deviceId: string, text: string): Promise<void> {
    const handle = await this.sessionFor(deviceId)
    await handle.client.typeText(text)
  }

  async button(deviceId: string, name: string): Promise<void> {
    const handle = await this.sessionFor(deviceId)
    const button = toWdaButton(name)
    if (!button) {
      throw new EmulatorError(
        'emulator_unsupported',
        `Button "${name}" is not available on a physical iOS device. Supported: home, volumeUp, volumeDown.`
      )
    }
    await handle.client.pressButton(button)
  }

  async rotate(deviceId: string, orientation: string): Promise<void> {
    const handle = await this.sessionFor(deviceId)
    const normalized = orientation.toLowerCase()
    if (normalized !== 'portrait' && normalized !== 'landscape') {
      throw new EmulatorError(
        'emulator_unsupported',
        `Orientation "${orientation}" is not supported. Use portrait or landscape.`
      )
    }
    await handle.client.setOrientation(normalized === 'portrait' ? 'PORTRAIT' : 'LANDSCAPE')
    this.wdaSessions.forgetWindowSize(handle.deviceUdid)
  }

  async accessibilityTree(deviceId: string): Promise<unknown> {
    const handle = await this.sessionFor(deviceId)
    return handle.client.sourceJson()
  }

  async exec(deviceId: string, command: string): Promise<unknown> {
    const selector = await this.resolveDeviceId(deviceId)
    const args = parseServeSimCommandArgs(command.trim())
    const [subcommand, ...rest] = args
    switch (subcommand) {
      case 'screenshot': {
        const destination = rest[0]
        if (!destination) {
          throw new EmulatorError('emulator_error', 'usage: screenshot <absolute-output-path>')
        }
        return captureIosDeviceScreenshot(this.runDevicectl, selector, destination)
      }
      case 'apps':
        return listIosDeviceApps(this.runDevicectl, selector)
      case 'lockstate':
        return getIosDeviceLockState(this.runDevicectl, selector)
      case 'crashlogs': {
        const device = await this.resolveDevice(deviceId)
        if (rest[0] === 'pull') {
          const destination = rest[1]
          if (!destination || !isAbsolute(destination)) {
            throw new EmulatorError(
              'emulator_error',
              'usage: crashlogs pull <absolute-output-dir> [match-regex]'
            )
          }
          return pullIosDeviceCrashReports(device.udid, destination, rest[2], this.logDeps)
        }
        return { reports: await listIosDeviceCrashReports(device.udid, this.logDeps) }
      }
      default:
        throw new EmulatorError(
          'emulator_unsupported',
          `Unknown iOS device command "${subcommand ?? ''}". Available: screenshot <path>, apps, lockstate, crashlogs [pull <dir> [match]].`
        )
    }
  }

  async logcat(deviceId: string, options?: IosSyslogOptions): Promise<unknown> {
    const device = await this.resolveDevice(deviceId)
    return captureIosDeviceSyslog(device.udid, options, this.logDeps)
  }

  async installApp(
    deviceId: string,
    appPath: string,
    _options?: { reinstall?: boolean }
  ): Promise<void> {
    await installIosDeviceApp(this.runDevicectl, await this.resolveDeviceId(deviceId), appPath)
  }

  async launchApp(deviceId: string, bundleId: string): Promise<void> {
    await launchIosDeviceApp(this.runDevicectl, await this.resolveDeviceId(deviceId), bundleId)
  }
}
