/**
 * ds-cc clone: import a forked CC session from DS + set up worktree + rewrite JSONL.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { execSync } from "node:child_process"
import {
  cloneAndCheckout,
  hasMatchingRemote,
  importBranchWorktree,
  isGitRepo,
} from "./git.js"
import { rewriteJsonlLines } from "./rewrite.js"
import { sanitizeJsonLine } from "./sanitize.js"

interface CloneOptions {
  forkUrl: string
  resume?: boolean
}

interface ForkMetadata {
  type: string
  version: number
  sessionId: string
  repo: string
  branch: string
  originalCwd: string
  createdAt: string
}

/**
 * Encode a working directory path for CC's file naming convention.
 */
function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, `-`)
}

export async function clone(options: CloneOptions): Promise<void> {
  const { forkUrl } = options

  // === Read metadata ===
  console.log(`Reading fork metadata...`)

  const metaStreamUrl = `${forkUrl}/meta`
  const metaRes = await fetch(`${metaStreamUrl}?offset=-1`)
  if (!metaRes.ok) {
    console.error(`Could not read metadata stream: ${metaRes.status}`)
    console.error(`Make sure the fork URL is correct: ${forkUrl}`)
    process.exit(1)
  }

  const metaBody = await metaRes.text()
  let metadata: ForkMetadata
  try {
    const parsed = JSON.parse(metaBody)
    // DS JSON mode returns an array
    metadata = Array.isArray(parsed) ? parsed[0] : parsed
  } catch {
    console.error(`Invalid metadata format`)
    process.exit(1)
  }

  console.log(`  Repo: ${metadata.repo}`)
  console.log(`  Branch: ${metadata.branch}`)
  console.log(`  Original cwd: ${metadata.originalCwd}`)

  // === Generate new session ID ===
  const newSessionId = crypto.randomUUID()
  const newBranchName = `cc-session/${newSessionId}`
  const shortId = newSessionId.slice(0, 8)
  const worktreePath = path.resolve(`session-${shortId}`)

  // === Fetch code ===
  console.log(`\nFetching code...`)

  const repoCwd = process.cwd()
  const inMatchingRepo =
    isGitRepo(repoCwd) && hasMatchingRemote(repoCwd, metadata.repo)

  try {
    if (inMatchingRepo) {
      // We're inside the right repo — use a worktree for isolation
      console.log(`  Detected matching repo, creating worktree...`)
      importBranchWorktree(
        repoCwd,
        metadata.branch,
        newBranchName,
        worktreePath
      )
      console.log(
        `  Created worktree at ${worktreePath} on branch ${newBranchName}`
      )
    } else {
      // Not in the right repo — do a fresh clone
      console.log(`  Cloning ${metadata.repo}...`)
      cloneAndCheckout(
        metadata.repo,
        metadata.branch,
        newBranchName,
        worktreePath
      )
      console.log(`  Cloned to ${worktreePath} on branch ${newBranchName}`)
    }
  } catch (err) {
    console.error(
      `Failed to fetch code. Make sure you have access to the repo.`
    )
    console.error(err)
    process.exit(1)
  }

  // === Read and rewrite JSONL ===
  console.log(`\nRestoring CC session...`)

  const sessionStreamUrl = `${forkUrl}/session`
  const sessionRes = await fetch(`${sessionStreamUrl}?offset=-1`)
  if (!sessionRes.ok) {
    console.error(`Could not read session stream: ${sessionRes.status}`)
    process.exit(1)
  }

  const sessionBody = await sessionRes.text()
  let entries: Array<unknown>
  try {
    entries = JSON.parse(sessionBody)
    if (!Array.isArray(entries)) {
      entries = [entries]
    }
  } catch {
    console.error(`Invalid session data format`)
    process.exit(1)
  }

  // Convert back to individual JSONL lines
  const jsonlLines = entries.map((entry) => JSON.stringify(entry))

  // Rewrite path-sensitive fields
  const rewrittenLines = rewriteJsonlLines(
    jsonlLines,
    metadata.sessionId,
    newSessionId,
    metadata.originalCwd,
    worktreePath,
    newBranchName
  )

  // Write JSONL to CC's expected location
  const claudeProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(worktreePath)
  )
  fs.mkdirSync(claudeProjectDir, { recursive: true })

  const jsonlPath = path.join(claudeProjectDir, `${newSessionId}.jsonl`)
  const jsonlContent =
    rewrittenLines
      .map((line) => sanitizeJsonLine(line))
      .filter(Boolean)
      .join(`\n`) + `\n`
  fs.writeFileSync(jsonlPath, jsonlContent)

  console.log(`  New session ID: ${newSessionId}`)
  console.log(`  Wrote ${rewrittenLines.length} JSONL entries to ${jsonlPath}`)

  // === Resume or print instructions ===
  if (options.resume) {
    console.log(`\nStarting Claude Code...`)
    try {
      execSync(`claude --continue`, {
        cwd: worktreePath,
        stdio: `inherit`,
      })
    } catch {
      // CC exited — that's fine
    }
  } else {
    console.log(`\nReady! Start the session with:`)
    console.log(`  cd ${worktreePath} && claude --continue`)
  }
}
