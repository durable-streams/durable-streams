/**
 * ds-cc share: tail a CC session's JSONL file and append to a Durable Stream.
 */

import * as fs from "node:fs"
import { DurableStream } from "@durable-streams/client"
import {
  findActiveSessions,
  findLastCompactionBoundary,
  getSessionJsonlPath,
  readLinesFromOffset,
} from "./session.js"

/**
 * Sanitize a JSONL line so it's valid JSON for the DS server.
 * CC's JSONL can contain raw control characters (e.g., ANSI escape codes
 * in tool output) that are invalid in JSON strings. We need to escape them.
 */
function sanitizeJsonLine(line: string): string {
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

interface ShareOptions {
  sessionId?: string
  server: string
}

export async function share(options: ShareOptions): Promise<void> {
  // Resolve session
  let sessionId = options.sessionId
  let cwd: string

  if (!sessionId) {
    // Try cwd-specific sessions first, then fall back to all active sessions
    let sessions = findActiveSessions(process.cwd())
    if (sessions.length === 0) {
      sessions = findActiveSessions()
    }
    if (sessions.length === 0) {
      console.error(
        `No active CC sessions found.\n` +
          `Use --session <id> to specify a session explicitly.`
      )
      process.exit(1)
    }
    if (sessions.length > 1) {
      console.error(`Multiple active sessions found:`)
      for (const s of sessions) {
        console.error(
          `  ${s.sessionId} (pid ${s.pid}, cwd ${s.cwd}, started ${new Date(s.startedAt).toLocaleTimeString()})`
        )
      }
      console.error(`\nUse --session <id> to specify which one to share.`)
      process.exit(1)
    }
    sessionId = sessions[0].sessionId
    cwd = sessions[0].cwd
    console.log(`Detected active session: ${sessionId} (${cwd})`)
  } else {
    // Find the session's cwd from session metadata
    const allSessions = findActiveSessions()
    const match = allSessions.find((s) => s.sessionId === sessionId)
    if (match) {
      cwd = match.cwd
    } else {
      cwd = process.cwd()
    }
  }

  const jsonlPath = getSessionJsonlPath(sessionId, cwd)
  if (!fs.existsSync(jsonlPath)) {
    console.error(`Session JSONL not found: ${jsonlPath}`)
    process.exit(1)
  }

  // Create the DS stream
  const streamUrl = `${options.server}/cc/${sessionId}`
  console.log(`Creating stream at ${streamUrl}...`)

  try {
    await DurableStream.create({
      url: streamUrl,
      contentType: `application/json`,
    })
  } catch (err: unknown) {
    // Stream might already exist (idempotent create)
    if (err instanceof Error && !err.message.includes(`409`)) {
      throw err
    }
  }

  const stream = new DurableStream({
    url: streamUrl,
    contentType: `application/json`,
  })

  // Find the starting point (last compaction boundary)
  const startOffset = findLastCompactionBoundary(jsonlPath)
  console.log(
    startOffset > 0
      ? `Starting from compaction boundary at byte ${startOffset}`
      : `No compaction boundary found, starting from beginning`
  )

  // Initial sync: read and append existing lines
  const initialRead = readLinesFromOffset(jsonlPath, startOffset)
  const { lines } = initialRead
  let currentByteOffset = initialRead.newOffset

  let lineNumber = 0
  for (const line of lines) {
    const sanitized = sanitizeJsonLine(line)
    if (!sanitized) continue
    await stream.append(sanitized)
    lineNumber++
  }
  console.log(`[${timestamp()}] Synced ${lineNumber} entries (initial)`)

  console.log(`\nStream URL: ${streamUrl}`)
  console.log(`\nShare this URL with others to let them follow your session.`)
  console.log(`Press Ctrl+C to stop sharing.\n`)

  // Tail the file for new entries
  const checkForNewLines = () => {
    const { lines: newLines, newOffset } = readLinesFromOffset(
      jsonlPath,
      currentByteOffset
    )
    if (newLines.length > 0) {
      currentByteOffset = newOffset
      const count = newLines.length
      for (const line of newLines) {
        const sanitized = sanitizeJsonLine(line)
        if (!sanitized) continue
        stream.append(sanitized).catch((err: unknown) => {
          console.error(`Error appending to stream:`, err)
        })
        lineNumber++
      }
      console.log(`[${timestamp()}] +${count} entries`)
    }
  }

  const watcher = fs.watch(jsonlPath, checkForNewLines)

  // Handle graceful shutdown — stop tailing but don't close the stream,
  // so the sidecar can be restarted without recreating the stream.
  const cleanup = () => {
    console.log(`\nStopping share (stream remains open)...`)
    watcher.close()
    process.exit(0)
  }

  process.on(`SIGINT`, cleanup)
  process.on(`SIGTERM`, cleanup)

  // Keep the process alive
  await new Promise(() => {})
}

function timestamp(): string {
  return new Date().toLocaleTimeString()
}
