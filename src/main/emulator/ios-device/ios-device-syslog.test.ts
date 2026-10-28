import { describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpec } from '@orca/process-host/process-spec'
import {
  captureIosDeviceSyslog,
  parseIosSyslogLine,
  type IosDeviceLogDeps
} from './ios-device-syslog'

const STRUCTURED_LINE =
  'Oct 28 10:26:50.373461 audiomxd(AudioToolbox)[117] <Debug>: AudioQueueObject.cpp:7745 ConvertInput'

function nodeScriptSpawn(script: string) {
  const specs: PipedProcessSpec[] = []
  const spawn = (spec: PipedProcessSpec) => {
    specs.push(spec)
    return spawnProcess({ program: process.execPath, args: ['-e', script] })
  }
  return { spawn, specs }
}

const idevicePresent: IosDeviceLogDeps['probe'] = async (program) => program === 'idevicesyslog'

describe('parseIosSyslogLine', () => {
  it('parses a structured syslog line', () => {
    expect(parseIosSyslogLine(STRUCTURED_LINE)).toEqual({
      timestamp: 'Oct 28 10:26:50.373461',
      process: 'audiomxd(AudioToolbox)',
      pid: 117,
      level: 'Debug',
      message: 'AudioQueueObject.cpp:7745 ConvertInput'
    })
  })

  it('keeps unparseable lines as raw messages', () => {
    expect(parseIosSyslogLine('some odd device output')).toEqual({
      message: 'some odd device output'
    })
  })

  it('drops empty and connection preamble lines', () => {
    expect(parseIosSyslogLine('')).toBeNull()
    expect(parseIosSyslogLine('[connected:00008110-000C3D2A119A201E]')).toBeNull()
    expect(parseIosSyslogLine('[disconnected]')).toBeNull()
  })
})

describe('captureIosDeviceSyslog', () => {
  it('spawns idevicesyslog with filters and stops at the line limit', async () => {
    const { spawn, specs } = nodeScriptSpawn(`
      console.log('[connected:UDID-1]');
      console.log(${JSON.stringify(STRUCTURED_LINE)});
      console.log(${JSON.stringify(STRUCTURED_LINE)});
      setInterval(() => {}, 1e6)
    `)
    const entries = await captureIosDeviceSyslog(
      'UDID-1',
      { lines: 2, filters: ['SpringBoard', 'proc:WebDriverAgentRunner'] },
      { spawn, probe: idevicePresent }
    )
    expect(specs[0].program).toBe('idevicesyslog')
    // -K is omitted: it disables -p process matching in libimobiledevice.
    expect(specs[0].args).toEqual([
      '-u',
      'UDID-1',
      '--no-colors',
      '-m',
      'SpringBoard',
      '-p',
      'WebDriverAgentRunner'
    ])
    expect(entries).toHaveLength(2)
    expect(entries[0].process).toBe('audiomxd(AudioToolbox)')
  })

  it('keeps -K for message-only filters', async () => {
    const { spawn, specs } = nodeScriptSpawn(`console.log(${JSON.stringify(STRUCTURED_LINE)})`)
    await captureIosDeviceSyslog(
      'UDID-1',
      { lines: 1, filters: ['SpringBoard'] },
      { spawn, probe: idevicePresent }
    )
    expect(specs[0].args).toEqual(['-u', 'UDID-1', '--no-colors', '-K', '-m', 'SpringBoard'])
  })

  it('stops after the capture window when fewer lines arrive', async () => {
    const { spawn } = nodeScriptSpawn(
      `console.log(${JSON.stringify(STRUCTURED_LINE)}); setInterval(() => {}, 1e6)`
    )
    const entries = await captureIosDeviceSyslog(
      'UDID-1',
      { durationMs: 50 },
      {
        spawn,
        probe: idevicePresent
      }
    )
    expect(entries).toHaveLength(1)
  })

  it('falls back to pymobiledevice3 when idevicesyslog is missing', async () => {
    const { spawn, specs } = nodeScriptSpawn(`console.log(${JSON.stringify(STRUCTURED_LINE)})`)
    const entries = await captureIosDeviceSyslog(
      'UDID-1',
      { lines: 1 },
      {
        spawn,
        probe: async (program) => program === 'pymobiledevice3'
      }
    )
    expect(specs[0].program).toBe('pymobiledevice3')
    expect(specs[0].args).toEqual(['syslog', 'live'])
    expect(specs[0].env?.PYMOBILEDEVICE3_UDID).toBe('UDID-1')
    expect(entries[0].level).toBe('Debug')
  })

  it('fails with an actionable error when no syslog tool exists', async () => {
    const { spawn } = nodeScriptSpawn('setInterval(() => {}, 1e6)')
    await expect(
      captureIosDeviceSyslog('UDID-1', {}, { spawn, probe: async () => false })
    ).rejects.toMatchObject({ code: 'emulator_unsupported' })
  })
})
