import { pairedRuntimeConnectionFromOffer } from './paired-runtime-connection'
import type { RuntimeCapability } from './protocol-version'
import { parseHostAccessLink, type ParsedHostAccessLink } from './remote-pairing-address'
import {
  verifyRemotePairingRuntimeStatus,
  type RemotePairingFailure
} from './remote-pairing-verification'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { sendRemoteRuntimeRequest } from './remote-runtime-client'
import type { RuntimeStatus } from './runtime-types'

export type VerifiedRuntimePairing = {
  ok: true
  link: ParsedHostAccessLink
  runtimeStatus: RuntimeStatus
}

export type RuntimePairingVerificationResult = VerifiedRuntimePairing | RemotePairingFailure

const DEFAULT_VERIFY_TIMEOUT_MS = 15_000

/** Proves a pairing link reaches a compatible host that accepts it, without saving anything. */
export async function verifyRuntimePairingCode(
  pairingCode: string,
  options: {
    allowLoopback?: boolean
    clientCapabilities?: readonly RuntimeCapability[]
    timeoutMs?: number
  } = {}
): Promise<RuntimePairingVerificationResult> {
  const parsed = parseHostAccessLink(pairingCode)
  if (!parsed.ok) {
    return { ok: false, kind: 'access-link-invalid', message: parsed.message }
  }
  if (parsed.value.endpointKind === 'loopback' && !options.allowLoopback) {
    return {
      ok: false,
      kind: 'host-unreachable',
      message: 'This access link points back to this device.'
    }
  }
  try {
    const response = await sendRemoteRuntimeRequest<RuntimeStatus>(
      pairedRuntimeConnectionFromOffer(parsed.value.pairing),
      'status.get',
      undefined,
      options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      undefined,
      undefined,
      options.clientCapabilities ?? []
    )
    if (!response.ok) {
      return {
        ok: false,
        kind: 'connection-interrupted',
        message: response.error.message
      }
    }
    const statusVerification = verifyRemotePairingRuntimeStatus(response.result)
    if (!statusVerification.ok) {
      return statusVerification
    }
    return {
      ok: true,
      link: parsed.value,
      runtimeStatus: statusVerification.runtimeStatus
    }
  } catch (error) {
    return classifyPairingVerificationError(error, parsed.value.displayEndpoint)
  }
}

function classifyPairingVerificationError(error: unknown, endpoint: string): RemotePairingFailure {
  if (error instanceof RemoteRuntimeClientError) {
    if (error.code === 'invalid_argument') {
      return invalidAccessLinkResult()
    }
    if (error.code === 'unauthorized' || error.pairingStage === 'access-grant') {
      return {
        ok: false,
        kind: 'access-link-invalid',
        message: 'This access link is no longer valid. Generate a new link on the other host.'
      }
    }
    if (error.pairingStage === 'host-identity') {
      return {
        ok: false,
        kind: 'host-identity-mismatch',
        message: `Orca reached ${endpoint}, but that host does not match this access link.`
      }
    }
    if (error.pairingStage === 'runtime') {
      return {
        ok: false,
        kind: 'connection-interrupted',
        message: `The connection to ${endpoint} was interrupted during verification.`
      }
    }
    if (error.pairingStage === 'connect') {
      return unreachableHostResult(endpoint)
    }
  }
  if (error instanceof Error) {
    return error.message.startsWith('Invalid public key')
      ? invalidAccessLinkResult()
      : { ok: false, kind: 'connection-interrupted', message: error.message }
  }
  return unreachableHostResult(endpoint)
}

function invalidAccessLinkResult(): RemotePairingFailure {
  return {
    ok: false,
    kind: 'access-link-invalid',
    message: 'This access link contains invalid connection details.'
  }
}

function unreachableHostResult(endpoint: string): RemotePairingFailure {
  return {
    ok: false,
    kind: 'host-unreachable',
    message: `Cannot reach Orca at ${endpoint}. Confirm the other host is running and reachable.`
  }
}
