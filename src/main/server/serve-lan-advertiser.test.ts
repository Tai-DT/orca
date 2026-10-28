import { Service } from 'bonjour-service'
import { describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { decodeLanNodeTxt } from '../../shared/lan-node-advertisement'
import { encodePairingOffer } from '../../shared/pairing'
import {
  buildLanNodeAdvertisement,
  startServeLanAdvertiser,
  type LanAdvertiseBonjour,
  type ServeLanAdvertiseInput
} from './serve-lan-advertiser'

const pairingKeyPair = generateKeyPair()
const pairingPublicKey = publicKeyToBase64(pairingKeyPair.publicKey)

function pairingUrlFor(endpoint: string, scope?: 'runtime' | 'mobile'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: pairingPublicKey,
    ...(scope ? { scope } : {})
  })
}

const lanPairingUrl = pairingUrlFor('ws://192.168.1.5:6768')

const readiness = {
  runtimeId: 'rt-1',
  boundEndpoint: 'ws://0.0.0.0:6768',
  pairing: {
    available: true as const,
    url: lanPairingUrl,
    endpoint: 'ws://192.168.1.5:6768',
    deviceId: 'dev-1',
    webClientUrl: null,
    scope: 'runtime' as const,
    qr: null
  }
}

function input(overrides: Partial<ServeLanAdvertiseInput> = {}): ServeLanAdvertiseInput {
  return {
    advertise: true,
    advertisePair: false,
    readiness,
    version: '1.4.240',
    ...overrides
  }
}

function fakeBonjour() {
  const service = { stop: vi.fn((callback?: () => void) => callback?.()) }
  const publish = vi.fn((_options: Parameters<LanAdvertiseBonjour['publish']>[0]) => service)
  const destroy = vi.fn()
  const bonjour: LanAdvertiseBonjour = { publish, destroy }
  let onError: ((error: unknown) => void) | undefined
  const create = vi.fn(async (errorCallback: (error: unknown) => void) => {
    onError = errorCallback
    return bonjour
  })
  return { bonjour, service, publish, destroy, create, emitError: (e: unknown) => onError?.(e) }
}

describe('startServeLanAdvertiser', () => {
  it('returns null without publishing when advertise is off', async () => {
    const { publish, create } = fakeBonjour()
    const advertiser = await startServeLanAdvertiser(input({ advertise: false }), create)
    expect(advertiser).toBeNull()
    expect(publish).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('publishes a real bonjour service on the canonical _orca-node._tcp type', async () => {
    const { publish, create } = fakeBonjour()
    const advertiser = await startServeLanAdvertiser(input({ name: 'mac-mini' }), create)
    expect(advertiser?.nodeName).toBe('mac-mini')
    const options = publish.mock.calls[0]![0]
    // bonjour-service derives the DNS type; the short service name must not double-prefix it.
    const service = new Service(
      options,
      () => {},
      () => {}
    )
    expect(service.type).toBe('_orca-node._tcp')
    expect(service.fqdn).toBe('mac-mini._orca-node._tcp.local')
    expect(decodeLanNodeTxt(options.txt)).toMatchObject({ name: 'mac-mini', v: 1 })
  })

  it('publishes the bound endpoint port', async () => {
    const { publish, create } = fakeBonjour()
    await startServeLanAdvertiser(input(), create)
    expect(publish.mock.calls[0]![0].port).toBe(6768)
  })

  it.each([
    { boundEndpoint: 'ws://0.0.0.0', expectedPort: 80 },
    { boundEndpoint: 'wss://0.0.0.0', expectedPort: 443 },
    { boundEndpoint: 'wss://0.0.0.0:8443', expectedPort: 8443 }
  ])('uses the effective port of $boundEndpoint', async ({ boundEndpoint, expectedPort }) => {
    const { publish, create } = fakeBonjour()
    await startServeLanAdvertiser(input({ readiness: { ...readiness, boundEndpoint } }), create)
    expect(publish.mock.calls[0]![0].port).toBe(expectedPort)
  })

  it('skips an endpoint that is not a WebSocket URL', async () => {
    const warn = vi.fn()
    const advertiser = await startServeLanAdvertiser(
      input({ warn, readiness: { ...readiness, boundEndpoint: 'http://0.0.0.0:6768' } }),
      fakeBonjour().create
    )
    expect(advertiser).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WebSocket'))
  })

  it('embeds a reachable pairing offer only with advertise-pair', async () => {
    const { publish, create } = fakeBonjour()
    await startServeLanAdvertiser(input({ advertisePair: true }), create)
    const txt = publish.mock.calls[0]![0].txt
    expect(decodeLanNodeTxt(txt)?.pair).toBe(lanPairingUrl)
  })

  it('warns that advertise-pair broadcasts the offer on a trusted-network boundary', async () => {
    const warn = vi.fn()
    await startServeLanAdvertiser(input({ advertisePair: true, warn }), fakeBonjour().create)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trusted'))
  })

  it('omits the pairing payload when pairing is unavailable', async () => {
    const { publish, create } = fakeBonjour()
    await startServeLanAdvertiser(
      input({
        advertisePair: true,
        readiness: {
          ...readiness,
          pairing: { available: false, reason: 'disabled_by_operator', guidance: 'g' }
        }
      }),
      create
    )
    expect(decodeLanNodeTxt(publish.mock.calls[0]![0].txt)?.pair).toBeUndefined()
  })

  it('still advertises metadata without a pair payload for the default loopback link', async () => {
    const warn = vi.fn()
    const { publish, create } = fakeBonjour()
    const loopbackPairing = {
      ...readiness.pairing,
      url: pairingUrlFor('ws://127.0.0.1:6768'),
      endpoint: 'ws://127.0.0.1:6768'
    }
    const advertiser = await startServeLanAdvertiser(
      input({
        advertisePair: true,
        warn,
        readiness: { ...readiness, pairing: loopbackPairing }
      }),
      create
    )
    expect(advertiser).not.toBeNull()
    const advertisement = decodeLanNodeTxt(publish.mock.calls[0]![0].txt)
    expect(advertisement?.pair).toBeUndefined()
    expect(advertisement?.name).toBeTruthy()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--pairing-address'))
  })

  it.each([
    { label: 'invalid', url: 'not-a-pairing-link' },
    { label: 'wildcard', url: pairingUrlFor('ws://0.0.0.0:6768') },
    { label: 'mobile-only', url: pairingUrlFor('ws://192.168.1.5:6768', 'mobile') }
  ])('omits the pairing payload for a $label link but still advertises', async ({ url }) => {
    const warn = vi.fn()
    const { publish, create } = fakeBonjour()
    const advertiser = await startServeLanAdvertiser(
      input({
        advertisePair: true,
        warn,
        readiness: { ...readiness, pairing: { ...readiness.pairing, url } }
      }),
      create
    )
    expect(advertiser).not.toBeNull()
    expect(decodeLanNodeTxt(publish.mock.calls[0]![0].txt)?.pair).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('skips a loopback-bound endpoint with a warning', async () => {
    const warn = vi.fn()
    const advertiser = await startServeLanAdvertiser(
      input({
        warn,
        readiness: { ...readiness, boundEndpoint: 'ws://127.0.0.1:6768' }
      }),
      fakeBonjour().create
    )
    expect(advertiser).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot reach'))
  })

  it('refuses an instance name that cannot fit a DNS label', async () => {
    const warn = vi.fn()
    const { publish, create } = fakeBonjour()
    const advertiser = await startServeLanAdvertiser(input({ warn, name: 'n'.repeat(64) }), create)
    expect(advertiser).toBeNull()
    expect(publish).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('63'))
  })

  it('returns null and destroys bonjour when the error callback fires during creation', async () => {
    const warn = vi.fn()
    const destroy = vi.fn()
    const publish = vi.fn()
    const create = async (onError: (error: unknown) => void) => {
      onError(new Error('EACCES early'))
      return { publish, destroy }
    }
    const advertiser = await startServeLanAdvertiser(input({ warn }), create)
    expect(advertiser).toBeNull()
    expect(publish).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('stops the published service when the error callback fires during publish', async () => {
    const warn = vi.fn()
    const destroy = vi.fn()
    const service = { stop: vi.fn((callback?: () => void) => callback?.()) }
    const create = async (onError: (error: unknown) => void) => ({
      publish: vi.fn(() => {
        onError(new Error('mid-publish'))
        return service
      }),
      destroy
    })
    const advertiser = await startServeLanAdvertiser(input({ warn }), create)
    expect(advertiser).toBeNull()
    expect(service.stop).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('warns instead of throwing when bonjour fails', async () => {
    const warn = vi.fn()
    const advertiser = await startServeLanAdvertiser(input({ warn }), async () => {
      throw new Error('multicast unavailable')
    })
    expect(advertiser).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('multicast unavailable'))
  })

  it('destroys bonjour when publish throws', async () => {
    const warn = vi.fn()
    const destroy = vi.fn()
    const create = async (_onError: (error: unknown) => void) => ({
      publish: () => {
        throw new Error('publish blew up')
      },
      destroy
    })
    const advertiser = await startServeLanAdvertiser(input({ warn }), create)
    expect(advertiser).toBeNull()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('publish blew up'))
  })

  it('warns and stops advertising on an asynchronous multicast error, without the offer', async () => {
    const warn = vi.fn()
    const fake = fakeBonjour()
    const advertiser = await startServeLanAdvertiser(
      input({ advertisePair: true, warn }),
      fake.create
    )
    expect(advertiser).not.toBeNull()
    fake.emitError(new Error('EACCES multicast'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
    const warnings = warn.mock.calls.map(([message]) => String(message)).join('\n')
    expect(warnings).not.toContain(lanPairingUrl)
    expect(fake.service.stop).toHaveBeenCalledTimes(1)
    expect(fake.destroy).toHaveBeenCalledTimes(1)
  })

  it('waits for the goodbye callback before destroying and stops only once', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeBonjour()
      let finishStop: (() => void) | undefined
      fake.service.stop.mockImplementation((callback) => {
        finishStop = callback
      })
      const advertiser = await startServeLanAdvertiser(input(), fake.create)
      expect(advertiser).not.toBeNull()
      advertiser?.stop()
      advertiser?.stop()
      expect(fake.service.stop).toHaveBeenCalledTimes(1)
      expect(fake.destroy).not.toHaveBeenCalled()

      expect(finishStop).toBeTypeOf('function')
      finishStop?.()
      expect(fake.destroy).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(fake.destroy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('destroys after the goodbye deadline and ignores a late callback', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeBonjour()
      let finishStop: (() => void) | undefined
      fake.service.stop.mockImplementation((callback) => {
        finishStop = callback
      })
      const advertiser = await startServeLanAdvertiser(input(), fake.create)
      expect(advertiser).not.toBeNull()
      advertiser?.stop()
      await vi.advanceTimersByTimeAsync(499)
      expect(fake.destroy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(fake.destroy).toHaveBeenCalledTimes(1)
      expect(finishStop).toBeTypeOf('function')
      finishStop?.()
      advertiser?.stop()
      expect(fake.service.stop).toHaveBeenCalledTimes(1)
      expect(fake.destroy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('buildLanNodeAdvertisement', () => {
  it('reports the supported platform and runtime capabilities', () => {
    const ad = buildLanNodeAdvertisement({
      name: 'win-box',
      version: '1.4.240',
      platform: 'win32',
      arch: 'x64',
      runtimeId: 'rt-9',
      grantDesktopControl: true
    })
    expect(ad).toMatchObject({
      v: 1,
      name: 'win-box',
      platform: 'win32',
      arch: 'x64',
      runtimeId: 'rt-9',
      caps: ['runtime', 'desktop-control']
    })
  })
})
