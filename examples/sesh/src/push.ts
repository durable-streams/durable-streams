/**
 * Push session content to Durable Streams.
 * Reads JSONL, finds delta since last push, writes to DS.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { DurableStream } from "@durable-streams/client"
import {
  getAuthHeaders,
  readConfig,
  readLocalState,
  writeLocalState,
} from "./config.js"
import {
  getLocalJsonlPath,
  listSessionFiles,
  writeSessionFile,
} from "./sessions.js"
import { sanitizeJsonLine } from "./sanitize.js"
import type { SessionFile } from "./sessions.js"

interface PushResult {
  sessionId: string
  entriesPushed: number
  newOffset: string | null
  skipped: boolean
  reason?: string
}

/**
 * Find the start point for reading JSONL entries to push.
 * Scans backwards from end to find lastPushedUuid or compact_boundary.
 * Returns the line index to start reading from.
 */
function findPushStartLine(
  lines: Array<string>,
  lastPushedUuid: string | undefined
): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>

      // Found our last pushed entry — start from the next one
      if (lastPushedUuid && entry.uuid === lastPushedUuid) {
        return i + 1
      }

      // Found a compaction boundary — start from here
      if (entry.type === `system` && entry.subtype === `compact_boundary`) {
        return i
      }
    } catch {
      continue
    }
  }

  // Neither found — start from beginning
  return 0
}

/**
 * Push a single session's delta to DS.
 */
async function pushSession(
  repoRoot: string,
  session: SessionFile
): Promise<PushResult> {
  const config = readConfig(repoRoot)
  if (!config) {
    return {
      sessionId: session.sessionId,
      entriesPushed: 0,
      newOffset: null,
      skipped: true,
      reason: `not initialized`,
    }
  }

  // Find local JSONL — resolve relative cwd against repo root
  // Use realpath to handle macOS /tmp → /private/tmp symlinks
  const resolvedCwd = path.isAbsolute(session.cwd)
    ? session.cwd
    : path.join(repoRoot, session.cwd)
  const absoluteCwd = fs.realpathSync(resolvedCwd)
  const jsonlPath = getLocalJsonlPath(session.sessionId, absoluteCwd)
  if (!fs.existsSync(jsonlPath)) {
    return {
      sessionId: session.sessionId,
      entriesPushed: 0,
      newOffset: null,
      skipped: true,
      reason: `not local`,
    }
  }

  // Read JSONL
  const content = fs.readFileSync(jsonlPath, `utf-8`)
  const lines = content.split(`\n`).filter((l) => l.trim())

  if (lines.length === 0) {
    return {
      sessionId: session.sessionId,
      entriesPushed: 0,
      newOffset: session.lastOffset,
      skipped: true,
      reason: `empty`,
    }
  }

  // Find where to start pushing
  const localState = readLocalState(repoRoot, session.sessionId)
  const startLine = findPushStartLine(lines, localState.lastPushedUuid)

  // Nothing new to push
  if (startLine >= lines.length) {
    return {
      sessionId: session.sessionId,
      entriesPushed: 0,
      newOffset: session.lastOffset,
      skipped: true,
      reason: `up to date`,
    }
  }

  const linesToPush = lines.slice(startLine)
  const headers = getAuthHeaders(repoRoot)

  // Create stream if needed
  let streamUrl = session.streamUrl
  if (!streamUrl) {
    streamUrl = `${config.server}/sesh/${session.sessionId}`
    try {
      await DurableStream.create({
        url: streamUrl,
        contentType: `application/json`,
        headers,
      })
    } catch (err: unknown) {
      // 409 = already exists, that's fine
      if (err instanceof Error && !err.message.includes(`409`)) throw err
    }
  }

  // Push entries
  const stream = new DurableStream({
    url: streamUrl,
    contentType: `application/json`,
    headers,
  })

  for (const line of linesToPush) {
    const sanitized = sanitizeJsonLine(line)
    if (!sanitized) continue
    await stream.append(sanitized)
  }

  // Get the current offset from the stream via HEAD
  const headRes = await fetch(streamUrl, { method: `HEAD`, headers })
  const lastOffset =
    headRes.headers.get(`stream-next-offset`) ?? session.lastOffset

  // Find the UUID of the last entry we pushed
  let lastPushedUuid: string | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as Record<string, unknown>
      if (typeof entry.uuid === `string`) {
        lastPushedUuid = entry.uuid
        break
      }
    } catch {
      continue
    }
  }

  // Update local state
  writeLocalState(repoRoot, session.sessionId, { lastPushedUuid })

  // Update session file — track total entries in the stream
  const updated: SessionFile = {
    ...session,
    streamUrl,
    lastOffset,
    entryCount: session.entryCount + linesToPush.length,
  }
  writeSessionFile(repoRoot, updated)

  return {
    sessionId: session.sessionId,
    entriesPushed: linesToPush.length,
    newOffset: lastOffset,
  }
}

/**
 * Push all checked-in sessions.
 */
export async function pushAll(repoRoot: string): Promise<Array<PushResult>> {
  const sessions = listSessionFiles(repoRoot)
  const results: Array<PushResult> = []

  for (const session of sessions) {
    const result = await pushSession(repoRoot, session)
    results.push(result)
  }

  return results
}
