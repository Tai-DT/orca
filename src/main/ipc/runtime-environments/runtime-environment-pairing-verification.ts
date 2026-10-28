import {
  addOrUpdateEnvironmentFromPairingCode,
  resolveEnvironment,
  RuntimeEnvironmentStoreError,
  updateEnvironmentFromPairingCode
} from '../../../shared/runtime-environment-store'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../../shared/remote-pairing-verification'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import {
  getPreferredPairingOffer,
  isEphemeralVmRuntimeEnvironment,
  redactRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { verifyRuntimePairingCode } from '../../../shared/runtime-pairing-verification'

type VerifyAndAddRuntimeEnvironmentArgs = {
  name: string
  pairingCode: string
  allowLoopback?: boolean
}

export async function verifyAndAddRuntimeEnvironmentFromPairingCode(
  userDataPath: string,
  args: VerifyAndAddRuntimeEnvironmentArgs
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const verified = await verifyRuntimePairingCode(args.pairingCode, {
    allowLoopback: args.allowLoopback,
    clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  })
  if (!verified.ok) {
    return verified
  }
  const { link, runtimeStatus } = verified
  const usesSshTunnel = link.endpointKind === 'loopback' && args.allowLoopback === true
  let outcome: ReturnType<typeof addOrUpdateEnvironmentFromPairingCode>
  try {
    outcome = addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      ...args,
      // Only a verified key match permits updating an existing server identity.
      runtimeId: runtimeStatus.runtimeId,
      ...(usesSshTunnel ? { connectionDependency: 'ssh-tunnel' as const } : {})
    })
  } catch (error) {
    return {
      ok: false,
      kind: 'environment-save-failed',
      message:
        error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument'
          ? error.message
          : 'Orca verified the host but could not save it. Check local settings storage and try again.'
    }
  }
  return {
    ok: true,
    environment: redactRuntimeEnvironment(outcome.environment),
    runtimeStatus,
    ...(outcome.updatedExisting ? { updatedExisting: true as const } : {})
  }
}

/** Replace pairing only after verifying the saved host key; invalid or foreign links leave it untouched. */
export async function verifyAndRepairRuntimeEnvironmentFromPairingCode(
  userDataPath: string,
  args: { selector: string; pairingCode: string }
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const existing = resolveEnvironment(userDataPath, args.selector)
  if (isEphemeralVmRuntimeEnvironment(existing)) {
    return {
      ok: false,
      kind: 'environment-save-failed',
      message: 'This server belongs to a cloud workspace, which pairs it again when it resumes.'
    }
  }
  // SSH tunnel pairings legitimately use loopback links.
  const verified = await verifyRuntimePairingCode(args.pairingCode, {
    allowLoopback: existing.connectionDependency === 'ssh-tunnel',
    clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  })
  if (!verified.ok) {
    return verified
  }
  // Host key persists across restarts; runtimeId does not.
  if (verified.link.pairing.publicKeyB64 !== getPreferredPairingOffer(existing).publicKeyB64) {
    return {
      ok: false,
      kind: 'different-server',
      message: 'This pairing link is for a different server.'
    }
  }
  let environment: ReturnType<typeof updateEnvironmentFromPairingCode>
  try {
    environment = updateEnvironmentFromPairingCode(userDataPath, existing.id, {
      pairingCode: args.pairingCode,
      // The verified same host may have restarted with a new runtimeId.
      runtimeId: verified.runtimeStatus.runtimeId
    })
  } catch (error) {
    return {
      ok: false,
      kind: 'environment-save-failed',
      message:
        error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument'
          ? error.message
          : 'Orca verified the server but could not save the new pairing. Check local settings storage and try again.'
    }
  }
  return {
    ok: true,
    environment: redactRuntimeEnvironment(environment),
    runtimeStatus: verified.runtimeStatus
  }
}
