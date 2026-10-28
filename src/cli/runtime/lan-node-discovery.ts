import { createLanBonjour } from '../../shared/lan-bonjour'
import {
  decodeLanNodeTxt,
  LAN_NODE_SERVICE_NAME,
  type LanNodeAdvertisement
} from '../../shared/lan-node-advertisement'

export type DiscoveredLanNode = {
  id: string
  name: string
  host: string | null
  addresses: string[]
  port: number
  advertisement: LanNodeAdvertisement
}

type BonjourServiceRecord = {
  fqdn?: unknown
  name?: unknown
  host?: unknown
  addresses?: unknown
  port?: unknown
  txt?: Record<string, unknown>
}

type DiscoveryBrowser = {
  stop(): void
  on(
    event: 'up' | 'down' | 'txt-update' | 'srv-update',
    listener: (service: BonjourServiceRecord) => void
  ): unknown
}

type DiscoveryBonjour = {
  find(
    options: { type: string; protocol?: 'tcp' },
    onup: (service: BonjourServiceRecord) => void
  ): DiscoveryBrowser
  destroy(callback?: () => void): void
}

function normalizeFqdn(fqdn: string): string {
  return fqdn.toLowerCase().replace(/\.$/, '')
}

function nodeKey(service: BonjourServiceRecord): string | null {
  if (typeof service.fqdn === 'string' && service.fqdn.length > 0) {
    return normalizeFqdn(service.fqdn)
  }
  if (typeof service.name !== 'string') {
    return null
  }
  const host = typeof service.host === 'string' ? service.host : ''
  const port = typeof service.port === 'number' ? String(service.port) : ''
  const addresses = Array.isArray(service.addresses)
    ? service.addresses.filter((address) => typeof address === 'string').sort()
    : []
  return `${service.name}|${host}|${port}|${addresses.join(',')}`
}

function toDiscoveredNode(service: BonjourServiceRecord): DiscoveredLanNode | null {
  const id = nodeKey(service)
  if (id === null) {
    return null
  }
  if (typeof service.name !== 'string' || service.name.length === 0) {
    return null
  }
  if (service.host !== undefined && typeof service.host !== 'string') {
    return null
  }
  if (
    service.addresses !== undefined &&
    (!Array.isArray(service.addresses) ||
      service.addresses.some((address) => typeof address !== 'string'))
  ) {
    return null
  }
  if (
    typeof service.port !== 'number' ||
    !Number.isInteger(service.port) ||
    service.port < 1 ||
    service.port > 65535
  ) {
    return null
  }
  const advertisement = decodeLanNodeTxt(service.txt ?? {})
  if (!advertisement) {
    return null
  }
  return {
    id,
    name: service.name,
    host: typeof service.host === 'string' ? service.host : null,
    addresses: Array.isArray(service.addresses) ? service.addresses : [],
    port: service.port,
    advertisement
  }
}

function sortNodes(nodes: Iterable<DiscoveredLanNode>): DiscoveredLanNode[] {
  return [...nodes].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  )
}

/**
 * Best-effort mDNS browse. Nodes that join during the wait arrive unordered;
 * the latest record for each instance wins and a goodbye removes it.
 */
export async function discoverLanNodes(
  timeoutMs: number,
  createBonjour: (onError: (error: unknown) => void) => Promise<DiscoveryBonjour> = createLanBonjour
): Promise<DiscoveredLanNode[]> {
  const nodes = new Map<string, DiscoveredLanNode>()
  let bonjour: DiscoveryBonjour | null = null
  let browser: DiscoveryBrowser | null = null
  let settled = false
  const cleanup = () => {
    if (settled) {
      return
    }
    settled = true
    try {
      browser?.stop()
    } finally {
      bonjour?.destroy()
    }
  }

  const applyRecord = (service: BonjourServiceRecord) => {
    try {
      const key = nodeKey(service)
      if (key === null) {
        return
      }
      const node = toDiscoveredNode(service)
      if (node) {
        nodes.set(key, node)
      } else {
        nodes.delete(key)
      }
    } catch {}
  }
  const removeRecord = (service: BonjourServiceRecord) => {
    try {
      const key = nodeKey(service)
      if (key !== null) {
        nodes.delete(key)
      }
    } catch {}
  }

  try {
    return await new Promise<DiscoveredLanNode[]>((resolve, reject) => {
      const timer = setTimeout(() => resolve(sortNodes(nodes.values())), timeoutMs)
      const fail = (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      createBonjour(fail)
        .then((created) => {
          if (settled) {
            created.destroy()
            return
          }
          bonjour = created
          try {
            browser = created.find({ type: LAN_NODE_SERVICE_NAME, protocol: 'tcp' }, applyRecord)
          } catch (error) {
            fail(error)
            return
          }
          browser.on('down', removeRecord)
          browser.on('txt-update', applyRecord)
          browser.on('srv-update', applyRecord)
        })
        .catch(fail)
    })
  } finally {
    cleanup()
  }
}
