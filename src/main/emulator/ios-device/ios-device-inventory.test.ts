import { describe, expect, it } from 'vitest'
import { parsePhysicalIosDevices } from './ios-device-inventory'

const PHYSICAL_DEVICE = {
  identifier: '4C3762E5-72E6-515C-9883-98324E6F3D36',
  capabilities: [
    { featureIdentifier: 'com.apple.coredevice.feature.installapp' },
    { featureIdentifier: 'com.apple.coredevice.feature.launchapplication' }
  ],
  properties: {
    connection: {
      pairingState: 'paired',
      state: 'connected',
      transportType: 'wired'
    },
    hardware: {
      deviceType: 'iPhone',
      marketingName: 'iPhone SE (3rd generation)',
      reality: 'physical',
      udid: '00008110-000C3D2A119A201E'
    },
    software: {
      osVersionNumber: { stringValue: '27.0.1' }
    },
    state: {
      bootState: 'booted',
      developerModeStatus: { enabled: { mode: 1 } },
      name: 'iPhone'
    }
  }
}

const SIMULATOR_DEVICE = {
  identifier: '07C2190C-48AE-4D01-8071-77479E2D0172',
  properties: {
    connection: { pairingState: 'paired', state: 'connected', transportType: 'sameMachine' },
    hardware: { marketingName: 'iPhone 17 Pro', reality: 'simulated', udid: 'sim-udid' },
    state: { bootState: 'booted', name: 'Devin-iPhone17Pro' }
  }
}

const LEGACY_PHYSICAL_DEVICE = {
  identifier: 'legacy-identifier',
  deviceProperties: {
    bootState: 'booted',
    developerModeStatus: 'enabled',
    name: 'Old iPhone',
    osVersionNumber: '17.0'
  },
  hardwareProperties: {
    marketingName: 'iPhone 12',
    reality: 'physical',
    udid: 'legacy-udid'
  },
  connectionProperties: {
    pairingState: 'paired',
    transportType: 'wired',
    tunnelState: 'connected'
  }
}

describe('parsePhysicalIosDevices', () => {
  it('keeps physical devices and drops simulators', () => {
    const devices = parsePhysicalIosDevices({
      result: { devices: [PHYSICAL_DEVICE, SIMULATOR_DEVICE] }
    })

    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({
      identifier: '4C3762E5-72E6-515C-9883-98324E6F3D36',
      udid: '00008110-000C3D2A119A201E',
      name: 'iPhone',
      model: 'iPhone SE (3rd generation)',
      osVersion: '27.0.1',
      transportType: 'wired',
      pairingState: 'paired',
      connectionState: 'connected',
      bootState: 'booted',
      developerModeEnabled: true,
      capabilities: ['installapp', 'launchapplication']
    })
  })

  it('parses the deprecated flat property groups', () => {
    const devices = parsePhysicalIosDevices({
      result: { devices: [LEGACY_PHYSICAL_DEVICE] }
    })

    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({
      identifier: 'legacy-identifier',
      udid: 'legacy-udid',
      name: 'Old iPhone',
      model: 'iPhone 12',
      osVersion: '17.0',
      pairingState: 'paired',
      connectionState: 'connected',
      developerModeEnabled: true
    })
  })

  it('marks developer mode disabled in both schemas', () => {
    const disabled = {
      ...PHYSICAL_DEVICE,
      properties: {
        ...PHYSICAL_DEVICE.properties,
        state: {
          ...PHYSICAL_DEVICE.properties.state,
          developerModeStatus: { enabled: { mode: 0 } }
        }
      }
    }
    const legacyDisabled = {
      ...LEGACY_PHYSICAL_DEVICE,
      deviceProperties: {
        ...LEGACY_PHYSICAL_DEVICE.deviceProperties,
        developerModeStatus: 'disabled'
      }
    }

    const devices = parsePhysicalIosDevices({
      result: { devices: [disabled, legacyDisabled] }
    })

    expect(devices).toHaveLength(2)
    expect(devices.every((device) => device.developerModeEnabled === false)).toBe(true)
  })

  it('falls back to the core device identifier when the hardware udid is missing', () => {
    const noUdid = {
      identifier: 'core-device-uuid',
      properties: {
        hardware: { reality: 'physical' },
        state: {},
        connection: {}
      }
    }

    const devices = parsePhysicalIosDevices({ result: { devices: [noUdid] } })

    expect(devices[0]?.udid).toBe('core-device-uuid')
  })

  it('returns an empty list for malformed payloads', () => {
    expect(parsePhysicalIosDevices(undefined)).toEqual([])
    expect(parsePhysicalIosDevices({ result: {} })).toEqual([])
    expect(parsePhysicalIosDevices('not json')).toEqual([])
  })
})
