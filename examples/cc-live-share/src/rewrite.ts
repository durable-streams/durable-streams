/**
 * JSONL rewriter for adapting CC session entries to a new environment.
 * Rewrites cwd, sessionId, and gitBranch in each JSONL line.
 */

/**
 * Rewrite path-sensitive fields in a JSONL line.
 * Uses string replacement on the JSON text (safe because we match exact quoted values).
 */
export function rewriteJsonlLine(
  line: string,
  originalSessionId: string,
  newSessionId: string,
  originalCwd: string,
  newCwd: string,
  newGitBranch: string
): string {
  let result = line

  // Replace sessionId (appears as "sessionId":"<value>")
  result = result.replaceAll(
    `"sessionId":"${originalSessionId}"`,
    `"sessionId":"${newSessionId}"`
  )

  // Replace cwd (appears as "cwd":"<value>")
  // Need to handle JSON-escaped paths (forward slashes don't need escaping in JSON,
  // but backslashes on Windows would)
  result = result.replaceAll(`"cwd":"${originalCwd}"`, `"cwd":"${newCwd}"`)

  // Replace gitBranch — find the original value and replace with new branch
  // The original gitBranch varies per entry, so we use a regex
  result = result.replace(
    /"gitBranch":"[^"]*"/g,
    `"gitBranch":"${newGitBranch}"`
  )

  return result
}

/**
 * Rewrite all lines in a JSONL array.
 */
export function rewriteJsonlLines(
  lines: Array<string>,
  originalSessionId: string,
  newSessionId: string,
  originalCwd: string,
  newCwd: string,
  newGitBranch: string
): Array<string> {
  return lines.map((line) =>
    rewriteJsonlLine(
      line,
      originalSessionId,
      newSessionId,
      originalCwd,
      newCwd,
      newGitBranch
    )
  )
}
