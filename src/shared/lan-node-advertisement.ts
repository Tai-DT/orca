import { z } from 'zod'

export const LAN_NODE_SERVICE_TYPE = '_orca-node._tcp'
export const LAN_NODE_SERVICE_NAME = 'orca-node'
export const LAN_NODE_ADVERTISEMENT_VERSION = 1

// mDNS TXT strings stay under 255 bytes each; larger values split across indexed keys.
const TXT_RECORD_MAX_BYTES = 255
const TXT_TOTAL_MAX_BYTES = 1300
const PAIR_KEY_PATTERN = /^pair(\d*)$/

export const LanNodeAdvertisementSchema = z.object({
  v: z.literal(LAN_NODE_ADVERTISEMENT_VERSION),
  name: z.string().min(1).max(128),
  platform: z.enum(['darwin', 'linux', 'win32']),
  arch: z.string().min(1).max(16),
  orcaVersion: z.string().min(1).max(32),
  runtimeId: z.string().min(1).max(128).optional(),
  caps: z.array(z.string().min(1).max(32)).max(16).default([]),
  /** Embedded pairing-offer payload; only present when the node opted into open LAN pairing. */
  pair: z.string().min(1).max(TXT_TOTAL_MAX_BYTES).optional()
})

export type LanNodeAdvertisement = z.infer<typeof LanNodeAdvertisementSchema>

const encoder = new TextEncoder()

function byteLength(value: string): number {
  return encoder.encode(value).length
}

// Chunks split on code-point boundaries so no multi-byte sequence is cut in half.
function chunkUtf8(value: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const char of value) {
    const charBytes = byteLength(char)
    if (currentBytes + charBytes > maxBytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += char
    currentBytes += charBytes
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks
}

function assertTxtBudget(txt: Record<string, string>): void {
  let totalBytes = 0
  for (const [key, value] of Object.entries(txt)) {
    const recordBytes = byteLength(key) + 1 + byteLength(value)
    if (recordBytes > TXT_RECORD_MAX_BYTES) {
      throw new Error(
        `LAN node TXT record "${key}" exceeds ${TXT_RECORD_MAX_BYTES} bytes on the wire`
      )
    }
    totalBytes += recordBytes + 1
  }
  if (totalBytes > TXT_TOTAL_MAX_BYTES) {
    throw new Error(`LAN node advertisement exceeds ${TXT_TOTAL_MAX_BYTES} bytes of TXT records`)
  }
}

/**
 * mDNS TXT entries arrive unordered in some browsers, so chunked values carry
 * their index in the key (`pair0`, `pair1`, ...). Keys stay short to leave room.
 */
export function encodeLanNodeTxt(advertisement: LanNodeAdvertisement): Record<string, string> {
  const parsed = LanNodeAdvertisementSchema.parse(advertisement)
  const txt: Record<string, string> = {
    v: String(parsed.v),
    name: parsed.name,
    platform: parsed.platform,
    arch: parsed.arch,
    ov: parsed.orcaVersion,
    caps: parsed.caps.join(',')
  }
  if (parsed.runtimeId) {
    txt.rtid = parsed.runtimeId
  }
  if (parsed.pair) {
    const chunks = chunkUtf8(parsed.pair, TXT_RECORD_MAX_BYTES - 'pair99='.length)
    chunks.forEach((chunk, index) => {
      txt[`pair${index}`] = chunk
    })
  }
  assertTxtBudget(txt)
  return txt
}

/** bonjour hands values as string | string[] | undefined; indexed pair chunks rejoin in order. */
export function decodeLanNodeTxt(txt: Record<string, unknown>): LanNodeAdvertisement | null {
  const flat: Record<string, string> = {}
  let totalBytes = 0
  for (const [key, raw] of Object.entries(txt)) {
    let value: string | undefined
    if (typeof raw === 'string') {
      value = raw
    } else if (Array.isArray(raw) && raw.every((piece) => typeof piece === 'string')) {
      value = raw.join('')
    }
    if (value === undefined) {
      continue
    }
    const recordBytes = byteLength(key) + 1 + byteLength(value)
    if (recordBytes > TXT_RECORD_MAX_BYTES) {
      return null
    }
    totalBytes += recordBytes + 1
    flat[key] = value
  }
  if (totalBytes > TXT_TOTAL_MAX_BYTES) {
    return null
  }
  if (flat.v !== String(LAN_NODE_ADVERTISEMENT_VERSION)) {
    return null
  }
  const pairIndices: number[] = []
  for (const key of Object.keys(flat)) {
    const match = PAIR_KEY_PATTERN.exec(key)
    if (match === null) {
      continue
    }
    const digits = match[1]!
    if (digits === '' || digits !== String(Number(digits))) {
      return null
    }
    pairIndices.push(Number(digits))
  }
  let pair: string | undefined
  if (pairIndices.length > 0) {
    const chunks: string[] = []
    for (let index = 0; index <= Math.max(...pairIndices); index += 1) {
      const chunk = flat[`pair${index}`]
      if (chunk === undefined) {
        return null
      }
      chunks.push(chunk)
    }
    pair = chunks.join('')
  }
  const candidate = {
    v: LAN_NODE_ADVERTISEMENT_VERSION,
    name: flat.name,
    platform: flat.platform,
    arch: flat.arch,
    orcaVersion: flat.ov,
    runtimeId: flat.rtid,
    caps: flat.caps ? flat.caps.split(',').filter((cap) => cap.length > 0) : [],
    pair
  }
  const parsed = LanNodeAdvertisementSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}
