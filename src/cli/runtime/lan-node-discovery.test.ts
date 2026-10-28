import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeLanNodeTxt,
  LAN_NODE_ADVERTISEMENT_VERSION,
  type LanNodeAdvertisement
} from '../../shared/lan-node-advertisement'
import { discoverLanNodes } from './lan-node-discovery'

function advertisement(overrides: Partial<LanNodeAdvertisement> = {}): LanNodeAdvertisement {
  return {
    v: LAN_NODE_ADVERTISEMENT_VERSION,
    name: 'node',
    platform: 'linux',
    arch: 'x64',
    orcaVersion: '1.4.240',
    caps: [],
    ...overrides
  }
}

type ServiceRecord = {
  fqdn?: string
  name?: string
  host?: string
  addresses?: unknown[]
  port?: number
  txt?: Record<string, unknown>
}

function serviceRecord(overrides: ServiceRecord = {}): ServiceRecord {
  return {
    fqdn: 'node._orca-node._tcp.local',
    name: 'node',
    host: 'node.local',
    addresses: ['192.168.1.5'],
    port: 6768,
    txt: encodeLanNodeTxt(advertisement()),
    ...overrides
  }
}

function fakeDiscovery() {
  const browser = Object.assign(new EventEmitter(), { stop: vi.fn() })
  let markStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const find = vi.fn((_options: { type: string }, onup: (service: ServiceRecord) => void) => {
    browser.on('up', onup)
    markStarted()
    return browser
  })
  const destroy = vi.fn()
  const bonjour = { find, destroy }
  let onError: ((error: unknown) => void) | undefined
  const create = vi.fn(async (errorCallback: (error: unknown) => void) => {
    onError = errorCallback
    return bonjour
  })
  return {
    browser,
    bonjour,
    find,
    destroy,
    create,
    started,
    emitError: (error: unknown) => onError?.(error)
  }
}

async function discoverWhile(
  fake: ReturnType<typeof fakeDiscovery>,
  act: () => void,
  timeoutMs = 100
) {
  const pending = discoverLanNodes(timeoutMs, fake.create)
  const outcome = pending.then(
    (nodes) => ({ ok: true as const, nodes }),
    (error) => ({ ok: false as const, error })
  )
  await fake.started
  act()
  await vi.advanceTimersByTimeAsync(timeoutMs)
  const result = await outcome
  if (!result.ok) {
    throw result.error
  }
  return result.nodes
}

describe('discoverLanNodes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('browses the short service name that resolves to _orca-node._tcp', async () => {
    const fake = fakeDiscovery()
    await discoverWhile(fake, () => {}, 50)
    expect(fake.find).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'orca-node', protocol: 'tcp' }),
      expect.any(Function)
    )
  })

  it('returns discovered nodes keyed by fqdn', async () => {
    const fake = fakeDiscovery()
    const nodes = await discoverWhile(fake, () => {
      fake.browser.emit('up', serviceRecord())
    })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({
      id: 'node._orca-node._tcp.local',
      name: 'node',
      host: 'node.local',
      addresses: ['192.168.1.5'],
      port: 6768
    })
    expect(nodes[0]?.advertisement.name).toBe('node')
  })

  it('keeps same-named instances on distinct fqdns', async () => {
    const fake = fakeDiscovery()
    const nodes = await discoverWhile(fake, () => {
      fake.browser.emit(
        'up',
        serviceRecord({ fqdn: 'node._orca-node._tcp.local', name: 'node', port: 6768 })
      )
      fake.browser.emit(
        'up',
        serviceRecord({ fqdn: 'node-2._orca-node._tcp.local', name: 'node', port: 6769 })
      )
    })
    expect(nodes.map((node) => node.id)).toEqual([
      'node-2._orca-node._tcp.local',
      'node._orca-node._tcp.local'
    ])
  })

  it('deduplicates a repeated up for the same instance', async () => {
    const fake = fakeDiscovery()
    const nodes = await discoverWhile(fake, () => {
      fake.browser.emit('up', serviceRecord())
      fake.browser.emit('up', serviceRecord({ addresses: ['192.168.1.9'] }))
    })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.addresses).toEqual(['192.168.1.9'])
  })

  it('replaces the record on txt-update', async () => {
    const fake = fakeDiscovery()
    const nodes = await discoverWhile(fake, () => {
      fake.browser.emit(
        'up',
        serviceRecord({ txt: encodeLanNodeTxt(advertisement({ pair: 'x' })) })
      )
      fake.browser.emit('txt-update', serviceRecord())
    })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.advertisement.pair).toBeUndefined()
  })

  it('replaces the record on srv-update', async () => {
    const fake = fakeDiscovery()
    const nodes = await discoverWhile(fake, () => {
      fake.browser.emit('up', serviceRecord())
      fake.browser.emit('srv-update', serviceRecord({ port: 7000 }))
    })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.port).toBe(7000)
  })

  it('drops the row when an update no longer decodes', async () => {
    const fake = fakeDiscovery()
    const nodes = await discoverWhile(fake, () => {
      fake.browser.emit('up', serviceRecord())
      fake.browser.emit('txt-update', serviceRecord({ txt: { v: '99', name: 'node' } }))
    })
    expect(nodes).toHaveLength(0)
  })

  it('removes the node on down', async () => {
    const fake = fakeDiscovery()
    const nodes = await discoverWhile(fake, () => {
      fake.browser.emit('up', serviceRecord())
      fake.browser.emit('down', serviceRecord())
    })
    expect(nodes).toHaveLength(0)
  })

  it.each([
    { label: 'a zero port', record: { port: 0 } },
    { label: 'a fractional port', record: { port: 6768.5 } },
    { label: 'an out-of-range port', record: { port: 70000 } },
    { label: 'a missing name', record: { name: undefined } },
    { label: 'a missing txt', record: { txt: undefined } },
    { label: 'undecodable txt', record: { txt: { v: '2', name: 'node' } } },
    { label: 'non-string addresses', record: { addresses: [42] } }
  ])('ignores a record with $label without losing valid peers', async ({ record }) => {
    const fake = fakeDiscovery()
    const nodes = await discoverWhile(fake, () => {
      fake.browser.emit(
        'up',
        serviceRecord({
          fqdn: 'good._orca-node._tcp.local',
          name: 'good',
          port: 6768
        })
      )
      fake.browser.emit(
        'up',
        serviceRecord({ fqdn: 'bad._orca-node._tcp.local', name: 'bad', ...record })
      )
    })
    expect(nodes.map((node) => node.name)).toEqual(['good'])
  })

  it('keys nodes without an fqdn on a deterministic composite', async () => {
    const fake = fakeDiscovery()
    const nodes = await discoverWhile(fake, () => {
      fake.browser.emit(
        'up',
        serviceRecord({ fqdn: undefined, addresses: ['192.168.1.7', '192.168.1.5'] })
      )
      fake.browser.emit(
        'up',
        serviceRecord({ fqdn: undefined, addresses: ['192.168.1.5', '192.168.1.7'] })
      )
    })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.id).toContain('node')
  })

  it('stops the browser and destroys bonjour exactly once on timeout', async () => {
    const fake = fakeDiscovery()
    await discoverWhile(fake, () => {}, 50)
    expect(fake.browser.stop).toHaveBeenCalledTimes(1)
    expect(fake.destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects when bonjour creation fails', async () => {
    const create = vi.fn(async (_onError: (error: unknown) => void) => {
      throw new Error('mdns gone')
    })
    await expect(discoverLanNodes(50, create)).rejects.toThrow('mdns gone')
  })

  it('rejects and destroys bonjour when find throws', async () => {
    const fake = fakeDiscovery()
    fake.find.mockImplementation(() => {
      throw new Error('find exploded')
    })
    await expect(discoverLanNodes(50, fake.create)).rejects.toThrow('find exploded')
    expect(fake.destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects on an asynchronous multicast error and cleans up once', async () => {
    const fake = fakeDiscovery()
    const pending = discoverWhile(fake, () => {
      fake.emitError(new Error('EACCES'))
    })
    await expect(pending).rejects.toThrow('EACCES')
    expect(fake.browser.stop).toHaveBeenCalledTimes(1)
    expect(fake.destroy).toHaveBeenCalledTimes(1)
  })

  it('sorts nodes by name then id', async () => {
    const fake = fakeDiscovery()
    const nodes = await discoverWhile(fake, () => {
      fake.browser.emit(
        'up',
        serviceRecord({ fqdn: 'zed._orca-node._tcp.local', name: 'zed', port: 6768 })
      )
      fake.browser.emit(
        'up',
        serviceRecord({ fqdn: 'b._orca-node._tcp.local', name: 'alpha', port: 6769 })
      )
      fake.browser.emit(
        'up',
        serviceRecord({ fqdn: 'a._orca-node._tcp.local', name: 'alpha', port: 6768 })
      )
    })
    expect(nodes.map((node) => node.id)).toEqual([
      'a._orca-node._tcp.local',
      'b._orca-node._tcp.local',
      'zed._orca-node._tcp.local'
    ])
  })
})
