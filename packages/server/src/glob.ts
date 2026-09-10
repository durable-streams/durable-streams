/**
 * Glob pattern matching for webhook subscription patterns.
 *
 * Supports:
 * - `*` matches exactly one path segment
 * - `**` matches zero or more path segments (recursive)
 * - Literal segments match exactly
 */

/**
 * Match a stream path against a glob pattern.
 */
export function globMatch(pattern: string, path: string): boolean {
  const patternParts = splitPath(pattern)
  const pathParts = splitPath(path)
  return matchParts(patternParts, 0, pathParts, 0)
}

function splitPath(p: string): Array<string> {
  // Normalize: remove leading/trailing slashes, split on /
  return p
    .replace(/^\/+/, ``)
    .replace(/\/+$/, ``)
    .split(`/`)
    .filter((s) => s.length > 0)
}

function matchParts(
  pattern: Array<string>,
  pi: number,
  path: Array<string>,
  si: number
): boolean {
  while (pi < pattern.length && si < path.length) {
    const seg = pattern[pi]!

    if (seg === `**`) {
      // ** matches zero or more segments
      // Try matching rest of pattern against every possible suffix of path
      for (let i = si; i <= path.length; i++) {
        if (matchParts(pattern, pi + 1, path, i)) {
          return true
        }
      }
      return false
    }

    if (seg === `*`) {
      // * matches exactly one segment
      pi++
      si++
      continue
    }

    // Literal match (also handle %2A as *)
    const decodedSeg = seg.replace(/%2[Aa]/g, `*`)
    if (decodedSeg !== path[si]) {
      return false
    }
    pi++
    si++
  }

  // Handle trailing ** which matches zero segments
  while (pi < pattern.length && pattern[pi] === `**`) {
    pi++
  }

  return pi === pattern.length && si === path.length
}
