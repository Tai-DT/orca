import { getAppEnvironment } from '../../shared/app-environment'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'
import type { OrcadOptions } from './orcad-start-contract'

export async function advertiseOrcadServeOnLan(
  options: OrcadOptions,
  readiness: ServeReadiness,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): Promise<void> {
  const { startServeLanAdvertiser } = await import('../server/serve-lan-advertiser')
  const advertiser = await startServeLanAdvertiser({
    advertise: options.advertise === true,
    advertisePair: options.advertisePair === true,
    readiness,
    version: getAppEnvironment().getVersion(),
    grantDesktopControl: options.grantDesktopControl === true
  })
  if (advertiser) {
    registerCleanup(() => advertiser.stop())
  }
}
