import { asJsonObject, type DevicectlCommandRunner } from './devicectl-execution'

export type PhysicalIosDevice = {
  /** CoreDevice UUID — the canonical `--device` selector for devicectl. */
  identifier: string
  /** Hardware UDID — matches what Instruments/Settings show. */
  udid: string
  name: string
  model: string
  osVersion: string | null
  /** wired | localNetwork */
  transportType: string | null
  pairingState: string | null
  connectionState: string | null
  bootState: string | null
  developerModeEnabled: boolean
  capabilities: string[]
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  return asJsonObject(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readDeveloperModeEnabled(state: JsonObject, legacyDevice: JsonObject): boolean {
  const status = asObject(state.developerModeStatus)
  const enabled = asObject(status.enabled)
  if (typeof enabled.mode === 'number') {
    return enabled.mode !== 0
  }
  // Deprecated flat field: deviceProperties.developerModeStatus === 'enabled'.
  return asString(state.developerModeStatus ?? legacyDevice.developerModeStatus) === 'enabled'
}

function readCapabilities(device: JsonObject): string[] {
  const capabilities = device.capabilities
  if (!Array.isArray(capabilities)) {
    return []
  }
  return capabilities
    .map((entry) => asObject(entry).featureIdentifier)
    .map((id) => asString(id))
    .filter((id): id is string => id !== null)
    .map((id) => id.split('.').at(-1) ?? id)
}

function toPhysicalDevice(device: JsonObject): PhysicalIosDevice | null {
  // Prefer the current `properties` tree; fall back to the deprecated flat groups.
  const properties = asObject(device.properties)
  const hardware = asObject(properties.hardware ?? device.hardwareProperties)
  const state = asObject(properties.state ?? device.deviceProperties)
  const connection = asObject(properties.connection ?? device.connectionProperties)
  const software = asObject(properties.software)
  if (asString(hardware.reality) !== 'physical') {
    return null
  }
  const identifier = asString(device.identifier)
  const udid = asString(hardware.udid) ?? identifier
  if (!identifier || !udid) {
    return null
  }
  const osVersion = asObject(software.osVersionNumber)
  return {
    identifier,
    udid,
    name: asString(state.name) ?? udid,
    model: asString(hardware.marketingName) ?? asString(hardware.deviceType) ?? 'iOS device',
    osVersion: asString(osVersion.stringValue) ?? asString(state.osVersionNumber),
    transportType: asString(connection.transportType),
    pairingState: asString(connection.pairingState),
    connectionState: asString(connection.state ?? connection.tunnelState),
    bootState: asString(state.bootState),
    developerModeEnabled: readDeveloperModeEnabled(state, asObject(device.deviceProperties)),
    capabilities: readCapabilities(device)
  }
}

export function parsePhysicalIosDevices(payload: unknown): PhysicalIosDevice[] {
  const devices = asObject(asObject(payload).result).devices
  if (!Array.isArray(devices)) {
    return []
  }
  return devices
    .map((device) => toPhysicalDevice(asObject(device)))
    .filter((device): device is PhysicalIosDevice => device !== null)
}

export async function listPhysicalIosDevices(
  runDevicectl: DevicectlCommandRunner
): Promise<PhysicalIosDevice[]> {
  const payload = await runDevicectl(['list', 'devices'], { json: true })
  return parsePhysicalIosDevices(payload)
}
