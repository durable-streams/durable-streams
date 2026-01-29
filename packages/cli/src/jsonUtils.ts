/**
 * Check if content-type indicates JSON mode.
 * Matches application/json and any +json suffix (e.g., application/vnd.api+json).
 * Handles cases like "application/json; charset=utf-8".
 */
export function isJsonContentType(contentType: string): boolean {
  const normalized = contentType.split(`;`)[0]!.trim().toLowerCase()
  return normalized === `application/json` || normalized.endsWith(`+json`)
}

/**
 * One-level array flattening for JSON batch semantics.
 * - Single object: `{}` → yields once
 * - Array: `[{}, {}]` → yields each element (flattened)
 * - Nested array: `[[{}, {}]]` → yields `[{}, {}]` (outer array flattened, inner preserved)
 *
 * This matches the protocol's batch semantics where servers flatten exactly one level.
 */
export function* flattenJsonForAppend(parsed: unknown): Generator<unknown> {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      yield item
    }
  } else {
    yield parsed
  }
}
