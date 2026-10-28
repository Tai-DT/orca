import { describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpec } from '@orca/process-host/process-spec'
import { launchWda, stopWda, type WdaHandle } from './wda-session'
import { WdaClient, type WdaFetch } from './wda-client'

const BUILD = { xctestrunPath: '/tmp/x.xctestrun', bundleIdentifier: 'com.orca.wda', cacheKey: 'k' }

function nodeScriptSpawn(script: string) {
  const specs: PipedProcessSpec[] = []
  const spawn = (spec: PipedProcessSpec) => {
    specs.push(spec)
    return spawnProcess({ program: process.execPath, args: ['-e', script] })
  }
  return { spawn, specs }
}

const okFetch: WdaFetch = async (url) => {
  const target = String(url)
  if (target.endsWith('/status')) {
    return new Response(JSON.stringify({ value: { ready: true } }))
  }
  if (target.endsWith('/session')) {
    return new Response(JSON.stringify({ sessionId: 'SID', value: {} }))
  }
  return new Response(JSON.stringify({ value: {} }))
}

describe('launchWda', () => {
  it('spawns test-without-building and parses ServerURLHere', async () => {
    const { spawn, specs } = nodeScriptSpawn(
      'console.log("ServerURLHere->http://192.0.2.9:8100<-ServerURLHere"); setInterval(() => {}, 1e6)'
    )
    const handle = await launchWda('UDID-1', BUILD, {
      spawn,
      fetchFn: okFetch,
      readyTimeoutMs: 10_000
    })
    expect(specs[0].program).toBe('xcodebuild')
    expect(specs[0].args).toContain('test-without-building')
    expect(specs[0].args).toContain('-xctestrun')
    expect(specs[0].args).toContain('platform=iOS,id=UDID-1')
    expect(handle.baseUrl).toBe('http://192.0.2.9:8100')
    expect(handle.mjpegUrl).toBe('http://192.0.2.9:9100/')
    expect(handle.client.currentSessionId).toBe('SID')
    await stopWda(handle)
    expect(handle.process.killed).toBe(true)
  })

  it('fails when the runner exits before publishing a URL', async () => {
    const { spawn } = nodeScriptSpawn('console.error("signing failed"); process.exit(65)')
    await expect(
      launchWda('UDID-1', BUILD, { spawn, fetchFn: okFetch, readyTimeoutMs: 5_000 })
    ).rejects.toMatchObject({ code: 'emulator_wda_launch' })
  })

  it('fails when the server never becomes ready', async () => {
    const { spawn } = nodeScriptSpawn(
      'console.log("ServerURLHere->http://192.0.2.9:8100<-ServerURLHere"); setInterval(() => {}, 1e6)'
    )
    const downFetch: WdaFetch = async () => {
      throw new Error('refused')
    }
    await expect(
      launchWda('UDID-1', BUILD, { spawn, fetchFn: downFetch, readyTimeoutMs: 100 })
    ).rejects.toMatchObject({ code: 'emulator_wda_unreachable' })
  })
})

describe('stopWda', () => {
  it('is idempotent after the process already exited', async () => {
    const { spawn } = nodeScriptSpawn('process.exit(0)')
    const proc = spawn({ program: 'xcodebuild', args: [] })
    await new Promise((resolve) => proc.once('exit', resolve))
    const handle: WdaHandle = {
      deviceUdid: 'U',
      baseUrl: 'http://h:8100',
      mjpegUrl: 'http://h:9100/',
      client: new WdaClient('http://h:8100', 'S', okFetch),
      process: proc
    }
    await expect(stopWda(handle)).resolves.toBeUndefined()
  })
})
