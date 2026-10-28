import { z } from 'zod'
import { EmulatorError } from '../emulator-errors'

const REQUEST_TIMEOUT_MS = 15_000

export type WdaFetch = typeof fetch

// WDA returns "sessionId": null on /status before any session exists.
const wdaResponseSchema = z
  .object({
    value: z.unknown().optional(),
    sessionId: z.string().nullish()
  })
  .passthrough()

const wdaStatusSchema = z.object({
  ready: z.boolean().optional(),
  state: z.string().optional(),
  ios: z.object({ sdkVersion: z.string().optional() }).passthrough().optional()
})

const sessionValueSchema = z.object({ sessionId: z.string().optional() }).passthrough()

const windowSizeSchema = z.object({
  width: z.number(),
  height: z.number()
})

export type WdaWindowSize = z.infer<typeof windowSizeSchema>

export class WdaClient {
  constructor(
    private readonly baseUrl: string,
    private sessionId: string | undefined,
    private readonly fetchFn: WdaFetch = fetch
  ) {}

  get currentSessionId(): string | undefined {
    return this.sessionId
  }

  private url(path: string, sessionScoped = true): string {
    const base = this.baseUrl.replace(/\/+$/, '')
    if (!sessionScoped) {
      return `${base}${path}`
    }
    if (!this.sessionId) {
      throw new EmulatorError('emulator_no_active', 'No WebDriverAgent session; attach first.')
    }
    return `${base}/session/${this.sessionId}${path}`
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    sessionScoped = true
  ): Promise<unknown> {
    const url = this.url(path, sessionScoped)
    let response: Response
    try {
      response = await this.fetchFn(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      throw new EmulatorError(
        'emulator_wda_unreachable',
        `WebDriverAgent at ${this.baseUrl} is unreachable: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const text = await response.text().catch(() => '')
    let jsonBody: unknown = null
    try {
      jsonBody = text ? JSON.parse(text) : null
    } catch {
      jsonBody = null
    }
    const parsed = wdaResponseSchema.safeParse(jsonBody)
    if (!response.ok || !parsed.success) {
      const detail = parsed.success
        ? JSON.stringify(parsed.data.value ?? null)
        : `HTTP ${response.status}; body=${text.slice(0, 120)}`
      throw new EmulatorError(
        'emulator_wda_unreachable',
        `WebDriverAgent ${method} ${path} to ${url} failed (HTTP ${response.status}): ${detail}`
      )
    }
    return parsed.data.value
  }

  async status(): Promise<z.infer<typeof wdaStatusSchema>> {
    const value = await this.request('GET', '/status', undefined, false)
    return wdaStatusSchema.parse(value ?? {})
  }

  async createSession(): Promise<string> {
    let response: Response
    try {
      response = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, '')}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: {} }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      throw new EmulatorError(
        'emulator_wda_unreachable',
        `Cannot create WebDriverAgent session: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    let jsonBody: unknown = null
    try {
      jsonBody = JSON.parse(await response.text())
    } catch {
      jsonBody = null
    }
    const parsed = wdaResponseSchema.safeParse(jsonBody)
    const nested = parsed.success ? sessionValueSchema.safeParse(parsed.data.value) : null
    const sessionId = parsed.success
      ? (parsed.data.sessionId ?? nested?.data?.sessionId)
      : undefined
    if (!response.ok || typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new EmulatorError(
        'emulator_wda_launch',
        `WebDriverAgent refused to create a session (HTTP ${response.status}).`
      )
    }
    this.sessionId = sessionId
    return sessionId
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) {
      return
    }
    const path = `/session/${this.sessionId}`
    this.sessionId = undefined
    await this.request('DELETE', path, undefined, false).catch(() => undefined)
  }

  async windowSize(): Promise<WdaWindowSize> {
    const value = await this.request('GET', '/window/size')
    const parsed = windowSizeSchema.safeParse(value)
    if (!parsed.success) {
      throw new EmulatorError('emulator_error', 'WebDriverAgent returned no window size.')
    }
    return parsed.data
  }

  async tap(x: number, y: number): Promise<void> {
    await this.request('POST', '/actions', {
      actions: [
        {
          type: 'pointer',
          id: 'finger1',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x, y },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 50 },
            { type: 'pointerUp', button: 0 }
          ]
        }
      ]
    })
  }

  async touchSequence(
    points: { type: 'begin' | 'move' | 'end'; x: number; y: number }[]
  ): Promise<void> {
    const actions = points.flatMap((point) => {
      if (point.type === 'begin') {
        return [
          { type: 'pointerMove', duration: 0, x: point.x, y: point.y },
          { type: 'pointerDown', button: 0 }
        ]
      }
      if (point.type === 'move') {
        return [{ type: 'pointerMove', duration: 50, x: point.x, y: point.y }]
      }
      return [
        { type: 'pointerMove', duration: 0, x: point.x, y: point.y },
        { type: 'pointerUp', button: 0 }
      ]
    })
    await this.request('POST', '/actions', {
      actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }]
    })
  }

  async typeText(text: string): Promise<void> {
    await this.request('POST', '/wda/keys', { value: [...text] })
  }

  async pressButton(name: 'home' | 'volumeUp' | 'volumeDown'): Promise<void> {
    await this.request('POST', '/wda/pressButton', { name })
  }

  async setOrientation(orientation: 'PORTRAIT' | 'LANDSCAPE'): Promise<void> {
    await this.request('POST', '/orientation', { orientation })
  }

  async sourceJson(): Promise<Record<string, unknown>> {
    const value = await this.request('GET', '/source?format=json')
    const parsed = z.record(z.string(), z.unknown()).safeParse(value)
    if (!parsed.success) {
      throw new EmulatorError('emulator_error', 'WebDriverAgent returned an invalid AX tree.')
    }
    return parsed.data
  }

  async screenshotPng(): Promise<Buffer> {
    const value = await this.request('GET', '/screenshot')
    if (typeof value !== 'string' || value.length === 0) {
      throw new EmulatorError('emulator_error', 'WebDriverAgent returned no screenshot data.')
    }
    return Buffer.from(value, 'base64')
  }
}
