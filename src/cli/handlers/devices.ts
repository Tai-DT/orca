import { isIP } from 'node:net'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { getDefaultUserDataPath, RuntimeClientError } from '../runtime-client'
import type { RuntimeRpcSuccess } from '../runtime-client'
import type { ParsedHostAccessLink } from '../../shared/remote-pairing-address'
import { parseHostAccessLink } from '../../shared/remote-pairing-address'
import type { RemotePairingFailure } from '../../shared/remote-pairing-verification'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import { verifyRuntimePairingCode } from '../../shared/runtime-pairing-verification'
import { escapeTerminalControlCharacters } from '../../shared/terminal-control-character-escape'
import { addEnvironmentFromPairingCode } from '../runtime/environments'
import { discoverLanNodes, type DiscoveredLanNode } from '../runtime/lan-node-discovery'
import { CLI_CLIENT_CAPABILITIES } from '../runtime/websocket-transport'

const DEFAULT_DISCOVER_TIMEOUT_MS = 3_000
const MAX_DISCOVER_TIMEOUT_MS = 60_000

type PublicLanNode = {
  id: string
  name: string
  platform: DiscoveredLanNode['advertisement']['platform']
  arch: string
  orcaVersion: string
  runtimeId?: string
  caps: string[]
  host: string | null
  addresses: string[]
  port: number
  pairable: boolean
}

function publicLanNode(node: DiscoveredLanNode): PublicLanNode {
  return {
    id: node.id,
    name: node.name,
    platform: node.advertisement.platform,
    arch: node.advertisement.arch,
    orcaVersion: node.advertisement.orcaVersion,
    ...(node.advertisement.runtimeId ? { runtimeId: node.advertisement.runtimeId } : {}),
    caps: node.advertisement.caps,
    host: node.host,
    addresses: node.addresses,
    port: node.port,
    pairable: node.advertisement.pair !== undefined
  }
}

const escapeForTerminal = (value: string): string => escapeTerminalControlCharacters(value, true)

export const DEVICES_HANDLERS: Record<string, CommandHandler> = {
  'devices discover': async ({ flags, json }) => {
    const nodes = await discoverLanNodes(readTimeoutMs(flags))
    printResult(localSuccess({ nodes: nodes.map(publicLanNode) }), json, formatDiscoveredNodes)
  },
  'devices add': async ({ flags, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const explicitCode = flags.has('pairing-code')
      ? getRequiredStringFlag(flags, 'pairing-code')
      : undefined
    const nodes = await discoverLanNodes(readTimeoutMs(flags))
    const matches = nodes.filter((candidate) => candidate.name === name)
    if (matches.length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        nodes.length
          ? `No advertised Orca node named "${escapeForTerminal(name)}" on this LAN. Discovered: ${nodes.map((candidate) => escapeForTerminal(candidate.name)).join(', ')}`
          : `No advertised Orca node named "${escapeForTerminal(name)}" on this LAN. No nodes were discovered; start one with \`orca serve --advertise\`.`
      )
    }
    if (matches.length > 1) {
      const candidates = matches
        .map(
          (candidate) =>
            `${escapeForTerminal(candidate.id)} at ${escapeForTerminal(candidate.host ?? candidate.addresses[0] ?? 'unknown')}:${candidate.port}`
        )
        .join('; ')
      throw new RuntimeClientError(
        'invalid_argument',
        `More than one advertised Orca node is named "${escapeForTerminal(name)}": ${candidates}. Rename one on its host, or use \`orca environment add --name <name> --pairing-code <code>\` with an explicit link.`
      )
    }
    const node = matches[0]
    if (!node) {
      throw new RuntimeClientError(
        'invalid_argument',
        `No advertised Orca node named "${escapeForTerminal(name)}" on this LAN.`
      )
    }
    const pairingCode = explicitCode ?? node.advertisement.pair
    if (!pairingCode) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Node "${escapeForTerminal(node.name)}" does not advertise a pairing offer. Supply one with \`orca devices add --name <node> --pairing-code <code>\` using a link printed on that host, or restart it with \`orca serve --advertise-pair\`.`
      )
    }
    assertLinkTargetsDiscoveredNode(pairingCode, node)

    const verified = await verifyRuntimePairingCode(pairingCode, {
      clientCapabilities: CLI_CLIENT_CAPABILITIES
    })
    if (!verified.ok) {
      throw toRuntimeClientError(verified)
    }
    const environment = redactRuntimeEnvironment(
      addEnvironmentFromPairingCode(getDefaultUserDataPath(), {
        name: node.name,
        pairingCode
      })
    )
    printResult(
      localSuccess({ environment, node: describeNode(node) }),
      json,
      (result: { environment: { name: string; id: string }; node: string }) =>
        escapeForTerminal(
          `Paired ${result.node} as environment ${result.environment.name} (${result.environment.id}). Target it with --environment ${result.environment.id}.`
        )
    )
  }
}

function describeNode(node: DiscoveredLanNode): string {
  return `${node.name} (${node.advertisement.platform}/${node.advertisement.arch}, Orca ${node.advertisement.orcaVersion})`
}

function formatDiscoveredNodes(result: { nodes: PublicLanNode[] }): string {
  if (result.nodes.length === 0) {
    return 'No Orca nodes discovered on this LAN. Start one with `orca serve --advertise`.'
  }
  return result.nodes
    .map((node) => {
      const rawAddress = node.addresses[0] ?? node.host ?? 'address unknown'
      const address = rawAddress.includes(':')
        ? `[${escapeForTerminal(rawAddress)}]`
        : escapeForTerminal(rawAddress)
      const pairable = node.pairable ? 'pairable' : 'link required'
      const caps = node.caps.length ? ` caps:${node.caps.map(escapeForTerminal).join('+')}` : ''
      return `${escapeForTerminal(node.name).padEnd(24)} ${escapeForTerminal(node.platform)}/${escapeForTerminal(node.arch)}  orca ${escapeForTerminal(node.orcaVersion)}  ${address}:${node.port}  ${pairable}${caps}`
    })
    .join('\n')
}

function normalizeEndpointHostname(hostname: string): string {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (isIP(normalized) !== 6) {
    return normalized
  }
  try {
    return new URL(`ws://[${normalized}]:1`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return normalized
  }
}

function assertLinkTargetsDiscoveredNode(pairingCode: string, node: DiscoveredLanNode): void {
  const parsed = parseHostAccessLink(pairingCode)
  if (!parsed.ok) {
    throw new RuntimeClientError(
      'invalid_argument',
      `The pairing code for "${escapeForTerminal(node.name)}" is not usable: ${escapeForTerminal(parsed.message)}`
    )
  }
  const link: ParsedHostAccessLink = parsed.value
  if (link.endpointKind === 'loopback') {
    throw new RuntimeClientError(
      'invalid_argument',
      `The pairing code for "${escapeForTerminal(node.name)}" points at this device, not the discovered node.`
    )
  }
  const endpoint = new URL(link.pairing.endpoint)
  const effectivePort =
    endpoint.port === '' ? (endpoint.protocol === 'wss:' ? 443 : 80) : Number(endpoint.port)
  const endpointHost = normalizeEndpointHostname(endpoint.hostname)
  const candidates = new Set(
    [node.host ?? '', ...node.addresses].map(normalizeEndpointHostname).filter(Boolean)
  )
  if (effectivePort !== node.port || !candidates.has(endpointHost)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `The pairing link targets ${escapeForTerminal(endpointHost)}:${effectivePort}, which is not the discovered node "${escapeForTerminal(node.name)}" at ${escapeForTerminal(node.host ?? node.addresses[0] ?? 'unknown')}:${node.port}. For a custom or proxied link use \`orca environment add --name ${escapeForTerminal(node.name)} --pairing-code <code>\` instead.`
    )
  }
}

function toRuntimeClientError(failure: RemotePairingFailure): RuntimeClientError {
  const code =
    failure.kind === 'host-unreachable' ||
    failure.kind === 'connection-interrupted' ||
    failure.kind === 'environment-save-failed'
      ? 'runtime_error'
      : 'invalid_argument'
  return new RuntimeClientError(code, escapeForTerminal(failure.message))
}

function readTimeoutMs(flags: Map<string, string | boolean>): number {
  const raw = flags.get('timeout-ms')
  if (raw === undefined) {
    return DEFAULT_DISCOVER_TIMEOUT_MS
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--timeout-ms expects a positive integer, got ${String(raw)}`
    )
  }
  const value = Number(raw)
  if (value < 100 || value > MAX_DISCOVER_TIMEOUT_MS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--timeout-ms must be between 100 and ${MAX_DISCOVER_TIMEOUT_MS}`
    )
  }
  return value
}

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: {
      runtimeId: 'local'
    }
  }
}
