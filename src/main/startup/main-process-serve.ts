import { app } from 'electron'
import { notifyServeSupervisorReady } from '../serve-update-handoff'
import { clearServeAbortPark } from '../../shared/serve-abort-park'
import { findBundledWebClientRoot } from '../../shared/bundled-web-client-root'
import { startServeLanAdvertiser } from '../server/serve-lan-advertiser'
import { buildServePairingReadiness, servePublishMode } from '../server/serve-pairing-readiness'
import { mainProcessState as state } from './main-process-state'
import { getServeOptions, type ServeOptions } from './serve-options'

export { getServeOptions, type ServeOptions }

export function getBundledWebClientRoot(): string | undefined {
  return findBundledWebClientRoot(app.getAppPath())
}

export async function printServeReady(options: ServeOptions): Promise<void> {
  const runtime = state.runtime
  const runtimeRpc = state.runtimeRpc
  if (!runtime || !runtimeRpc) {
    throw new Error('Runtime server must be initialized before printing serve readiness')
  }
  // Validate project root before pairing publication can persist a pending device.
  const output = servePublishMode(options)
  const readiness = {
    runtimeId: runtime.getRuntimeId(),
    ...(await buildServePairingReadiness(options, runtimeRpc)),
    // WSL barrier fails open; pending warns clients PTY launch may still race repair.
    managedWslCliReconciliation: state.managedWslCliReconciliationStatus
  }
  await state.serveReadinessPublisher.publish(readiness, output)
  const lanAdvertiser = await startServeLanAdvertiser({
    advertise: options.advertise,
    advertisePair: options.advertisePair,
    readiness,
    version: app.getVersion(),
    grantDesktopControl: options.grantDesktopControl
  })
  if (lanAdvertiser) {
    app.once('will-quit', lanAdvertiser.stop)
  }
  notifyServeSupervisorReady(runtime.getRuntimeId())
  // Successful readiness disproves the previous serve-abort park.
  clearServeAbortPark(app.getPath('userData'))
}
