import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import { EmulatorError } from '../emulator-errors'

const DEVICETCTL_TIMEOUT_MS = 120_000
const DEVICETCTL_MAX_OUTPUT_BYTES = 20 * 1024 * 1024

const DEVICETCTL_UNAVAILABLE_MESSAGE =
  'Xcode devicectl is unavailable. Install full Xcode, open it once, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.'

export type DevicectlCommandRunner = (
  args: readonly string[],
  options?: { json?: boolean; timeoutMs?: number }
) => Promise<unknown>

const jsonObjectSchema = z.record(z.string(), z.unknown())

export function asJsonObject(value: unknown): Record<string, unknown> {
  const result = jsonObjectSchema.safeParse(value)
  return result.success ? result.data : {}
}

const NS_LOCALIZED_KEYS = [
  'NSLocalizedDescription',
  'NSLocalizedFailureReason',
  'NSLocalizedRecoverySuggestion'
] as const

// devicectl failures embed an NSError-style JSON chain; the readable message lives in
// NSLocalized* fields, often several NSUnderlyingError levels deep.
export function extractDevicectlErrorDetail(errorValue: unknown): string | null {
  const sentences: string[] = []
  const codes: string[] = []
  let cursor = asJsonObject(errorValue)
  for (let depth = 0; depth < 8; depth += 1) {
    const userInfo = asJsonObject(cursor.userInfo)
    for (const key of NS_LOCALIZED_KEYS) {
      const sentence = asJsonObject(userInfo[key]).string
      if (typeof sentence === 'string' && !sentences.includes(sentence)) {
        sentences.push(sentence)
      }
    }
    const domain = typeof cursor.domain === 'string' ? cursor.domain : undefined
    const code = typeof cursor.code === 'number' ? cursor.code : undefined
    if (domain !== undefined || code !== undefined) {
      codes.push(`${domain ?? 'Error'} ${code ?? ''}`.trim())
    }
    const next = asJsonObject(asJsonObject(userInfo.NSUnderlyingError).error)
    if (Object.keys(next).length === 0) {
      break
    }
    cursor = next
  }
  if (sentences.length === 0) {
    return null
  }
  const suffix = codes.length > 0 ? ` (${codes.join(' → ')})` : ''
  return `${sentences.join(' ')}${suffix}`
}

function toDevicectlError(message: string): EmulatorError {
  if (/unable to find utility|not a developer tool|cannot find "devicectl"/i.test(message)) {
    return new EmulatorError('emulator_devicectl_unavailable', DEVICETCTL_UNAVAILABLE_MESSAGE)
  }
  return new EmulatorError('emulator_error', message)
}

// `--json-output -` keeps machine-readable results on stdout; human progress goes to stderr.
export const execDevicectlCommand: DevicectlCommandRunner = async (args, options) => {
  const command = ['devicectl']
  if (options?.json) {
    command.push('--json-output', '-', '--omit-deprecated-fields-in-json')
  }
  command.push(...args)

  let result
  try {
    result = await runProcess({
      program: 'xcrun',
      args: command,
      maxOutputBytes: DEVICETCTL_MAX_OUTPUT_BYTES,
      timeoutMs: options?.timeoutMs ?? DEVICETCTL_TIMEOUT_MS
    })
  } catch (error) {
    throw toDevicectlError(error instanceof Error ? error.message : 'devicectl command failed')
  }

  const trimmed = result.stdout.trim()
  const parsed = options?.json && trimmed.startsWith('{') ? tryParseJsonObject(trimmed) : null

  if (result.code !== 0 || result.timedOut) {
    const detail =
      (parsed && parsed.error !== undefined
        ? (extractDevicectlErrorDetail(parsed.error) ?? JSON.stringify(parsed.error))
        : null) ??
      (result.stderr.trim() || trimmed || 'devicectl command failed')
    throw toDevicectlError(detail)
  }
  const outcome = parsed ? asJsonObject(parsed.info).outcome : undefined
  if (outcome !== undefined && outcome !== 'success') {
    throw new EmulatorError('emulator_error', `devicectl reported outcome ${String(outcome)}`)
  }
  if (options?.json) {
    return parsed ?? trimmed
  }
  return trimmed
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
