import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { RuntimeClient } from '../cli/runtime/client'
import type { EmulatorDevice } from '../main/emulator/backends/emulator-backend'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee-crypto'
import { encodePairingOffer } from './pairing'
import { RUNTIME_PROTOCOL_VERSION } from './protocol-version'
import { addEnvironmentFromPairingCode } from './runtime-environment-store'
import { verifyRuntimePairingCode } from './runtime-pairing-verification'
import { CLI_CLIENT_CAPABILITIES } from '../cli/runtime/websocket-transport'
import { AxParams, EmulatorListDevicesParams } from './rpc-contract/emulator-params'

const HelloFrame = z.object({
  type: z.literal('e2ee_hello'),
  publicKeyB64: z.string()
})
const AuthFrame = z.object({ type: z.literal('e2ee_auth'), deviceToken: z.string() })
const RequestFrame = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown().optional()
})

type SimulatedPeer = {
  wss: WebSocketServer
  code: string
  devices: EmulatorDevice[]
  requests: { id: string; method: string; params?: unknown }[]
  close: () => Promise<void>
}

const servers: WebSocketServer[] = []
const stores: string[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.close()
          }
          server.close(() => resolve())
        })
    )
  )
  for (const store of stores.splice(0)) {
    rmSync(store, { recursive: true, force: true })
  }
})

async function createPeer(marker: string, extraDeviceId: string): Promise<SimulatedPeer> {
  const serverKeyPair = generateKeyPair()
  const runtimeId = `runtime-${marker}`
  const deviceToken = `token-${marker}`
  const devices: EmulatorDevice[] = [
    {
      backend: 'android',
      id: 'shared-serial',
      name: `Galaxy-${marker}`,
      state: 'booted',
      detail: 'device',
      isAvailable: true
    },
    {
      backend: 'android',
      id: extraDeviceId,
      name: `Only-${marker}`,
      state: 'booted',
      detail: 'device',
      isAvailable: true
    }
  ]
  const requests: SimulatedPeer['requests'] = []
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(wss)

  const sendEncrypted = (ws: WebSocket, sharedKey: Uint8Array, message: unknown): void => {
    ws.send(encrypt(JSON.stringify(message), sharedKey))
  }

  wss.on('connection', (ws: WebSocket) => {
    let sharedKey: Uint8Array | null = null
    let authenticated = false

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        return
      }
      const frame = data.toString()
      if (!sharedKey) {
        const hello = HelloFrame.safeParse(JSON.parse(frame))
        if (!hello.success) {
          ws.close()
          return
        }
        sharedKey = deriveSharedKey(
          serverKeyPair.secretKey,
          publicKeyFromBase64(hello.data.publicKeyB64)
        )
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      const plaintext = decrypt(frame, sharedKey)
      if (plaintext === null) {
        return
      }
      if (!authenticated) {
        const auth = AuthFrame.safeParse(JSON.parse(plaintext))
        if (!auth.success || auth.data.deviceToken !== deviceToken) {
          ws.close()
          return
        }
        authenticated = true
        sendEncrypted(ws, sharedKey, { type: 'e2ee_authenticated' })
        return
      }
      const request = RequestFrame.safeParse(JSON.parse(plaintext))
      if (!request.success) {
        return
      }
      const { id, method } = request.data
      const params = request.data.params
      requests.push({ id, method, params })

      if (method === 'status.get') {
        sendEncrypted(ws, sharedKey, {
          id,
          ok: true,
          result: {
            runtimeId,
            rendererGraphEpoch: 0,
            graphStatus: 'ready',
            authoritativeWindowId: null,
            liveTabCount: 0,
            liveLeafCount: 0,
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION
          },
          _meta: { runtimeId }
        })
        return
      }
      if (method === 'emulator.listDevices') {
        if (!EmulatorListDevicesParams.safeParse(params ?? {}).success) {
          sendEncrypted(ws, sharedKey, {
            id,
            ok: false,
            error: { code: 'invalid_argument', message: 'invalid listDevices params' }
          })
          return
        }
        sendEncrypted(ws, sharedKey, { id, ok: true, result: devices, _meta: { runtimeId } })
        return
      }
      if (method === 'emulator.ax') {
        const ax = AxParams.safeParse(params)
        const selected = ax.success ? devices.find((d) => d.id === ax.data.device) : undefined
        if (!ax.success || !selected) {
          sendEncrypted(ws, sharedKey, {
            id,
            ok: false,
            error: {
              code: 'invalid_argument',
              message: ax.success ? `Unknown device: ${ax.data.device}` : 'invalid ax params'
            }
          })
          return
        }
        sendEncrypted(ws, sharedKey, {
          id,
          ok: true,
          result: { device: selected.id, name: selected.name },
          _meta: { runtimeId }
        })
        return
      }
      sendEncrypted(ws, sharedKey, {
        id,
        ok: false,
        error: { code: 'invalid_argument', message: `unsupported method ${method}` }
      })
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not report a port')
  }
  const code = encodePairingOffer({
    v: 2,
    endpoint: `ws://127.0.0.1:${address.port}`,
    deviceToken,
    publicKeyB64: publicKeyToBase64(serverKeyPair.publicKey)
  })

  return {
    wss,
    code,
    devices,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.close()
        }
        wss.close(() => resolve())
      })
  }
}

function tempStore(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-lan-peer-store-'))
  stores.push(path)
  return path
}

describe('verified LAN pairing across two hosts', () => {
  it('routes device RPCs to the right host and device, then survives a peer stop', async () => {
    const peerA = await createPeer('PEER_A', 'only-a')
    const peerB = await createPeer('PEER_B', 'only-b')
    const store = tempStore()

    const verifiedA = await verifyRuntimePairingCode(peerA.code, {
      allowLoopback: true,
      clientCapabilities: CLI_CLIENT_CAPABILITIES
    })
    expect(verifiedA.ok).toBe(true)
    const verifiedB = await verifyRuntimePairingCode(peerB.code, {
      allowLoopback: true,
      clientCapabilities: CLI_CLIENT_CAPABILITIES
    })
    expect(verifiedB.ok).toBe(true)

    addEnvironmentFromPairingCode(store, { name: 'peer-a', pairingCode: peerA.code })
    addEnvironmentFromPairingCode(store, { name: 'peer-b', pairingCode: peerB.code })

    const clientA = new RuntimeClient(store, 5_000, null, 'peer-a')
    const clientB = new RuntimeClient(store, 5_000, null, 'peer-b')

    const listA = await clientA.call('emulator.listDevices', {})
    expect(listA.result).toEqual(peerA.devices)
    const axSharedA = await clientA.call('emulator.ax', { device: 'shared-serial' })
    expect(axSharedA.result).toEqual({ device: 'shared-serial', name: 'Galaxy-PEER_A' })
    const axOnlyA = await clientA.call('emulator.ax', { device: 'only-a' })
    expect(axOnlyA.result).toEqual({ device: 'only-a', name: 'Only-PEER_A' })

    const listB = await clientB.call('emulator.listDevices', {})
    expect(listB.result).toEqual(peerB.devices)
    const axOnlyB = await clientB.call('emulator.ax', { device: 'only-b' })
    expect(axOnlyB.result).toEqual({ device: 'only-b', name: 'Only-PEER_B' })

    await expect(clientA.call('emulator.ax', { device: 'only-b' })).rejects.toThrow()
    expect(peerA.requests).toContainEqual(
      expect.objectContaining({ method: 'emulator.ax', params: { device: 'only-b' } })
    )
    expect(
      peerB.requests
        .filter((request) => request.method === 'emulator.ax')
        .map((request) =>
          typeof request.params === 'object' &&
          request.params !== null &&
          'device' in request.params
            ? request.params.device
            : undefined
        )
    ).toEqual(['only-b'])

    expect(peerA.requests.map((request) => request.method)).toEqual(
      expect.arrayContaining(['status.get', 'emulator.listDevices', 'emulator.ax'])
    )
    expect(peerB.requests.map((request) => request.method)).toEqual(
      expect.arrayContaining(['status.get', 'emulator.listDevices', 'emulator.ax'])
    )

    await peerA.close()
    const stillB = await clientB.call('emulator.ax', { device: 'shared-serial' })
    expect(stillB.result).toEqual({ device: 'shared-serial', name: 'Galaxy-PEER_B' })
  })
})
