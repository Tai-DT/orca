/** Share the CLI’s exact Electron --serve-* and plain orcad argv with runtime tests; flags previously vanished at this boundary (#30120). */
export type ServeOrcaAppArgs = {
  json?: boolean
  port?: string | null
  pairingAddress?: string | null
  noPairing?: boolean
  mobilePairing?: boolean
  grantDesktopControl?: boolean
  recipeJson?: boolean
  projectRoot?: string | null
  /** Starts Electron serve despite a remembered macOS startup abort in this environment. */
  force?: boolean
  /** Restart the server under a service manager instead of exiting with it; never inferred. */
  supervise?: boolean
  /** Publish this node on the LAN so other Orca installs can discover it. */
  advertise?: boolean
  /** Also broadcast the runtime pairing offer; anyone on the LAN can pair. */
  advertisePair?: boolean
}

export function serveOptionArgs(args: ServeOrcaAppArgs, prefix: '--' | '--serve-'): string[] {
  return [
    ...(args.json ? [`${prefix}json`] : []),
    ...(args.port ? [`${prefix}port`, args.port] : []),
    ...(args.pairingAddress ? [`${prefix}pairing-address`, args.pairingAddress] : []),
    ...(args.noPairing ? [`${prefix}no-pairing`] : []),
    ...(args.mobilePairing ? [`${prefix}mobile-pairing`] : []),
    ...(args.grantDesktopControl ? [`${prefix}grant-desktop-control`] : []),
    ...(args.advertise || args.advertisePair ? [`${prefix}advertise`] : []),
    ...(args.advertisePair ? [`${prefix}advertise-pair`] : []),
    ...(args.recipeJson && args.projectRoot
      ? [`${prefix}recipe-json`, `${prefix}project-root`, args.projectRoot]
      : [])
  ]
}

/** `bindHost` exists for tests, which must not listen on every interface. */
export function orcadServeArgs(
  args: ServeOrcaAppArgs,
  webClientRoot?: string,
  bindHost = '0.0.0.0'
): string[] {
  return [
    '--bind',
    bindHost,
    ...serveOptionArgs(args, '--'),
    ...(webClientRoot ? ['--web-client-root', webClientRoot] : [])
  ]
}
