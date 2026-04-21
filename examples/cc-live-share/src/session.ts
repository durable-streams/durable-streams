/**
 * Claude Code session discovery and JSONL file handling.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

interface SessionMetadata {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: string
}

/**
 * Check if a process is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Encode a working directory path for CC's file naming convention.
 * Replaces "/" with "-" (e.g., "/Users/kevin/Desktop" → "-Users-kevin-Desktop").
 */
function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, `-`)
}

/**
 * Get the JSONL file path for a session.
 */
export function getSessionJsonlPath(sessionId: string, cwd: string): string {
  const claudeDir = path.join(os.homedir(), `.claude`)
  return path.join(claudeDir, `projects`, encodeCwd(cwd), `${sessionId}.jsonl`)
}

/**
 * Find active CC sessions, optionally filtered to the current working directory.
 */
export function findActiveSessions(filterCwd?: string): Array<SessionMetadata> {
  const sessionsDir = path.join(os.homedir(), `.claude`, `sessions`)
  if (!fs.existsSync(sessionsDir)) return []

  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(`.json`))
  const sessions: Array<SessionMetadata> = []

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), `utf-8`)
      const meta = JSON.parse(content) as SessionMetadata
      if (!isProcessAlive(meta.pid)) continue
      if (filterCwd && meta.cwd !== filterCwd) continue

      // Verify the JSONL file exists
      const jsonlPath = getSessionJsonlPath(meta.sessionId, meta.cwd)
      if (!fs.existsSync(jsonlPath)) continue

      sessions.push(meta)
    } catch {
      // Skip invalid session files
    }
  }

  return sessions
}

/**
 * Find the byte offset of the last compaction boundary in a JSONL file.
 * Scans backwards from the end of the file.
 * Returns 0 if no boundary is found (read from beginning).
 */
export function findLastCompactionBoundary(filePath: string): number {
  const content = fs.readFileSync(filePath, `utf-8`)
  const lines = content.split(`\n`)

  // Build byte offset index
  let offset = 0
  const lineOffsets: Array<number> = []
  for (const line of lines) {
    lineOffsets.push(offset)
    offset += Buffer.byteLength(line, `utf-8`) + 1 // +1 for newline
  }

  // Scan backwards for compact_boundary
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type === `system` && entry.subtype === `compact_boundary`) {
        return lineOffsets[i]
      }
    } catch {
      continue
    }
  }

  return 0 // No boundary found, read from beginning
}

/**
 * Read JSONL lines from a file starting at a byte offset.
 * Returns the lines and the new byte offset.
 */
export function readLinesFromOffset(
  filePath: string,
  byteOffset: number
): { lines: Array<string>; newOffset: number } {
  const fd = fs.openSync(filePath, `r`)
  try {
    const stat = fs.fstatSync(fd)
    const bytesToRead = stat.size - byteOffset
    if (bytesToRead <= 0) return { lines: [], newOffset: byteOffset }

    const buffer = Buffer.alloc(bytesToRead)
    fs.readSync(fd, buffer, 0, bytesToRead, byteOffset)

    const text = buffer.toString(`utf-8`)

    // Find the last newline — only consume complete lines
    const lastNewline = text.lastIndexOf(`\n`)
    if (lastNewline === -1) {
      // No complete line yet
      return { lines: [], newOffset: byteOffset }
    }

    // Take everything up to and including the last newline
    const completeText = text.slice(0, lastNewline + 1)
    const consumedBytes = Buffer.byteLength(completeText, `utf-8`)

    // Split into lines and filter out empty ones
    const lines = completeText.split(`\n`).filter((line) => line.trim())

    return { lines, newOffset: byteOffset + consumedBytes }
  } finally {
    fs.closeSync(fd)
  }
}
