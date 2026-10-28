import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EmulatorError } from '../emulator-errors'
import { WdaClient, type WdaFetch } from './wda-client'

const actionsBodySchema = z.object({
  actions: z.array(
    z.object({
      actions: z.array(
        z.object({ type: z.string(), x: z.number().optional(), y: z.number().optional() })
      )
    })
  )
})

function fakeFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const fetchFn: WdaFetch = async (url, init) => {
    const target = String(url)
    calls.push({
      url: target,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    })
    return new Response(JSON.stringify(handler(target, init)), { status: 200 })
  }
  return { fetchFn, calls }
}

describe('WdaClient', () => {
  it('creates a session and uses it for session-scoped endpoints', async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      url.endsWith('/session')
        ? { sessionId: 'SID-42', value: { sessionId: 'SID-42' } }
        : { value: {} }
    )
    const client = new WdaClient('http://10.0.0.5:8100/', undefined, fetchFn)
    expect(await client.createSession()).toBe('SID-42')
    await client.typeText('abc')
    expect(calls.at(-1)?.url).toBe('http://10.0.0.5:8100/session/SID-42/wda/keys')
    expect(calls.at(-1)?.body).toEqual({ value: ['a', 'b', 'c'] })
  })

  it('sends a W3C tap action sequence', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ value: {} }))
    const client = new WdaClient('http://h:8100', 'S1', fetchFn)
    await client.tap(187, 333)
    const body = actionsBodySchema.parse(calls.at(-1)?.body)
    expect(calls.at(-1)?.url).toBe('http://h:8100/session/S1/actions')
    expect(body.actions[0].actions.map((a) => a.type)).toEqual([
      'pointerMove',
      'pointerDown',
      'pause',
      'pointerUp'
    ])
    expect(body.actions[0].actions[0]).toMatchObject({ x: 187, y: 333 })
  })

  it('maps begin/move/end gesture points to pointer actions', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ value: {} }))
    const client = new WdaClient('http://h:8100', 'S1', fetchFn)
    await client.touchSequence([
      { type: 'begin', x: 10, y: 20 },
      { type: 'move', x: 30, y: 40 },
      { type: 'end', x: 50, y: 60 }
    ])
    const body = actionsBodySchema.parse(calls.at(-1)?.body)
    expect(body.actions[0].actions.map((a) => a.type)).toEqual([
      'pointerMove',
      'pointerDown',
      'pointerMove',
      'pointerMove',
      'pointerUp'
    ])
  })

  it('fails before a session exists', async () => {
    const { fetchFn } = fakeFetch(() => ({ value: {} }))
    const client = new WdaClient('http://h:8100', undefined, fetchFn)
    await expect(client.tap(1, 1)).rejects.toMatchObject({ code: 'emulator_no_active' })
  })

  it('parses ready status and window size', async () => {
    const { fetchFn } = fakeFetch((url) =>
      url.endsWith('/status')
        ? { value: { ready: true, state: 'success', ios: { sdkVersion: '27.0' } } }
        : { value: { width: 375, height: 667 } }
    )
    const client = new WdaClient('http://h:8100', 'S1', fetchFn)
    expect(await client.status()).toMatchObject({ ready: true })
    expect(await client.windowSize()).toEqual({ width: 375, height: 667 })
  })

  it('accepts a null sessionId on /status before any session exists', async () => {
    const { fetchFn } = fakeFetch(() => ({
      value: { ready: true, state: 'success' },
      sessionId: null
    }))
    const client = new WdaClient('http://h:8100', undefined, fetchFn)
    expect(await client.status()).toMatchObject({ ready: true })
  })

  it('classifies unreachable servers', async () => {
    const fetchFn: WdaFetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const client = new WdaClient('http://h:8100', 'S1', fetchFn)
    await expect(client.status()).rejects.toMatchObject({ code: 'emulator_wda_unreachable' })
  })

  it('returns base64 screenshot bytes', async () => {
    const png = Buffer.from('png-bytes')
    const { fetchFn } = fakeFetch(() => ({ value: png.toString('base64') }))
    const client = new WdaClient('http://h:8100', 'S1', fetchFn)
    expect(await client.screenshotPng()).toEqual(png)
  })

  it('wraps non-2xx responses as unreachable errors', async () => {
    const fetchFn: WdaFetch = async () =>
      new Response('{"value":{"message":"bad"}}', { status: 500 })
    const client = new WdaClient('http://h:8100', 'S1', fetchFn)
    const error: unknown = await client.status().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EmulatorError)
    if (error instanceof EmulatorError) {
      expect(error.code).toBe('emulator_wda_unreachable')
    }
  })
})
