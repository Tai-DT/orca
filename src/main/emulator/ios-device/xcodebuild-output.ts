const ERROR_LINE_PATTERNS = [
  /error:/i,
  /\*\* (TEST|BUILD|ARCHIVE|ANALYZE) (FAILED|INTERRUPTED)/,
  /Code Sign error/i,
  /requires a provisioning profile/i,
  /Provisioning profile/i,
  /doesn't support/i,
  /does not support/i,
  /not registered/i,
  /no profiles for/i,
  /failed to (launch|install|register|code sign)/i,
  /timed? ?out while/i,
  /Developer Mode|Enable UI Automation|UI Automation/i
]

// xcodebuild failures surface the real reason on 'error:' and signing lines far above
// the tail; grep those first, then let callers fall back to the output tail.
export function extractXcodebuildErrorLines(output: string, maxLines = 6): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (line === '' || seen.has(line)) {
      continue
    }
    if (ERROR_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      seen.add(line)
      lines.push(line)
      if (lines.length >= maxLines) {
        break
      }
    }
  }
  return lines
}
