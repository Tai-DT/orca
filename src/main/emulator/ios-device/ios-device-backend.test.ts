import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpec } from '@orca/process-host/process-spec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmulatorError } from '../emulator-errors'
import { IosDeviceBackend } from './ios-device-backend'
import type { DevicectlCommandRunner } from './devicectl-execution'
import type { SecurityCommandRunner } from './wda-signing'
import type { WdaCommandRunner } from './wda-build'
import type { WdaFetch } from './wda-client'

const CONNECTED_IPHONE = {
  identifier: '4C3762E5-72E6-515C-9883-98324E6F3D36',
  capabilities: [],
  properties: {
    connection: { pairingState: 'paired', state: 'connected', transportType: 'wired' },
    hardware: {
      marketingName: 'iPhone SE (3rd generation)',
      reality: 'physical',
      udid: '00008110-000C3D2A119A201E'
    },
    state: { bootState: 'booted', developerModeStatus: { enabled: { mode: 1 } }, name: 'iPhone' }
  }
}

function fakeRunner(devices: unknown[] = [CONNECTED_IPHONE]) {
  const calls: string[][] = []
  const runner: DevicectlCommandRunner = async (args, options) => {
    calls.push([...args])
    expect(options?.json).toBe(true)
    if (args[0] === 'list') {
      return { info: { outcome: 'success' }, result: { devices } }
    }
    return { info: { outcome: 'success' }, result: {} }
  }
  return { runner, calls }
}

describe('IosDeviceBackend', () => {
  it('declares ios-device kind with WDA-backed session capabilities', () => {
    const backend = new IosDeviceBackend({ runDevicectl: fakeRunner().runner })
    expect(backend.kind).toBe('ios-device')
    expect(backend.capabilities).toEqual({
      install: true,
      launch: true,
      permissions: false,
      accessibilityTree: true,
      logcat: true
    })
  })

  it('is only supported on macOS hosts', () => {
    expect(
      new IosDeviceBackend({
        runDevicectl: fakeRunner().runner,
        hostPlatform: 'darwin'
      }).isSupportedOnHost()
    ).toBe(true)
    expect(
      new IosDeviceBackend({
        runDevicectl: fakeRunner().runner,
        hostPlatform: 'linux'
      }).isSupportedOnHost()
    ).toBe(false)
  })

  it('lists physical devices as emulator rows', async () => {
    const backend = new IosDeviceBackend({ runDevicectl: fakeRunner().runner })
    const devices = await backend.listDevices()
    expect(devices).toEqual([
      {
        backend: 'ios-device',
        id: '00008110-000C3D2A119A201E',
        name: 'iPhone',
        state: 'booted',
        detail: 'iPhone SE (3rd generation) · usb',
        isAvailable: true
      }
    ])
  })

  it('owns devices by udid, core identifier, or name', async () => {
    const backend = new IosDeviceBackend({ runDevicectl: fakeRunner().runner })
    expect(await backend.ownsDevice('00008110-000C3D2A119A201E')).toBe(true)
    expect(await backend.ownsDevice('4C3762E5-72E6-515C-9883-98324E6F3D36')).toBe(true)
    expect(await backend.ownsDevice('iPhone')).toBe(true)
    expect(await backend.ownsDevice('R58N53KZHYY')).toBe(false)
  })

  it('resolves names to the core device identifier for devicectl', async () => {
    const { runner, calls } = fakeRunner()
    const backend = new IosDeviceBackend({ runDevicectl: runner })
    await backend.launchApp('iPhone', 'com.example.app')
    expect(calls.at(-1)).toEqual([
      'device',
      'process',
      'launch',
      '--device',
      '4C3762E5-72E6-515C-9883-98324E6F3D36',
      '--terminate-existing',
      'com.example.app'
    ])
  })

  it('rejects unknown devices with device_not_found', async () => {
    const backend = new IosDeviceBackend({ runDevicectl: fakeRunner().runner })
    await expect(backend.resolveDeviceId('no-such-device')).rejects.toMatchObject({
      code: 'emulator_device_not_found'
    })
  })

  it('installs only .ipa packages', async () => {
    const { runner, calls } = fakeRunner()
    const backend = new IosDeviceBackend({ runDevicectl: runner })
    await backend.installApp('iPhone', '/tmp/app.ipa')
    expect(calls.at(-1)).toEqual([
      'device',
      'install',
      'app',
      '--device',
      '4C3762E5-72E6-515C-9883-98324E6F3D36',
      '/tmp/app.ipa'
    ])
    await expect(backend.installApp('iPhone', '/tmp/app.apk')).rejects.toMatchObject({
      code: 'emulator_error'
    })
  })

  it('routes screenshot exec to devicectl capture', async () => {
    const { runner, calls } = fakeRunner()
    const backend = new IosDeviceBackend({ runDevicectl: runner })
    await backend.exec('00008110-000C3D2A119A201E', 'screenshot /tmp/shot.png')
    expect(calls.at(-1)).toEqual([
      'device',
      'capture',
      'screenshot',
      '--device',
      '4C3762E5-72E6-515C-9883-98324E6F3D36',
      '--destination',
      '/tmp/shot.png'
    ])
    await expect(backend.exec('iPhone', 'rm -rf /')).rejects.toMatchObject({
      code: 'emulator_unsupported'
    })
    await expect(backend.exec('iPhone', 'screenshot relative.png')).rejects.toMatchObject({
      code: 'emulator_error'
    })
  })

  it('routes crashlogs exec to pymobiledevice3 and exposes logcat', async () => {
    const pm3Calls: string[][] = []
    const backend = new IosDeviceBackend({
      runDevicectl: fakeRunner().runner,
      log: {
        probe: async () => true,
        run: async (spec) => {
          pm3Calls.push([...spec.args])
          return { code: 0, stdout: '/MyApp-2026-10-28.ips\n', stderr: '' }
        }
      }
    })
    expect(backend.capabilities.logcat).toBe(true)

    const listed = await backend.exec('iPhone', 'crashlogs')
    expect(pm3Calls.at(-1)).toEqual(['crash', 'ls'])
    expect(listed).toEqual({ reports: ['/MyApp-2026-10-28.ips'] })

    await backend.exec('iPhone', 'crashlogs pull /tmp/orca-crashes WiFi')
    expect(pm3Calls.at(-1)).toEqual([
      'crash',
      'pull',
      '--remote-file',
      '/',
      '/tmp/orca-crashes',
      '-m',
      'WiFi'
    ])
    await expect(backend.exec('iPhone', 'crashlogs pull relative')).rejects.toMatchObject({
      code: 'emulator_error'
    })
  })

  it('rejects input without an active WDA session and never powers off', async () => {
    const backend = new IosDeviceBackend({ runDevicectl: fakeRunner().runner })
    await expect(backend.tap('iPhone', 0.5, 0.5)).rejects.toMatchObject({
      code: 'emulator_no_active'
    })
    await expect(backend.type('iPhone', 'x')).rejects.toMatchObject({ code: 'emulator_no_active' })
    await expect(backend.shutdownDevice('iPhone')).rejects.toMatchObject({
      code: 'emulator_unsupported'
    })
  })

  it('reports readiness problems instead of failing', async () => {
    const unpaired = {
      ...CONNECTED_IPHONE,
      properties: {
        ...CONNECTED_IPHONE.properties,
        connection: { pairingState: 'unpaired', state: 'disconnected' }
      }
    }
    const backend = new IosDeviceBackend({ runDevicectl: fakeRunner([unpaired]).runner })
    const availability = await backend.checkAvailability()
    expect(availability.available).toBe(false)
    expect(availability.message).toContain('Trust This Computer')
  })

  it('flags paired devices without developer mode as not ready', async () => {
    const noDevMode = {
      ...CONNECTED_IPHONE,
      properties: {
        ...CONNECTED_IPHONE.properties,
        state: {
          bootState: 'booted',
          developerModeStatus: { enabled: { mode: 0 } },
          name: 'iPhone'
        }
      }
    }
    const backend = new IosDeviceBackend({ runDevicectl: fakeRunner([noDevMode]).runner })
    const availability = await backend.checkAvailability()
    expect(availability.available).toBe(false)
    expect(availability.message).toContain('Developer Mode')
  })

  it('propagates devicectl failures as availability, not crashes', async () => {
    const runner = vi.fn(async () => {
      throw new EmulatorError('emulator_devicectl_unavailable', 'no xcode')
    })
    const backend = new IosDeviceBackend({ runDevicectl: runner })
    const availability = await backend.checkAvailability()
    expect(availability).toMatchObject({ available: false, message: 'no xcode' })
    expect(await backend.listRunningDeviceIds()).toBeNull()
  })
})

describe('IosDeviceBackend WDA sessions', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop() ?? '', { recursive: true, force: true })
    }
  })

  function makeTmpDir(prefix: string): string {
    const created = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(created)
    return created
  }

  function fakeWdaDeps() {
    const dir = makeTmpDir('orca-wda-backend-')
    const sourceDir = join(dir, 'wda-src')
    mkdirSync(join(sourceDir, 'WebDriverAgent.xcodeproj'), { recursive: true })
    const profilesDir = join(dir, 'profiles')
    mkdirSync(profilesDir)
    writeFileSync(join(profilesDir, 'a.mobileprovision'), 'x')

    const plist = `<?xml version="1.0"?><plist><dict>
<key>TeamIdentifier</key><array><string>TEAM123456</string></array>
<key>ProvisionedDevices</key><array><string>00008110-000C3D2A119A201E</string></array>
</dict></plist>`
    const runSecurity: SecurityCommandRunner = async (args) =>
      args[0] === 'find-identity'
        ? { code: 0, stdout: ' 1) X "Apple Development: D (TEAM123456)"\n', stderr: '' }
        : { code: 0, stdout: plist, stderr: '' }

    const xcodebuildCalls: string[] = []
    const runCommand: WdaCommandRunner = async (spec) => {
      xcodebuildCalls.push(spec.args.join(' '))
      const i = spec.args.indexOf('-derivedDataPath')
      const products = join(spec.args[i + 1], 'Build', 'Products')
      mkdirSync(products, { recursive: true })
      writeFileSync(join(products, 'Runner.xctestrun'), 'x')
      return { code: 0, stdout: '', stderr: '' }
    }

    const spawnSpecs: PipedProcessSpec[] = []
    const spawn = (spec: PipedProcessSpec) => {
      spawnSpecs.push(spec)
      return spawnProcess({
        program: process.execPath,
        args: [
          '-e',
          'console.log("ServerURLHere->http://192.0.2.9:8100<-ServerURLHere"); setInterval(() => {}, 1e6)'
        ]
      })
    }

    const fetchCalls: { url: string; method: string; body?: unknown }[] = []
    const fetchFn: WdaFetch = async (url, init) => {
      const target = String(url)
      fetchCalls.push({
        url: target,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      })
      const payload = target.endsWith('/status')
        ? { value: { ready: true } }
        : target.endsWith('/session')
          ? { sessionId: 'SID-1', value: {} }
          : target.includes('/window/size')
            ? { value: { width: 375, height: 667 } }
            : target.includes('/source')
              ? { value: { type: 'XCUIElementTypeApplication', children: [] } }
              : { value: {} }
      return new Response(JSON.stringify(payload), { status: 200 })
    }

    return {
      wda: {
        signing: { runSecurity, profilesDir },
        build: { runCommand, sourceDir, buildRootDir: join(dir, 'builds') },
        session: { spawn, fetchFn, readyTimeoutMs: 10_000 }
      },
      fetchCalls,
      spawnSpecs,
      xcodebuildCalls
    }
  }

  it('runs the full attach lifecycle and returns session endpoints', async () => {
    const deps = fakeWdaDeps()
    const backend = new IosDeviceBackend({ runDevicectl: fakeRunner().runner, ...deps })
    const session = await backend.startSession('iPhone')
    expect(session).toMatchObject({
      deviceUdid: '00008110-000C3D2A119A201E',
      wsUrl: 'http://192.0.2.9:8100',
      streamUrl: 'http://192.0.2.9:9100/',
      streamCodec: 'mjpeg',
      backend: 'ios-device'
    })
    expect(session.axUrl).toContain('/source')
    expect(deps.xcodebuildCalls[0]).toContain('DEVELOPMENT_TEAM=TEAM123456')
    expect(deps.spawnSpecs[0].args).toContain('test-without-building')
    await backend.stopHelperForDevice('iPhone')
  })

  it('maps normalized taps to WDA logical points', async () => {
    const deps = fakeWdaDeps()
    const backend = new IosDeviceBackend({ runDevicectl: fakeRunner().runner, ...deps })
    await backend.startSession('iPhone')
    await backend.tap('iPhone', 0.5, 0.5)
    const actionsCall = deps.fetchCalls.find((call) => call.url.includes('/actions'))
    expect(actionsCall?.url).toBe('http://192.0.2.9:8100/session/SID-1/actions')
    expect(JSON.stringify(actionsCall?.body)).toContain('"x":188')
    expect(JSON.stringify(actionsCall?.body)).toContain('"y":334')
    await backend.type('iPhone', 'hi')
    expect(deps.fetchCalls.at(-1)?.url).toContain('/wda/keys')
    await backend.accessibilityTree('iPhone')
    expect(deps.fetchCalls.at(-1)?.url).toContain('/source?format=json')
    await backend.stopHelperForDevice('iPhone')
    await expect(backend.tap('iPhone', 0.5, 0.5)).rejects.toMatchObject({
      code: 'emulator_no_active'
    })
  })

  it('reuses a live session instead of rebuilding', async () => {
    const deps = fakeWdaDeps()
    const backend = new IosDeviceBackend({ runDevicectl: fakeRunner().runner, ...deps })
    const first = await backend.startSession('iPhone')
    const second = await backend.startSession('iPhone')
    expect(second.wsUrl).toBe(first.wsUrl)
    expect(deps.spawnSpecs).toHaveLength(1)
    expect(await backend.isSessionReusable(first)).toBe(true)
    await backend.stopHelperForDevice('iPhone')
    expect(await backend.isSessionReusable(first)).toBe(false)
  })

  it('fails attach when no signing profile covers the device', async () => {
    const deps = fakeWdaDeps()
    const backend = new IosDeviceBackend({
      runDevicectl: fakeRunner().runner,
      ...deps,
      wda: {
        ...deps.wda,
        signing: {
          runSecurity: deps.wda.signing?.runSecurity,
          profilesDir: join(makeTmpDir('orca-wda-empty-'), 'none')
        }
      }
    })
    await expect(backend.startSession('iPhone')).rejects.toMatchObject({
      code: 'emulator_wda_signing'
    })
  })
})
