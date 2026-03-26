/**
 * Sanitize a JSONL line so it's valid JSON for the DS server.
 * CC's JSONL can contain raw control characters (e.g., ANSI escape codes
 * in tool output) that are invalid in JSON strings. We need to escape them.
 */
export function sanitizeJsonLine(line: string): string {
  // Try parsing first — if it works, it's already valid
  try {
    JSON.parse(line)
    return line
  } catch {
    // Escape control characters (U+0000 through U+001F) that aren't
    // already escaped. We replace them with \uXXXX sequences.
    // But we need to be careful not to double-escape existing \n, \t, etc.
    // Strategy: work at the byte level, replacing unescaped control chars.
    const sanitized = line.replace(
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f]/g,
      (ch) => {
        switch (ch) {
          // These are commonly already escaped by JSON serializers,
          // but if they appear raw, escape them properly
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
    // Verify the sanitized version parses
    try {
      JSON.parse(sanitized)
      return sanitized
    } catch {
      // If it still fails, skip this line
      return ``
    }
  }
}
