import { isAbsolute } from 'node:path'
import { EmulatorError } from '../emulator-errors'
import type { DevicectlCommandRunner } from './devicectl-execution'

export async function installIosDeviceApp(
  runDevicectl: DevicectlCommandRunner,
  selector: string,
  appPath: string
): Promise<void> {
  if (!appPath.endsWith('.ipa')) {
    throw new EmulatorError(
      'emulator_error',
      `Physical iOS devices install signed .ipa packages, got: ${appPath}`
    )
  }
  await runDevicectl(['device', 'install', 'app', '--device', selector, appPath], { json: true })
}

export async function launchIosDeviceApp(
  runDevicectl: DevicectlCommandRunner,
  selector: string,
  bundleId: string
): Promise<void> {
  await runDevicectl(
    ['device', 'process', 'launch', '--device', selector, '--terminate-existing', bundleId],
    { json: true }
  )
}

export async function captureIosDeviceScreenshot(
  runDevicectl: DevicectlCommandRunner,
  selector: string,
  destination: string
): Promise<unknown> {
  if (!isAbsolute(destination)) {
    throw new EmulatorError(
      'emulator_error',
      `Screenshot destination must be an absolute path on this host, got: ${destination}`
    )
  }
  return runDevicectl(
    ['device', 'capture', 'screenshot', '--device', selector, '--destination', destination],
    { json: true }
  )
}

export async function listIosDeviceApps(
  runDevicectl: DevicectlCommandRunner,
  selector: string
): Promise<unknown> {
  return runDevicectl(['device', 'info', 'apps', '--device', selector], { json: true })
}

export async function getIosDeviceLockState(
  runDevicectl: DevicectlCommandRunner,
  selector: string
): Promise<unknown> {
  return runDevicectl(['device', 'info', 'lockState', '--device', selector], { json: true })
}
