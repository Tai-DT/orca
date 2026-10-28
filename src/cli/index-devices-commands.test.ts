import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, publicKeyToBase64 } from '../shared/e2ee-crypto'
import {
  LAN_NODE_ADVERTISEMENT_VERSION,
  type LanNodeAdvertisement
} from '../shared/lan-node-advertisement'
import { encodePairingOffer } from '../shared/pairing'
import { escapeTerminalControlCharacters } from '../shared/terminal-control-character-escape'
import { parseHostAccessLink } from '../shared/remote-pairing-address'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  spawnMock,
  discoverLanNodesMock,
  verifyRuntimePairingCodeMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  spawnMock: vi.fn(),
  discoverLanNodesMock: vi.fn(),
  verifyRuntimePairingCodeMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/lan-node-discovery', () => ({
  discoverLanNodes: discoverLanNodesMock
}))

vi.mock('../shared/runtime-pairing-verification', () => ({
  verifyRuntimePairingCode: verifyRuntimePairingCodeMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments
} from './runtime/environments'

const hostKeyPair = generateKeyPair()
const hostPublicKey = publicKeyToBase64(hostKeyPair.publicKey)

function pairingCodeFor(
  endpoint: string,
  token = 'SENTINEL_TOKEN',
  publicKeyB64 = hostPublicKey
): string {
  return encodePairingOffer({ v: 2, endpoint, deviceToken: token, publicKeyB64 })
}

const lanCode = pairingCodeFor('ws://192.168.1.5:6768')

function advertisement(overrides: Partial<LanNodeAdvertisement> = {}): LanNodeAdvertisement {
  return {
    v: LAN_NODE_ADVERTISEMENT_VERSION,
    name: 'node',
    platform: 'linux',
    arch: 'x64',
    orcaVersion: '1.4.240',
    caps: ['runtime'],
    ...overrides
  }
}

function discoveredNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'node._orca-node._tcp.local',
    name: 'node',
    host: 'node.local',
    addresses: ['192.168.1.5'],
    port: 6768,
    advertisement: advertisement({ pair: lanCode }),
    ...overrides
  }
}

function verifiedSuccess(code: string) {
  const parsed = parseHostAccessLink(code)
  if (!parsed.ok) {
    throw new Error(`test pairing code did not parse: ${parsed.message}`)
  }
  return {
    ok: true as const,
    link: parsed.value,
    runtimeStatus: {
      runtimeId: 'runtime-remote',
      rendererGraphEpoch: 1,
      graphStatus: 'ready' as const,
      authoritativeWindowId: 1,
      liveTabCount: 0,
      liveLeafCount: 0
    }
  }
}

let userDataPath: string
let consoleLog: ReturnType<typeof vi.spyOn>
let consoleError: ReturnType<typeof vi.spyOn>

function stdout(): string {
  return consoleLog.mock.calls.map(([line]) => String(line)).join('\n')
}

function stderr(): string {
  return consoleError.mock.calls.map(([line]) => String(line)).join('\n')
}

const priorExitCode = process.exitCode

describe('orca devices', () => {
  beforeEach(() => {
    process.exitCode = undefined
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-devices-cli-'))
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)
    callMock.mockReset()
    runtimeClientConstructorMock.mockReset()
    serveOrcaAppMock.mockReset()
    spawnMock.mockClear()
    discoverLanNodesMock.mockReset()
    verifyRuntimePairingCodeMock.mockReset()
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.exitCode = priorExitCode
    consoleLog.mockRestore()
    consoleError.mockRestore()
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  describe('discover', () => {
    it('lists public node fields without the pairing payload', async () => {
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode(),
        discoveredNode({
          id: 'plain._orca-node._tcp.local',
          name: 'plain',
          advertisement: advertisement()
        })
      ])

      await main(['devices', 'discover', '--json'], '/tmp/repo')

      const payload = JSON.parse(stdout())
      expect(payload.result.nodes).toHaveLength(2)
      expect(payload.result.nodes[0]).toMatchObject({
        id: 'node._orca-node._tcp.local',
        name: 'node',
        platform: 'linux',
        arch: 'x64',
        orcaVersion: '1.4.240',
        host: 'node.local',
        addresses: ['192.168.1.5'],
        port: 6768,
        pairable: true,
        caps: ['runtime']
      })
      expect(payload.result.nodes[1]).toMatchObject({ name: 'plain', pairable: false })
      for (const node of payload.result.nodes) {
        expect(node).not.toHaveProperty('advertisement')
        expect(node).not.toHaveProperty('pair')
      }
      const printed = stdout()
      expect(printed).not.toContain('SENTINEL_TOKEN')
      expect(printed).not.toContain(hostPublicKey)
      expect(printed).not.toContain('orca://pair')
    })

    it('keeps the useful empty output', async () => {
      discoverLanNodesMock.mockResolvedValue([])

      await main(['devices', 'discover'], '/tmp/repo')

      expect(stdout()).toContain('No Orca nodes discovered')
    })

    it('brackets IPv6 addresses in human output', async () => {
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode({ addresses: ['fd00::5'], advertisement: advertisement() })
      ])

      await main(['devices', 'discover'], '/tmp/repo')

      expect(stdout()).toContain('[fd00::5]:6768')
    })

    it('never surfaces the advertised link in human output either', async () => {
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])

      await main(['devices', 'discover'], '/tmp/repo')

      expect(stdout()).not.toContain('SENTINEL_TOKEN')
      expect(stdout()).not.toContain('orca://pair')
    })

    it('escapes control bytes in human output but keeps raw JSON values', async () => {
      const hostile = 'evil\x1b[2J\x07\nsecond-line'
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode({
          id: 'evil\x1b[1G._orca-node._tcp.local',
          name: hostile,
          host: 'h\x9Bj',
          addresses: ['10.0.0.1'],
          advertisement: advertisement({ name: hostile, caps: ['cap\x1bX'], orcaVersion: '1\x80' })
        })
      ])

      await main(['devices', 'discover'], '/tmp/repo')
      expect(stdout()).toBe(escapeTerminalControlCharacters(stdout(), true))
      expect(stdout().split('\n')).toHaveLength(1)

      consoleLog.mockClear()
      await main(['devices', 'discover', '--json'], '/tmp/repo')
      const payload = JSON.parse(stdout())
      expect(payload.result.nodes[0].name).toBe(hostile)
      expect(stdout()).not.toContain('SENTINEL_TOKEN')
    })

    it('stays local even with ambient remote selection', async () => {
      vi.stubEnv('ORCA_ENVIRONMENT', 'somewhere-else')
      vi.stubEnv('ORCA_PAIRING_CODE', 'orca://pair?code=ambient')
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])

      await main(['devices', 'discover', '--json'], '/tmp/repo')

      expect(process.exitCode).toBeUndefined()
      expect(discoverLanNodesMock).toHaveBeenCalledOnce()
      expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
    })
  })

  describe('add', () => {
    it('verifies the advertised offer, then saves and reports', async () => {
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])
      verifyRuntimePairingCodeMock.mockImplementation(async (code: string) => verifiedSuccess(code))

      await main(['devices', 'add', '--name', 'node'], '/tmp/repo')

      expect(verifyRuntimePairingCodeMock).toHaveBeenCalledWith(
        lanCode,
        expect.objectContaining({ clientCapabilities: expect.any(Array) })
      )
      const environments = listEnvironments(userDataPath)
      expect(environments).toHaveLength(1)
      expect(environments[0]).toMatchObject({ name: 'node' })
      expect(stdout()).toContain('Paired')
    })

    it('never writes the store before verification resolves', async () => {
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])
      let resolveVerify: (value: ReturnType<typeof verifiedSuccess>) => void = () => {}
      verifyRuntimePairingCodeMock.mockReturnValue(
        new Promise((resolve) => {
          resolveVerify = resolve
        })
      )

      const pending = main(['devices', 'add', '--name', 'node'], '/tmp/repo')
      await vi.waitFor(() => expect(verifyRuntimePairingCodeMock).toHaveBeenCalled())
      expect(existsSync(getEnvironmentStorePath(userDataPath))).toBe(false)

      resolveVerify(verifiedSuccess(lanCode))
      await pending

      expect(listEnvironments(userDataPath)).toHaveLength(1)
    })

    it('emits no secret material in JSON output', async () => {
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])
      verifyRuntimePairingCodeMock.mockImplementation(async (code: string) => verifiedSuccess(code))

      await main(['devices', 'add', '--name', 'node', '--json'], '/tmp/repo')

      const printed = stdout()
      expect(printed).not.toContain('SENTINEL_TOKEN')
      expect(printed).not.toContain(hostPublicKey)
      expect(printed).not.toContain('orca://pair')
      const payload = JSON.parse(printed)
      expect(payload.result.environment.name).toBe('node')
    })

    it('pairs a metadata-only node from an explicit --pairing-code', async () => {
      const explicitCode = pairingCodeFor('ws://192.168.1.5:6768', 'EXPLICIT_TOKEN')
      discoverLanNodesMock.mockResolvedValue([discoveredNode({ advertisement: advertisement() })])
      verifyRuntimePairingCodeMock.mockImplementation(async (code: string) => verifiedSuccess(code))

      await main(['devices', 'add', '--name', 'node', '--pairing-code', explicitCode], '/tmp/repo')

      expect(verifyRuntimePairingCodeMock).toHaveBeenCalledWith(explicitCode, expect.anything())
      expect(listEnvironments(userDataPath)).toHaveLength(1)
    })

    it('prefers an explicit --pairing-code over the advertised offer', async () => {
      const explicitCode = pairingCodeFor('ws://node.local:6768', 'EXPLICIT_TOKEN')
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])
      verifyRuntimePairingCodeMock.mockImplementation(async (code: string) => verifiedSuccess(code))

      await main(['devices', 'add', '--name', 'node', '--pairing-code', explicitCode], '/tmp/repo')

      expect(verifyRuntimePairingCodeMock).toHaveBeenCalledWith(explicitCode, expect.anything())
    })

    it('fails with guidance when no code is available anywhere', async () => {
      discoverLanNodesMock.mockResolvedValue([discoveredNode({ advertisement: advertisement() })])

      await main(['devices', 'add', '--name', 'node'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(stderr()).toContain('--pairing-code')
      expect(verifyRuntimePairingCodeMock).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toHaveLength(0)
    })

    it('fails naming the candidates when the node name is ambiguous', async () => {
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode(),
        discoveredNode({ id: 'node-b._orca-node._tcp.local', port: 6769 })
      ])

      await main(['devices', 'add', '--name', 'node'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(stderr()).toContain('node._orca-node._tcp.local')
      expect(stderr()).toContain('node-b._orca-node._tcp.local')
      expect(verifyRuntimePairingCodeMock).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toHaveLength(0)
    })

    it('fails when no discovered node has the name', async () => {
      discoverLanNodesMock.mockResolvedValue([discoveredNode({ name: 'other' })])

      await main(['devices', 'add', '--name', 'node'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(stderr()).toContain('other')
      expect(verifyRuntimePairingCodeMock).not.toHaveBeenCalled()
    })

    it('refuses a link whose port is not the advertised service port', async () => {
      const wrongPort = pairingCodeFor('ws://192.168.1.5:9999')
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode({ advertisement: advertisement({ pair: wrongPort }) })
      ])

      await main(['devices', 'add', '--name', 'node'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(stderr()).toContain('6768')
      expect(verifyRuntimePairingCodeMock).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toHaveLength(0)
    })

    it('refuses a link whose host is not the discovered node', async () => {
      const wrongHost = pairingCodeFor('ws://10.9.9.9:6768')
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode({ advertisement: advertisement({ pair: wrongHost }) })
      ])

      await main(['devices', 'add', '--name', 'node'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(verifyRuntimePairingCodeMock).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toHaveLength(0)
    })

    it('refuses a loopback link', async () => {
      const loopback = pairingCodeFor('ws://127.0.0.1:6768')
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode({ advertisement: advertisement({ pair: loopback }) })
      ])

      await main(['devices', 'add', '--name', 'node'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(verifyRuntimePairingCodeMock).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toHaveLength(0)
    })

    it('accepts the SRV host with different spelling and bracketed IPv6', async () => {
      const srvCode = pairingCodeFor('ws://NODE.local.:6768')
      const ipv6Code = pairingCodeFor('ws://[fd00::5]:6768')
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])
      verifyRuntimePairingCodeMock.mockImplementation(async (code: string) => verifiedSuccess(code))

      await main(['devices', 'add', '--name', 'node', '--pairing-code', srvCode], '/tmp/repo')
      expect(verifyRuntimePairingCodeMock).toHaveBeenLastCalledWith(srvCode, expect.anything())

      rmSync(userDataPath, { recursive: true, force: true })
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-devices-cli-'))
      getDefaultUserDataPathMock.mockReturnValue(userDataPath)
      discoverLanNodesMock.mockResolvedValue([discoveredNode({ addresses: ['fd00::5'] })])

      await main(['devices', 'add', '--name', 'node', '--pairing-code', ipv6Code], '/tmp/repo')
      expect(verifyRuntimePairingCodeMock).toHaveBeenLastCalledWith(ipv6Code, expect.anything())
      expect(listEnvironments(userDataPath)).toHaveLength(1)
    })

    it.each([
      { label: 'access-link-invalid', code: 'invalid_argument' },
      { label: 'protocol-incompatible', code: 'invalid_argument' },
      { label: 'host-identity-mismatch', code: 'invalid_argument' },
      { label: 'different-server', code: 'invalid_argument' },
      { label: 'host-unreachable', code: 'runtime_error' },
      { label: 'connection-interrupted', code: 'runtime_error' },
      { label: 'environment-save-failed', code: 'runtime_error' }
    ])('maps verification failure $label to $code and saves nothing', async ({ label, code }) => {
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])
      verifyRuntimePairingCodeMock.mockResolvedValue({
        ok: false,
        kind: label,
        message: `verify failed: ${label}`
      })

      await main(['devices', 'add', '--name', 'node', '--json'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(stdout()).toContain(code)
      expect(stdout()).not.toContain('Paired')
      expect(listEnvironments(userDataPath)).toHaveLength(0)
    })

    it('keeps an existing different-named environment untouched on name collision', async () => {
      const otherKey = publicKeyToBase64(generateKeyPair().publicKey)
      const otherCode = pairingCodeFor('ws://192.168.9.9:6768', 'OTHER_TOKEN', otherKey)
      addEnvironmentFromPairingCode(userDataPath, { name: 'node', pairingCode: otherCode })
      const storeBefore = readFileSync(getEnvironmentStorePath(userDataPath))
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])
      verifyRuntimePairingCodeMock.mockImplementation(async (code: string) => verifiedSuccess(code))

      await main(['devices', 'add', '--name', 'node'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      const environments = listEnvironments(userDataPath)
      expect(environments).toHaveLength(1)
      expect(readFileSync(getEnvironmentStorePath(userDataPath))).toEqual(storeBefore)
      expect(stdout()).not.toContain('Paired')
    })

    it('refuses to overwrite an environment for the same host key', async () => {
      const sameKeyCode = pairingCodeFor('ws://192.168.9.9:6768')
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'saved',
        pairingCode: sameKeyCode
      })
      const storeBefore = readFileSync(getEnvironmentStorePath(userDataPath))
      const reissuedCode = pairingCodeFor('ws://192.168.1.5:6768', 'REISSUED_TOKEN')
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode({ advertisement: advertisement({ pair: reissuedCode }) })
      ])
      verifyRuntimePairingCodeMock.mockImplementation(async (code: string) => verifiedSuccess(code))

      await main(['devices', 'add', '--name', 'node'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      const environments = listEnvironments(userDataPath)
      expect(environments).toHaveLength(1)
      expect(environments[0]).toMatchObject({ name: 'saved' })
      expect(readFileSync(getEnvironmentStorePath(userDataPath))).toEqual(storeBefore)
      expect(stdout()).not.toContain('Paired')
    })

    it.each([
      {
        label: 'a valueless --pairing-code',
        args: ['devices', 'add', '--name', 'node', '--pairing-code']
      },
      {
        label: 'an empty --pairing-code=',
        args: ['devices', 'add', '--name', 'node', '--pairing-code=']
      }
    ])('refuses $label instead of falling back to the advertised offer', async ({ args }) => {
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])

      await main(args, '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(discoverLanNodesMock).not.toHaveBeenCalled()
      expect(verifyRuntimePairingCodeMock).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toHaveLength(0)
      expect(stdout()).not.toContain('Paired')
    })

    it('matches a link whose IPv6 literal is written expanded on the wire', async () => {
      const ipv6Code = pairingCodeFor('ws://[fd00::5]:6768')
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode({ addresses: ['fd00:0:0:0:0:0:0:5'] })
      ])
      verifyRuntimePairingCodeMock.mockImplementation(async (code: string) => verifiedSuccess(code))

      await main(['devices', 'add', '--name', 'node', '--pairing-code', ipv6Code], '/tmp/repo')

      expect(verifyRuntimePairingCodeMock).toHaveBeenCalledWith(ipv6Code, expect.anything())
      expect(listEnvironments(userDataPath)).toHaveLength(1)
    })

    it('refuses a different IPv6 literal', async () => {
      const ipv6Code = pairingCodeFor('ws://[fd00::6]:6768')
      discoverLanNodesMock.mockResolvedValue([discoveredNode({ addresses: ['fd00::5'] })])

      await main(['devices', 'add', '--name', 'node', '--pairing-code', ipv6Code], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(verifyRuntimePairingCodeMock).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toHaveLength(0)
    })

    it('emits no raw control bytes in add errors built from network fields', async () => {
      const hostile = 'bad\x1bname\x07'
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode({
          id: 'x\x1by',
          name: hostile,
          host: 'h\x07',
          advertisement: advertisement()
        })
      ])

      await main(['devices', 'add', '--name', hostile], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(stderr()).toBe(escapeTerminalControlCharacters(stderr(), true))
      expect(listEnvironments(userDataPath)).toHaveLength(0)
    })

    it('escapes a hostile display name in the Paired line but keeps raw JSON values', async () => {
      const hostile = 'node\x1b[2K\x07'
      discoverLanNodesMock.mockResolvedValue([
        discoveredNode({
          name: hostile,
          advertisement: advertisement({ name: hostile, pair: lanCode })
        })
      ])
      verifyRuntimePairingCodeMock.mockImplementation(async (code: string) => verifiedSuccess(code))

      await main(['devices', 'add', '--name', hostile], '/tmp/repo')
      expect(process.exitCode).toBeUndefined()
      expect(stdout()).toContain('Paired')
      expect(stdout()).toBe(escapeTerminalControlCharacters(stdout(), true))

      rmSync(userDataPath, { recursive: true, force: true })
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-devices-cli-'))
      getDefaultUserDataPathMock.mockReturnValue(userDataPath)
      consoleLog.mockClear()
      await main(['devices', 'add', '--name', hostile, '--json'], '/tmp/repo')
      expect(JSON.parse(stdout()).result.environment.name).toBe(hostile)
    })

    it('still discovers locally with ambient ORCA_ENVIRONMENT set', async () => {
      vi.stubEnv('ORCA_ENVIRONMENT', 'somewhere-else')
      discoverLanNodesMock.mockResolvedValue([discoveredNode()])
      verifyRuntimePairingCodeMock.mockImplementation(async (code: string) => verifiedSuccess(code))

      await main(['devices', 'add', '--name', 'node'], '/tmp/repo')

      expect(process.exitCode).toBeUndefined()
      expect(discoverLanNodesMock).toHaveBeenCalledOnce()
      expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
      expect(listEnvironments(userDataPath)).toHaveLength(1)
    })
  })
})
