/**
 * ds-cc clone: import a forked CC session from DS + set up code + fork session via CC.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execSync } from "node:child_process"
import {
  cloneAndCheckout,
  hasMatchingRemote,
  importBranchWorktree,
  isGitRepo,
} from "./git.js"
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

  // === Fetch code ===
  console.log(`\nFetching code...`)

  const repoCwd = process.cwd()
  const inMatchingRepo =
    isGitRepo(repoCwd) && hasMatchingRemote(repoCwd, metadata.repo)

  // For worktree mode we need a new branch name; for fresh clone we reuse the export branch
  const shortId = Math.random().toString(36).slice(2, 10)
  const clonePath = path.resolve(`session-${shortId}`)

  try {
    if (inMatchingRepo) {
      console.log(`  Detected matching repo, creating worktree...`)
      // Worktree needs a unique branch name
      const worktreeBranch = `cc-session/clone-${shortId}`
      importBranchWorktree(repoCwd, metadata.branch, worktreeBranch, clonePath)
      console.log(`  Created worktree at ${clonePath}`)
    } else {
      console.log(`  Cloning ${metadata.repo}...`)
      const cloneBranch = `cc-session/clone-${shortId}`
      cloneAndCheckout(metadata.repo, metadata.branch, cloneBranch, clonePath)
      console.log(`  Cloned to ${clonePath}`)
    }
  } catch (err) {
    console.error(
      `Failed to fetch code. Make sure you have access to the repo.`
    )
    console.error(err)
    process.exit(1)
  }

  // === Restore original session JSONL temporarily ===
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

  // Write the original JSONL as-is (no rewriting) under the original cwd
  // so that `claude -r <session-id>` can find it
  const originalEncodedCwd = encodeCwd(metadata.originalCwd)
  const originalProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    originalEncodedCwd
  )
  fs.mkdirSync(originalProjectDir, { recursive: true })

  const originalJsonlPath = path.join(
    originalProjectDir,
    `${metadata.sessionId}.jsonl`
  )
  const jsonlContent =
    entries
      .map((entry) => sanitizeJsonLine(JSON.stringify(entry)))
      .filter(Boolean)
      .join(`\n`) + `\n`

  // Check if the file already exists (don't overwrite an active session)
  const jsonlExisted = fs.existsSync(originalJsonlPath)
  if (!jsonlExisted) {
    fs.writeFileSync(originalJsonlPath, jsonlContent)
  }
  console.log(`  Wrote ${entries.length} JSONL entries temporarily`)

  // === Fork the session using CC's --fork-session ===
  console.log(`  Forking session via Claude Code...`)

  try {
    execSync(
      `claude -r ${metadata.sessionId} --fork-session -p "Session cloned from fork. Ready to continue."`,
      {
        cwd: clonePath,
        encoding: `utf-8`,
        stdio: [`pipe`, `pipe`, `pipe`],
      }
    )
  } catch (err) {
    console.error(`Failed to fork session via Claude Code.`)
    console.error(`Make sure 'claude' is installed and accessible.`)
    const error = err as { stderr?: string }
    if (error.stderr) console.error(error.stderr)
    process.exit(1)
  }

  // Clean up the temporary original JSONL (only if we created it)
  if (!jsonlExisted) {
    try {
      fs.unlinkSync(originalJsonlPath)
      // Remove the directory if empty
      const remaining = fs.readdirSync(originalProjectDir)
      if (remaining.length === 0) {
        fs.rmdirSync(originalProjectDir)
      }
    } catch {
      // Best effort cleanup
    }
  }

  console.log(`  Session forked successfully`)

  // === Resume or print instructions ===
  if (options.resume) {
    console.log(`\nStarting Claude Code...`)
    try {
      execSync(`claude --continue`, {
        cwd: clonePath,
        stdio: `inherit`,
      })
    } catch {
      // CC exited — that's fine
    }
  } else {
    console.log(`\nReady! Start the session with:`)
    console.log(`  cd ${clonePath} && claude --continue`)
  }
}
