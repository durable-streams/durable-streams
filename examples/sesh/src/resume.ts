/**
 * Resume (fork) a session from the index.
 * Reads from DS, creates a local CC session.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { execSync } from "node:child_process"
import {
  denormalize,
  writeCodexSession,
} from "@durable-streams/agent-session-protocol"
import type {
  AgentType,
  NormalizedEvent,
} from "@durable-streams/agent-session-protocol"
import { getAuthHeaders, readConfig } from "./config.js"
import {
  encodeCwd,
  getGitUser,
  readSessionFile,
  writeSessionFile,
} from "./sessions.js"
import { sanitizeJsonLine } from "./sanitize.js"
import type { SessionFile } from "./sessions.js"

interface ResumeOptions {
  sessionId: string
  repoRoot: string
  noCheckin?: boolean
  atCommit?: string
  targetAgent?: AgentType
}

interface ResumeResult {
  newSessionId: string
  cwd: string
  entriesRestored: number
}

/**
 * Read a session file from a specific git commit.
 */
function readSessionAtCommit(
  repoRoot: string,
  sessionId: string,
  commit: string
): SessionFile | null {
  try {
    const content = execSync(
      `git show ${commit}:.sesh/sessions/${sessionId}.json`,
      { cwd: repoRoot, encoding: `utf-8`, stdio: [`pipe`, `pipe`, `pipe`] }
    )
    return JSON.parse(content) as SessionFile
  } catch {
    return null
  }
}

export async function resume(options: ResumeOptions): Promise<ResumeResult> {
  const { sessionId, repoRoot, noCheckin, atCommit, targetAgent } = options

  // Read session file (from specific commit if --at specified)
  let session: SessionFile | null
  if (atCommit) {
    session = readSessionAtCommit(repoRoot, sessionId, atCommit)
    if (!session) {
      throw new Error(`Session ${sessionId} not found at commit ${atCommit}`)
    }
  } else {
    session = readSessionFile(repoRoot, sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found in index`)
    }
  }

  if (!session.streamUrl || !session.lastOffset) {
    throw new Error(
      `Session ${sessionId} has not been pushed to DS yet. Run 'sesh push' first.`
    )
  }

  const config = readConfig(repoRoot)
  if (!config) {
    throw new Error(`sesh not initialized. Run 'sesh init' first.`)
  }

  const headers = getAuthHeaders(repoRoot)

  // Construct the stream URL from the config server + the relative stream path.
  // The stored streamUrl might point to a different host (e.g., localhost)
  // than the current config server (e.g., ngrok or VM IP).
  let streamUrl = session.streamUrl
  const streamPath = new URL(streamUrl).pathname
  const serverPath = new URL(config.server).pathname
  // Strip the server base path to get the relative portion (e.g., /sesh/<id>)
  const relativePath = streamPath.startsWith(serverPath)
    ? streamPath.slice(serverPath.length)
    : streamPath
  streamUrl = `${config.server}${relativePath}`

  // Read from DS — try checkpoint first, fall back to beginning
  const readUrl = `${streamUrl}?offset=compact`
  const checkpointRes = await fetch(readUrl, {
    redirect: `manual`,
    headers,
  })

  let startOffset: string
  if (checkpointRes.status === 307) {
    const location = checkpointRes.headers.get(`location`)!
    // Extract the offset from the redirect URL
    const redirectUrl = new URL(location, streamUrl)
    const redirectOffset = redirectUrl.searchParams.get(`offset`) ?? `-1`

    // If resuming at a specific commit, check if checkpoint is before our target
    if (
      atCommit &&
      redirectOffset !== `-1` &&
      redirectOffset > session.lastOffset
    ) {
      // Checkpoint is after our target offset — read from beginning instead
      startOffset = `-1`
    } else {
      startOffset = redirectOffset
    }
  } else {
    startOffset = `-1`
  }

  // Read the stream content
  const streamRes = await fetch(
    `${streamUrl}?offset=${encodeURIComponent(startOffset)}`,
    { headers }
  )
  if (!streamRes.ok) {
    throw new Error(`Failed to read DS stream: ${streamRes.status}`)
  }

  const body = await streamRes.text()
  let entries: Array<unknown> = []
  if (body.trim()) {
    try {
      const parsed = JSON.parse(body)
      entries = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      throw new Error(`Invalid data from DS stream`)
    }
  }

  // Truncate entries to match the entry count recorded in the session file.
  // This handles both --at <commit> and the git checkout workflow, where the
  // session file on disk has the historical entryCount.
  if (session.entryCount > 0) {
    entries = entries.slice(0, session.entryCount)
  }

  // Generate new session ID
  const newSessionId = crypto.randomUUID()
  const cwd = session.cwd

  // Make cwd absolute relative to repo root
  const absoluteCwd = path.isAbsolute(cwd) ? cwd : path.join(repoRoot, cwd)

  const sourceAgent = (session.agent ?? `claude`) as AgentType
  const resolvedTargetAgent = targetAgent ?? sourceAgent

  if (sourceAgent === resolvedTargetAgent) {
    // Same-agent resume: use native stream with string rewrites (lossless)
    const projectDir = path.join(
      os.homedir(),
      `.claude`,
      `projects`,
      encodeCwd(absoluteCwd)
    )

    if (resolvedTargetAgent === `claude`) {
      fs.mkdirSync(projectDir, { recursive: true })
      const jsonlPath = path.join(projectDir, `${newSessionId}.jsonl`)
      const jsonlContent =
        entries
          .map((entry) => {
            const line = JSON.stringify(entry)
            return line
              .replaceAll(
                `"sessionId":"${session.sessionId}"`,
                `"sessionId":"${newSessionId}"`
              )
              .replaceAll(`"cwd":"${session.cwd}"`, `"cwd":"${absoluteCwd}"`)
          })
          .map((line) => sanitizeJsonLine(line))
          .filter(Boolean)
          .join(`\n`) + `\n`
      fs.writeFileSync(jsonlPath, jsonlContent)
    } else if (resolvedTargetAgent === `codex`) {
      const rewrittenLines = entries.map((entry) => {
        const line = JSON.stringify(entry)
        return line
          .replaceAll(session.sessionId, newSessionId)
          .replaceAll(session.cwd, absoluteCwd)
      })
      writeCodexSession(newSessionId, rewrittenLines)
    }
  } else {
    // Cross-agent resume: read from normalized stream, denormalize to target
    const normalizedUrl = `${streamUrl}/normalized`
    const normalizedRes = await fetch(
      `${normalizedUrl}?offset=-1`,
      { headers }
    )

    let normalizedEvents: Array<NormalizedEvent> = []
    if (normalizedRes.ok) {
      const normalizedBody = await normalizedRes.text()
      if (normalizedBody.trim()) {
        const parsed = JSON.parse(normalizedBody)
        normalizedEvents = Array.isArray(parsed) ? parsed : [parsed]
      }
    }

    if (normalizedEvents.length === 0) {
      throw new Error(
        `No normalized stream found for cross-agent resume. ` +
          `Push the session first with a version that supports cross-agent export.`
      )
    }

    const targetLines = denormalize(normalizedEvents, resolvedTargetAgent, {
      sessionId: newSessionId,
      cwd: absoluteCwd,
    })

    if (resolvedTargetAgent === `claude`) {
      const projectDir = path.join(
        os.homedir(),
        `.claude`,
        `projects`,
        encodeCwd(absoluteCwd)
      )
      fs.mkdirSync(projectDir, { recursive: true })
      const jsonlPath = path.join(projectDir, `${newSessionId}.jsonl`)
      fs.writeFileSync(jsonlPath, targetLines.join(`\n`) + `\n`)
    } else if (resolvedTargetAgent === `codex`) {
      writeCodexSession(newSessionId, targetLines)
    }
  }

  // Create session file in index (unless --no-checkin)
  if (!noCheckin) {
    const newSession: SessionFile = {
      sessionId: newSessionId,
      parentSessionId: session.sessionId,
      streamUrl: null,
      lastOffset: null,
      entryCount: 0,
      name: `${session.name} (resumed)`,
      cwd: session.cwd,
      agent: resolvedTargetAgent,
      createdBy: getGitUser(),
      forkedFromOffset: session.lastOffset,
    }
    writeSessionFile(repoRoot, newSession)
  }

  return {
    newSessionId,
    cwd: absoluteCwd,
    entriesRestored: entries.length,
  }
}
