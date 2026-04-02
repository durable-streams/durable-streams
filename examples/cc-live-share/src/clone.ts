/**
 * cods clone: import a forked CC session from DS + set up code + create local session.
 *
 * Two modes:
 * - Default: uses `claude -c --fork-session` to let CC handle session creation.
 *   Slower (~3s API call) but resilient to CC format changes.
 * - --fast: manually rewrites JSONL fields (cwd, sessionId, gitBranch).
 *   Instant but coupled to CC's internal JSONL structure.
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
  fast?: boolean
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

  const shortId = Math.random().toString(36).slice(2, 10)
  const clonePath = path.resolve(`session-${shortId}`)
  const cloneBranch = `cc-session/clone-${shortId}`

  try {
    if (inMatchingRepo) {
      console.log(`  Detected matching repo, creating worktree...`)
      importBranchWorktree(repoCwd, metadata.branch, cloneBranch, clonePath)
      console.log(`  Created worktree at ${clonePath}`)
    } else {
      console.log(`  Cloning ${metadata.repo}...`)
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

  // === Read session JSONL from DS ===
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

  const cloneProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(clonePath)
  )
  fs.mkdirSync(cloneProjectDir, { recursive: true })

  if (options.fast) {
    // === Fast mode: manual JSONL rewriting ===
    const newSessionId = crypto.randomUUID()
    const jsonlLines = entries.map((entry) => JSON.stringify(entry))
    const rewrittenLines = rewriteJsonlLines(
      jsonlLines,
      metadata.sessionId,
      newSessionId,
      metadata.originalCwd,
      clonePath,
      cloneBranch
    )

    const jsonlPath = path.join(cloneProjectDir, `${newSessionId}.jsonl`)
    const jsonlContent =
      rewrittenLines
        .map((line) => sanitizeJsonLine(line))
        .filter(Boolean)
        .join(`\n`) + `\n`
    fs.writeFileSync(jsonlPath, jsonlContent)
    console.log(`  New session ID: ${newSessionId}`)
    console.log(`  Wrote ${rewrittenLines.length} entries (fast mode)`)
  } else {
    // === Default mode: fork via CC's --fork-session ===
    // Write original JSONL so `claude -c` finds it
    const originalJsonlPath = path.join(
      cloneProjectDir,
      `${metadata.sessionId}.jsonl`
    )
    const jsonlContent =
      entries
        .map((entry) => sanitizeJsonLine(JSON.stringify(entry)))
        .filter(Boolean)
        .join(`\n`) + `\n`
    fs.writeFileSync(originalJsonlPath, jsonlContent)
    console.log(`  Wrote ${entries.length} entries temporarily`)
    console.log(`  Forking session via Claude Code...`)

    try {
      const forkPrompt = `This session has been cloned to a new working directory: ${clonePath}. File paths in the conversation history may refer to the original location. Treat all paths as relative to the current working directory. This may be a different machine, so absolute paths outside this working directory may not exist — only rely on files within the working directory. Acknowledge briefly.`
      execSync(
        `claude -c --fork-session -p ${JSON.stringify(forkPrompt)} --max-turns 0`,
        {
          cwd: clonePath,
          encoding: `utf-8`,
          stdio: [`pipe`, `pipe`, `pipe`],
        }
      )
      console.log(`  Session forked successfully`)
    } catch (err) {
      const error = err as { stderr?: string }
      console.error(`Failed to fork session via Claude Code.`)
      console.error(`Make sure 'claude' is installed and accessible.`)
      if (error.stderr) console.error(error.stderr)
      process.exit(1)
    }

    // Clean up the original JSONL (the fork created its own)
    try {
      fs.unlinkSync(originalJsonlPath)
    } catch {
      // Best effort
    }
  }

  // === Resume or print instructions ===
  if (options.resume) {
    console.log(`\nStarting Claude Code...`)
    try {
      execSync(`claude --continue`, {
        cwd: clonePath,
        stdio: `inherit`,
      })
    } catch {
      // CC exited
    }
  } else {
    console.log(`\nReady! Start the session with:`)
    console.log(`  cd ${clonePath} && claude --continue`)
  }
}
