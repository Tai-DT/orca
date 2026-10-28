import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from './e2ee-crypto'
import { encodePairingOffer } from './pairing'
import { RUNTIME_PROTOCOL_VERSION, type RuntimeCapability } from './protocol-version'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { verifyRuntimePairingCode } from './runtime-pairing-verification'

const { sendRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  sendRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('./remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock
}))

const serverKeyPair = generateKeyPair()

function pairingCodeFor(endpoint: string, scope?: 'runtime' | 'mobile'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: publicKeyToBase64(serverKeyPair.publicKey),
    ...(scope ? { scope } : {})
  })
}

const lanCode = pairingCodeFor('ws://192.168.1.10:6768')

function runtimeStatus(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: 'runtime-remote',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    ...overrides
  }
}

describe('verifyRuntimePairingCode', () => {
  beforeEach(() => {
    sendRemoteRuntimeRequestMock.mockReset()
  })

  it.each([
    { label: 'an unparseable link', code: 'not-a-link' },
    { label: 'a mobile-only link', code: pairingCodeFor('ws://192.168.1.10:6768', 'mobile') },
    { label: 'a wildcard destination', code: pairingCodeFor('ws://0.0.0.0:6768') },
    { label: 'a non-WebSocket destination', code: pairingCodeFor('http://192.168.1.10:6768') }
  ])('rejects $label before dialing', async ({ code }) => {
    const result = await verifyRuntimePairingCode(code)
    expect(result.ok).toBe(false)
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })

  it('rejects a loopback link without an explicit opt-in', async () => {
    const result = await verifyRuntimePairingCode(pairingCodeFor('ws://127.0.0.1:6768'))
    expect(result).toMatchObject({ ok: false, kind: 'host-unreachable' })
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })

  it('dials a loopback link only with an explicit opt-in', async () => {
    sendRemoteRuntimeRequestMock.mockResolvedValueOnce({
      id: 'r1',
      ok: true,
      result: runtimeStatus(),
      _meta: { runtimeId: 'runtime-remote' }
    })
    const result = await verifyRuntimePairingCode(pairingCodeFor('ws://127.0.0.1:6768'), {
      allowLoopback: true
    })
    expect(result.ok).toBe(true)
    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledOnce()
  })

  it('verifies a reachable host and returns its status', async () => {
    sendRemoteRuntimeRequestMock.mockResolvedValueOnce({
      id: 'r1',
      ok: true,
      result: runtimeStatus(),
      _meta: { runtimeId: 'runtime-remote' }
    })
    const result = await verifyRuntimePairingCode(lanCode)
    expect(result).toMatchObject({
      ok: true,
      link: expect.objectContaining({ endpointKind: 'lan' }),
      runtimeStatus: expect.objectContaining({ runtimeId: 'runtime-remote' })
    })
    const [connection, method, params, timeoutMs] = sendRemoteRuntimeRequestMock.mock.calls[0]!
    expect(connection).toMatchObject({ endpoint: 'ws://192.168.1.10:6768' })
    expect(method).toBe('status.get')
    expect(params).toBeUndefined()
    expect(timeoutMs).toBe(15_000)
  })

  it('forwards the requested timeout and client capabilities', async () => {
    sendRemoteRuntimeRequestMock.mockResolvedValueOnce({
      id: 'r1',
      ok: true,
      result: runtimeStatus(),
      _meta: { runtimeId: 'runtime-remote' }
    })
    const capabilities: RuntimeCapability[] = ['test-capability.v1']
    await verifyRuntimePairingCode(lanCode, {
      timeoutMs: 1_234,
      clientCapabilities: capabilities
    })
    const call = sendRemoteRuntimeRequestMock.mock.calls[0]!
    expect(call[3]).toBe(1_234)
    expect(call[6]).toBe(capabilities)
  })

  it('reports an incompatible runtime as protocol-incompatible', async () => {
    sendRemoteRuntimeRequestMock.mockResolvedValueOnce({
      id: 'r1',
      ok: true,
      result: runtimeStatus({ runtimeProtocolVersion: 0 }),
      _meta: { runtimeId: 'runtime-remote' }
    })
    const result = await verifyRuntimePairingCode(lanCode)
    expect(result).toMatchObject({ ok: false, kind: 'protocol-incompatible' })
  })

  it('accepts a compatible independently-versioned runtime', async () => {
    sendRemoteRuntimeRequestMock.mockResolvedValueOnce({
      id: 'r1',
      ok: true,
      result: runtimeStatus({ runtimeProtocolVersion: 999_999 }),
      _meta: { runtimeId: 'runtime-remote' }
    })
    const result = await verifyRuntimePairingCode(lanCode)
    expect(result.ok).toBe(true)
  })

  it('maps a failed response to connection-interrupted', async () => {
    sendRemoteRuntimeRequestMock.mockResolvedValueOnce({
      id: 'r1',
      ok: false,
      error: { code: 'runtime_error', message: 'status exploded' }
    })
    const result = await verifyRuntimePairingCode(lanCode)
    expect(result).toMatchObject({
      ok: false,
      kind: 'connection-interrupted',
      message: 'status exploded'
    })
  })

  it.each([
    {
      label: 'host identity',
      error: new RemoteRuntimeClientError('forbidden', 'key mismatch', {
        pairingStage: 'host-identity'
      }),
      kind: 'host-identity-mismatch'
    },
    {
      label: 'access grant',
      error: new RemoteRuntimeClientError('unauthorized', 'denied', {
        pairingStage: 'access-grant'
      }),
      kind: 'access-link-invalid'
    },
    {
      label: 'unauthorized code',
      error: new RemoteRuntimeClientError('unauthorized', 'denied'),
      kind: 'access-link-invalid'
    },
    {
      label: 'invalid_argument code',
      error: new RemoteRuntimeClientError('invalid_argument', 'bad offer'),
      kind: 'access-link-invalid'
    },
    {
      label: 'runtime stage',
      error: new RemoteRuntimeClientError('runtime_error', 'went away', {
        pairingStage: 'runtime'
      }),
      kind: 'connection-interrupted'
    },
    {
      label: 'connect stage',
      error: new RemoteRuntimeClientError('unreachable', 'refused', {
        pairingStage: 'connect'
      }),
      kind: 'host-unreachable'
    },
    {
      label: 'invalid public key',
      error: new Error('Invalid public key bytes'),
      kind: 'access-link-invalid'
    },
    { label: 'a generic error', error: new Error('boom'), kind: 'connection-interrupted' },
    { label: 'a non-error', error: 'string failure', kind: 'host-unreachable' }
  ])('classifies $label as $kind', async ({ error, kind }) => {
    sendRemoteRuntimeRequestMock.mockRejectedValueOnce(error)
    const result = await verifyRuntimePairingCode(lanCode)
    expect(result).toMatchObject({ ok: false, kind })
  })
})
