/**
 * Sanitize a JSONL line so it's valid JSON for the DS server.
 */
export function sanitizeJsonLine(line: string): string {
  try {
    JSON.parse(line)
    return line
  } catch {
    const sanitized = line.replace(
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f]/g,
      (ch) => {
        switch (ch) {
          case `\n`:
            return `\\n`
          case `\r`:
            return `\\r`
          case `\t`:
            return `\\t`
          case `\b`:
            return `\\b`
          case `\f`:
            return `\\f`
          default:
            return `\\u${ch.charCodeAt(0).toString(16).padStart(4, `0`)}`
        }
      }
    )
    try {
      JSON.parse(sanitized)
      return sanitized
    } catch {
      return ``
    }
  }
}
