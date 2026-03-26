/**
 * ds-cc fork: export a CC session to DS + push git branch with working state.
 */

import * as fs from "node:fs"
import { DurableStream } from "@durable-streams/client"
import {
  findActiveSessions,
  findLastCompactionBoundary,
  getSessionJsonlPath,
  readLinesFromOffset,
} from "./session.js"
import { sanitizeJsonLine } from "./sanitize.js"
import { exportBranch, getRemoteUrl, isGitRepo } from "./git.js"

interface ForkOptions {
  sessionId?: string
  server: string
  remote?: string
}

export async function fork(options: ForkOptions): Promise<void> {
  const remote = options.remote ?? `origin`

  // Resolve session
  let sessionId = options.sessionId
  let cwd: string

  if (!sessionId) {
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
      console.error(`\nUse --session <id> to specify which one to fork.`)
      process.exit(1)
    }
    sessionId = sessions[0].sessionId
    cwd = sessions[0].cwd
    console.log(`Detected active session: ${sessionId} (${cwd})`)
  } else {
    const allSessions = findActiveSessions()
    const match = allSessions.find((s) => s.sessionId === sessionId)
    if (match) {
      cwd = match.cwd
    } else {
      cwd = process.cwd()
    }
  }

  // Verify git repo
  if (!isGitRepo(cwd)) {
    console.error(`Working directory is not a git repository: ${cwd}`)
    console.error(`Phase 2 requires a git repo for code state transfer.`)
    process.exit(1)
  }

  const jsonlPath = getSessionJsonlPath(sessionId, cwd)
  if (!fs.existsSync(jsonlPath)) {
    console.error(`Session JSONL not found: ${jsonlPath}`)
    process.exit(1)
  }

  // Get repo URL
  let repoUrl: string
  try {
    repoUrl = getRemoteUrl(cwd, remote)
  } catch {
    console.error(
      `Could not get remote URL for '${remote}'.\n` +
        `Use --remote <name> to specify a different remote.`
    )
    process.exit(1)
  }

  // === Export session to DS ===
  console.log(`\nExporting session to Durable Stream...`)

  const sessionStreamUrl = `${options.server}/cc/${sessionId}/session`
  const metaStreamUrl = `${options.server}/cc/${sessionId}/meta`
  const branchName = `cc-session/${sessionId}`

  // Create session stream
  try {
    await DurableStream.create({
      url: sessionStreamUrl,
      contentType: `application/json`,
    })
  } catch (err: unknown) {
    if (err instanceof Error && !err.message.includes(`409`)) throw err
  }

  const sessionStream = new DurableStream({
    url: sessionStreamUrl,
    contentType: `application/json`,
  })

  // Write JSONL from compaction boundary
  const startOffset = findLastCompactionBoundary(jsonlPath)
  const { lines } = readLinesFromOffset(jsonlPath, startOffset)

  let count = 0
  for (const line of lines) {
    const sanitized = sanitizeJsonLine(line)
    if (!sanitized) continue
    await sessionStream.append(sanitized)
    count++
  }
  console.log(`  Session stream: ${sessionStreamUrl}`)
  console.log(`  Wrote ${count} JSONL entries`)

  // Create and write metadata stream
  try {
    await DurableStream.create({
      url: metaStreamUrl,
      contentType: `application/json`,
    })
  } catch (err: unknown) {
    if (err instanceof Error && !err.message.includes(`409`)) throw err
  }

  const metaStream = new DurableStream({
    url: metaStreamUrl,
    contentType: `application/json`,
  })

  const metadata = {
    type: `fork-metadata`,
    version: 1,
    sessionId,
    repo: repoUrl,
    branch: branchName,
    originalCwd: cwd,
    createdAt: new Date().toISOString(),
  }
  await metaStream.append(JSON.stringify(metadata))
  console.log(`  Metadata stream: ${metaStreamUrl}`)

  // === Push git branch ===
  console.log(`\nPushing code state to git...`)
  console.log(
    `  \u26A0 Warning: This will commit all working changes (respecting .gitignore) to branch ${branchName}`
  )

  exportBranch(cwd, branchName, remote)
  console.log(`  Created and pushed branch: ${branchName}`)

  // === Done ===
  const forkUrl = `${options.server}/cc/${sessionId}`
  console.log(`\nFork URL: ${forkUrl}`)
  console.log(`\nShare this URL. Others can clone it with:`)
  console.log(`  ds-cc clone --server ${options.server} ${forkUrl}`)
}
