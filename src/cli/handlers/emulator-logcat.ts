import type { CommandHandler } from '../dispatch'
import { formatLogcat } from '../emulator-logcat-format'
import { printResult } from '../format'
import { getOptionalPositiveIntegerFlag, getRepeatedStringFlag } from '../flags'
import { getEmulatorCommandTarget } from '../selectors'

export const EMULATOR_LOGCAT_HANDLERS: Record<string, CommandHandler> = {
  'emulator logcat': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const buffers = getRepeatedStringFlag(flags, 'buffer')
    const filters = getRepeatedStringFlag(flags, 'filter')
    const res = await client.call('emulator.logcat', {
      lines: getOptionalPositiveIntegerFlag(flags, 'lines'),
      buffers: buffers.length > 0 ? buffers : undefined,
      filters: filters.length > 0 ? filters : undefined,
      durationMs: getOptionalPositiveIntegerFlag(flags, 'duration'),
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, formatLogcat)
  }
}
