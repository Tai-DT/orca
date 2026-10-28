import type { PhysicalIosDevice } from './ios-device-inventory'
import type { BackendAvailability, EmulatorDevice } from '../backends/emulator-backend'

export function toEmulatorDevice(device: PhysicalIosDevice): EmulatorDevice {
  const connected =
    device.pairingState === 'paired' &&
    device.connectionState === 'connected' &&
    device.bootState === 'booted'
  const transport = device.transportType === 'wired' ? 'usb' : (device.transportType ?? 'ios')
  return {
    backend: 'ios-device',
    id: device.udid,
    name: device.name,
    state: connected ? 'booted' : 'shutdown',
    detail: `${device.model} · ${transport}${device.osVersion ? ` · iOS ${device.osVersion}` : ''}`,
    isAvailable: device.pairingState === 'paired'
  }
}

export function checkIosDeviceAvailability(devices: PhysicalIosDevice[]): BackendAvailability {
  const paired = devices.filter((device) => device.pairingState === 'paired')
  if (paired.length === 0) {
    return {
      available: false,
      devices: devices.map(toEmulatorDevice),
      message:
        devices.length > 0
          ? 'iOS devices found but none paired — connect over USB and tap Trust This Computer.'
          : 'No physical iOS devices found. Connect an iPhone/iPad over USB and pair it with this Mac.'
    }
  }
  const notReady = paired.filter(
    (device) => !device.developerModeEnabled || device.connectionState !== 'connected'
  )
  if (notReady.length > 0) {
    const reasons = notReady.map((device) =>
      !device.developerModeEnabled
        ? `${device.name}: enable Developer Mode in Settings > Privacy & Security`
        : `${device.name}: connected but tunnel is not established — unplug and reconnect`
    )
    return {
      available: false,
      devices: devices.map(toEmulatorDevice),
      message: reasons.join('; ')
    }
  }
  return { available: true, devices: devices.map(toEmulatorDevice), message: 'Ready' }
}
