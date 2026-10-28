import { hostname } from 'node:os'
import { createLanBonjour } from '../../shared/lan-bonjour'
import {
  encodeLanNodeTxt,
  LAN_NODE_ADVERTISEMENT_VERSION,
  LAN_NODE_SERVICE_NAME,
  type LanNodeAdvertisement
} from '../../shared/lan-node-advertisement'
import {
  classifyRemotePairingHostname,
  parseHostAccessLink
} from '../../shared/remote-pairing-address'
import { escapeTerminalControlCharacters } from '../../shared/terminal-control-character-escape'
import type { ServeReadiness } from './serve-readiness'

export type ServeLanAdvertiseInput = {
  advertise: boolean
  advertisePair: boolean
  readiness: Pick<ServeReadiness, 'boundEndpoint' | 'runtimeId' | 'pairing'>
  version: string
  grantDesktopControl?: boolean
  /** Override the advertised node name; defaults to the machine hostname. */
  name?: string
  warn?: (message: string) => void
}

export type ServeLanAdvertiser = {
  /** Instance name other Orca installs list under `orca devices discover`. */
  nodeName: string
  stop: () => void
}

type PublishedService = { stop?: CallableFunction }
export type LanAdvertiseBonjour = {
  publish(options: {
    name: string
    type: string
    port: number
    protocol: 'tcp'
    txt: Record<string, string>
  }): PublishedService
  destroy(callback?: () => void): void
}

const SERVICE_INSTANCE_NAME_MAX_BYTES = 63
const textEncoder = new TextEncoder()

export function buildLanNodeAdvertisement(input: {
  name: string
  version: string
  platform: NodeJS.Platform
  arch: string
  runtimeId?: string
  grantDesktopControl?: boolean
  pairingUrl?: string | null
}): LanNodeAdvertisement {
  const platform =
    input.platform === 'darwin' || input.platform === 'win32' ? input.platform : 'linux'
  return {
    v: LAN_NODE_ADVERTISEMENT_VERSION,
    name: input.name,
    platform,
    arch: input.arch,
    orcaVersion: input.version,
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
    caps: ['runtime', ...(input.grantDesktopControl ? ['desktop-control'] : [])],
    ...(input.pairingUrl ? { pair: input.pairingUrl } : {})
  }
}

function parseBoundWsEndpoint(endpoint: string | null): { port: number; host: string } | null {
  if (!endpoint) {
    return null
  }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return null
  }
  const port = url.port === '' ? (url.protocol === 'wss:' ? 443 : 80) : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }
  return { port, host: url.hostname }
}

function advertisedPairingUrl(
  input: ServeLanAdvertiseInput,
  warn: (message: string) => void
): string | null {
  if (!input.advertisePair || !input.readiness.pairing.available) {
    return null
  }
  const url = input.readiness.pairing.url
  const parsed = parseHostAccessLink(url)
  if (!parsed.ok) {
    warn(`[serve] LAN advertise omits the pairing offer: ${parsed.message}`)
    return null
  }
  if (parsed.value.endpointKind === 'loopback') {
    warn(
      '[serve] LAN advertise omits the pairing offer: its endpoint is loopback, which other machines cannot reach. Supply --pairing-address with a reachable LAN address to advertise pairing.'
    )
    return null
  }
  warn(
    '[serve] LAN advertise broadcasts the runtime pairing offer; anyone on this network can pair. Use only on trusted networks.'
  )
  return url
}

// Advertising is best-effort: a serve that cannot multicast still serves.
export async function startServeLanAdvertiser(
  input: ServeLanAdvertiseInput,
  createBonjour: (
    onError: (error: unknown) => void
  ) => Promise<LanAdvertiseBonjour> = createLanBonjour
): Promise<ServeLanAdvertiser | null> {
  const warn = input.warn ?? ((message: string) => console.warn(message))
  if (!input.advertise) {
    return null
  }
  const bound = parseBoundWsEndpoint(input.readiness.boundEndpoint)
  if (!bound) {
    warn('[serve] LAN advertise skipped: no usable WebSocket endpoint port')
    return null
  }
  // A loopback-bound server is unreachable from the LAN; advertising it publishes a dead node.
  if (classifyRemotePairingHostname(bound.host) === 'loopback') {
    warn(
      `[serve] LAN advertise skipped: the server binds ${bound.host}, which other machines cannot reach. Re-run with --bind 0.0.0.0 (or a LAN address).`
    )
    return null
  }
  const pairingUrl = advertisedPairingUrl(input, warn)
  const nodeName = input.name ?? hostname()
  if (textEncoder.encode(nodeName).length > SERVICE_INSTANCE_NAME_MAX_BYTES) {
    warn(
      `[serve] LAN advertise skipped: node name exceeds ${SERVICE_INSTANCE_NAME_MAX_BYTES} UTF-8 bytes and cannot be a DNS label`
    )
    return null
  }
  let txt: Record<string, string>
  try {
    txt = encodeLanNodeTxt(
      buildLanNodeAdvertisement({
        name: nodeName,
        version: input.version,
        platform: process.platform,
        arch: process.arch,
        runtimeId: input.readiness.runtimeId,
        grantDesktopControl: input.grantDesktopControl,
        pairingUrl
      })
    )
  } catch (error) {
    warn(`[serve] LAN advertise skipped: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  let bonjour: LanAdvertiseBonjour | undefined
  let service: PublishedService | undefined
  let stopped = false
  let startupError: unknown = null
  const stopAdvertisement = () => {
    if (stopped) {
      return
    }
    stopped = true
    let destroyed = false
    const destroy = () => {
      if (!destroyed) {
        destroyed = true
        bonjour?.destroy()
      }
    }
    const fallback = setTimeout(destroy, 500)
    fallback.unref()
    if (typeof service?.stop === 'function') {
      try {
        service.stop(() => {
          clearTimeout(fallback)
          destroy()
        })
      } catch {
        clearTimeout(fallback)
        destroy()
      }
    } else {
      clearTimeout(fallback)
      destroy()
    }
  }
  const onAsyncError = (error: unknown) => {
    if (service) {
      warn(
        `[serve] LAN advertise stopped after a multicast error: ${escapeTerminalControlCharacters(error instanceof Error ? error.message : String(error), true)}`
      )
      stopAdvertisement()
      return
    }
    startupError ??= error
  }
  try {
    bonjour = await createBonjour(onAsyncError)
    if (startupError !== null) {
      throw startupError
    }
    service = bonjour.publish({
      name: nodeName,
      type: LAN_NODE_SERVICE_NAME,
      port: bound.port,
      protocol: 'tcp',
      txt
    })
    if (startupError !== null) {
      stopAdvertisement()
      throw startupError
    }
    return { nodeName, stop: stopAdvertisement }
  } catch (error) {
    if (!stopped) {
      stopped = true
      bonjour?.destroy()
    }
    warn(
      `[serve] LAN advertise failed: ${escapeTerminalControlCharacters(error instanceof Error ? error.message : String(error), true)}`
    )
    return null
  }
}
