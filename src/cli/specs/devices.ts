import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const DEVICES_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['devices', 'discover'],
    summary: 'Find Orca nodes advertising on the local network (mDNS)',
    usage: 'orca devices discover [--timeout-ms <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'timeout-ms'],
    notes: [
      'Lists machines running `orca serve --advertise` (or --advertise-pair) on this LAN.',
      'A node that embeds its pairing offer is marked pairable and can be added with `orca devices add --name <node>` in one step.',
      'Multicast must be allowed on the network; some VPNs, guest Wi-Fi, and AP-isolated networks block it.'
    ],
    examples: ['orca devices discover', 'orca devices discover --timeout-ms 5000 --json']
  },
  {
    path: ['devices', 'add'],
    summary: 'Pair a discovered LAN node as a named Orca environment',
    usage:
      'orca devices add --name <node> [--pairing-code <link-or-code>] [--timeout-ms <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'timeout-ms'],
    notes: [
      'Runs discovery, finds the named node, verifies the link actually reaches it, and saves it to the pairing store like `orca environment add`.',
      "With no --pairing-code, the node's own advertised offer is used; only nodes started with `orca serve --advertise-pair` carry one. An explicit --pairing-code is verified and saved instead.",
      'The link must resolve back to the discovered node; for a custom or proxied endpoint use `orca environment add --name <name> --pairing-code <code>` instead.',
      'After adding, target the node from any command with --environment <name>, for example `orca --environment build-win emulator devices`.'
    ],
    examples: [
      'orca devices add --name build-win',
      'orca devices add --name build-win --pairing-code orca://pair?...',
      'orca devices discover --json',
      'orca --environment build-win worktree list'
    ]
  }
]
