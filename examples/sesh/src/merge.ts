/**
 * Merge two local sessions.
 * Uses git merge for code + agent-assisted conflict resolution.
 * Creates a merged session with combined context.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { execSync } from "node:child_process"
import { findRepoRoot } from "./config.js"
import {
  encodeCwd,
  getGitUser,
  readSessionFile,
  writeSessionFile,
} from "./sessions.js"
import { sanitizeJsonLine } from "./sanitize.js"
import type { SessionFile } from "./sessions.js"

/**
 * Resolve the Claude JSONL path for a session. Merge is Claude-specific
 * (JSONL shape is baked into the conflict-resolution flow), so hardcoding
 * the Claude layout here is intentional.
 */
function claudeJsonlPath(sessionId: string, cwd: string): string {
  return path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(cwd),
    `${sessionId}.jsonl`
  )
}

interface MergeOptions {
  sessionA: string
  sessionB: string
  repoRoot: string
}

function git(command: string, cwd: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: `utf-8`,
    stdio: [`pipe`, `pipe`, `pipe`],
  }).trim()
}

function gitMayFail(
  command: string,
  cwd: string
): { stdout: string; ok: boolean } {
  try {
    const stdout = git(command, cwd)
    return { stdout, ok: true }
  } catch {
    return { stdout: ``, ok: false }
  }
}

function claude(prompt: string, cwd: string): string {
  return execSync(`claude -p --model haiku --max-turns 0`, {
    cwd,
    encoding: `utf-8`,
    input: prompt,
    stdio: [`pipe`, `pipe`, `pipe`],
  }).trim()
}

function claudeAgent(prompt: string, cwd: string): void {
  const tmpFile = path.join(os.tmpdir(), `sesh-merge-prompt-${Date.now()}.txt`)
  fs.writeFileSync(tmpFile, prompt)
  try {
    execSync(`cat ${tmpFile} | claude -p --dangerously-skip-permissions`, {
      cwd,
      encoding: `utf-8`,
      stdio: `inherit`,
    })
  } finally {
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      // best effort
    }
  }
}

/**
 * Find a session's local JSONL and extract messages for summarization.
 */
function extractMessages(
  sessionId: string,
  cwd: string,
  maxMessages: number,
  maxChars: number
): string {
  const absoluteCwd = path.isAbsolute(cwd)
    ? cwd
    : path.join(findRepoRoot() ?? process.cwd(), cwd)
  const realCwd = fs.existsSync(absoluteCwd)
    ? fs.realpathSync(absoluteCwd)
    : absoluteCwd
  const jsonlPath = claudeJsonlPath(sessionId, realCwd)
  if (!fs.existsSync(jsonlPath)) return `(session JSONL not found locally)`

  const content = fs.readFileSync(jsonlPath, `utf-8`)
  const lines = content.trim().split(`\n`)
  const messages: Array<string> = []

  for (const line of lines) {
    try {
      const e = JSON.parse(line) as Record<string, unknown>
      if (e.type === `user` && e.message) {
        const msg = e.message as { content?: unknown }
        if (typeof msg.content === `string`) {
          messages.push(`User: ${msg.content.slice(0, maxChars)}`)
        }
      } else if ((!e.type || e.type === `assistant`) && e.message) {
        const msg = e.message as { role?: string; content?: unknown }
        if (msg.role === `assistant` && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            const b = block as Record<string, unknown>
            if (b.type === `text` && typeof b.text === `string`) {
              messages.push(`Assistant: ${b.text.slice(0, maxChars)}`)
            }
          }
        }
      }
    } catch {
      continue
    }
  }

  return messages.slice(-maxMessages).join(`\n`)
}

export function merge(options: MergeOptions): void {
  const { repoRoot } = options

  // Find both sessions
  console.log(`Finding sessions...`)
  const sessionA = readSessionFile(repoRoot, options.sessionA)
  if (!sessionA) {
    console.error(`Session not found: ${options.sessionA}`)
    process.exit(1)
  }
  console.log(
    `  Session A: ${sessionA.sessionId.slice(0, 8)} "${sessionA.name}" by ${sessionA.createdBy}`
  )

  const sessionB = readSessionFile(repoRoot, options.sessionB)
  if (!sessionB) {
    console.error(`Session not found: ${options.sessionB}`)
    process.exit(1)
  }
  console.log(
    `  Session B: ${sessionB.sessionId.slice(0, 8)} "${sessionB.name}" by ${sessionB.createdBy}`
  )

  // We need git branches for the code merge.
  // Read the gitBranch from the sessions' JSONL files.
  const branchA = getGitBranchFromJsonl(sessionA, repoRoot)
  const branchB = getGitBranchFromJsonl(sessionB, repoRoot)

  if (!branchA || !branchB) {
    console.error(`Could not determine git branches for the sessions.`)
    console.error(`  Session A branch: ${branchA ?? `unknown`}`)
    console.error(`  Session B branch: ${branchB ?? `unknown`}`)
    process.exit(1)
  }

  console.log(`  Branch A: ${branchA}`)
  console.log(`  Branch B: ${branchB}`)

  // Fetch latest
  gitMayFail(`fetch origin`, repoRoot)

  // Ensure branch B is available locally
  if (!gitMayFail(`rev-parse --verify ${branchB}`, repoRoot).ok) {
    gitMayFail(`branch ${branchB} origin/${branchB}`, repoRoot)
  }

  // Verify common ancestor
  const mergeBase = gitMayFail(`merge-base ${branchA} ${branchB}`, repoRoot)
  if (!mergeBase.ok) {
    console.error(`No common ancestor between branches.`)
    process.exit(1)
  }
  console.log(`  Common ancestor: ${mergeBase.stdout.slice(0, 8)}`)

  // Create merge worktree
  const mergeId = crypto.randomUUID().slice(0, 8)
  const mergeBranch = `sesh/merge-${mergeId}`
  const mergePath = path.join(repoRoot, `session-merge-${mergeId}`)

  console.log(`\nCreating merge worktree...`)
  git(`worktree add ${mergePath} -b ${mergeBranch} ${branchA}`, repoRoot)

  // Git merge
  console.log(`\nMerging code...`)
  const mergeResult = gitMayFail(
    `merge ${branchB} --no-commit --no-ff`,
    mergePath
  )

  let hasConflicts = false
  let conflictNotes = ``

  if (!mergeResult.ok) {
    const status = git(`status --porcelain`, mergePath)
    hasConflicts =
      status.includes(`UU `) || status.includes(`AA `) || status.includes(`DD `)
    if (hasConflicts) {
      console.log(`  Conflicts detected!`)
    } else {
      console.error(`Git merge failed.`)
      process.exit(1)
    }
  } else {
    console.log(`  Clean merge, no conflicts.`)
  }

  // Resolve conflicts
  if (hasConflicts) {
    console.log(`\nGenerating summaries for conflict resolution...`)
    const snippetA = extractMessages(sessionA.sessionId, sessionA.cwd, 20, 200)
    const summaryA = claude(
      `Here is a CC conversation:\n\n${snippetA}\n\nSummarize in 3-5 sentences.`,
      mergePath
    )
    const snippetB = extractMessages(sessionB.sessionId, sessionB.cwd, 20, 200)
    const summaryB = claude(
      `Here is a CC conversation:\n\n${snippetB}\n\nSummarize in 3-5 sentences.`,
      mergePath
    )

    console.log(`\nResolving conflicts...`)
    claudeAgent(
      `Two branches are being merged with conflicts.\n\nBranch A did: ${summaryA}\n\nBranch B did: ${summaryB}\n\nResolve all merge conflicts. Use git status to find them.`,
      mergePath
    )

    conflictNotes = `Conflicts resolved. A: ${summaryA} B: ${summaryB}`

    const postStatus = git(`status --porcelain`, mergePath)
    if (postStatus.includes(`UU `) || postStatus.includes(`AA `)) {
      console.error(`Unresolved conflicts remain. Fix manually in ${mergePath}`)
      process.exit(1)
    }
  }

  // Commit
  git(`add -A`, mergePath)
  gitMayFail(
    `commit --no-edit -m "Merge ${branchB} into ${branchA}"`,
    mergePath
  )
  console.log(`  Merge committed.`)

  // Generate detailed contexts
  console.log(`\nGenerating contexts for merged session...`)
  const detailA = extractMessages(sessionA.sessionId, sessionA.cwd, 30, 500)
  const contextA = claude(
    `Here is a CC conversation:\n\n${detailA}\n\nGive a detailed summary for a merged session.`,
    mergePath
  )
  const detailB = extractMessages(sessionB.sessionId, sessionB.cwd, 30, 500)
  const contextB = claude(
    `Here is a CC conversation:\n\n${detailB}\n\nGive a detailed summary for a merged session.`,
    mergePath
  )

  // Create merged session
  console.log(`\nCreating merged session...`)
  const mergedSessionId = crypto.randomUUID()

  // Read session A's JSONL as base
  const absoluteCwdA = path.isAbsolute(sessionA.cwd)
    ? sessionA.cwd
    : path.join(repoRoot, sessionA.cwd)
  const realCwdA = fs.existsSync(absoluteCwdA)
    ? fs.realpathSync(absoluteCwdA)
    : absoluteCwdA
  const jsonlPathA = claudeJsonlPath(sessionA.sessionId, realCwdA)

  let jsonlLines: Array<string> = []
  if (fs.existsSync(jsonlPathA)) {
    const content = fs.readFileSync(jsonlPathA, `utf-8`)
    jsonlLines = content
      .trim()
      .split(`\n`)
      .filter((l) => l.trim())
  }

  // Rewrite session ID and cwd
  const rewrittenLines = jsonlLines.map((line) =>
    line
      .replaceAll(
        `"sessionId":"${sessionA.sessionId}"`,
        `"sessionId":"${mergedSessionId}"`
      )
      .replaceAll(`"cwd":"${realCwdA}"`, `"cwd":"${mergePath}"`)
  )

  // Append merge context
  let lastUuid = `merge-parent`
  for (let i = jsonlLines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(jsonlLines[i]) as Record<string, unknown>
      if (typeof entry.uuid === `string`) {
        lastUuid = entry.uuid
        break
      }
    } catch {
      continue
    }
  }

  rewrittenLines.push(
    JSON.stringify({
      parentUuid: lastUuid,
      isSidechain: false,
      type: `user`,
      message: {
        role: `user`,
        content: `Two branches of work have been merged into this session.\n\nSession A (${branchA}):\n${contextA}\n\nSession B (${branchB}):\n${contextB}\n\n${conflictNotes ? `Conflict resolution: ${conflictNotes}\n\n` : ``}The code has been merged. The working directory is: ${mergePath}. File paths from session contexts may refer to different directories — only rely on files in this working directory.`,
      },
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: mergedSessionId,
      cwd: mergePath,
      gitBranch: mergeBranch,
    })
  )

  // Clean up intermediate sessions from the merge worktree's project dir
  const mergeProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(mergePath)
  )
  if (fs.existsSync(mergeProjectDir)) {
    for (const file of fs.readdirSync(mergeProjectDir)) {
      if (file.endsWith(`.jsonl`)) {
        fs.unlinkSync(path.join(mergeProjectDir, file))
      }
    }
  } else {
    fs.mkdirSync(mergeProjectDir, { recursive: true })
  }

  // Write merged JSONL
  const jsonlPath = path.join(mergeProjectDir, `${mergedSessionId}.jsonl`)
  fs.writeFileSync(
    jsonlPath,
    rewrittenLines
      .map((line) => sanitizeJsonLine(line))
      .filter(Boolean)
      .join(`\n`) + `\n`
  )

  // Create session file in sesh index
  writeSessionFile(repoRoot, {
    sessionId: mergedSessionId,
    parentSessionId: sessionA.sessionId,
    streamUrl: null,
    lastOffset: null,
    entryCount: 0,
    name: `merge(${sessionA.name}, ${sessionB.name})`,
    cwd: sessionA.cwd,
    agent: sessionA.agent,
    createdBy: getGitUser(),
    forkedFromOffset: sessionA.lastOffset,
  })

  console.log(`  Session: ${mergedSessionId}`)
  console.log(`  Entries: ${rewrittenLines.length}`)
  console.log(`\nResume: cd ${mergePath} && claude --continue`)
}

/**
 * Read the gitBranch from a session's local JSONL.
 */
function getGitBranchFromJsonl(
  session: SessionFile,
  repoRoot: string
): string | null {
  const absoluteCwd = path.isAbsolute(session.cwd)
    ? session.cwd
    : path.join(repoRoot, session.cwd)
  const realCwd = fs.existsSync(absoluteCwd)
    ? fs.realpathSync(absoluteCwd)
    : absoluteCwd
  const jsonlPath = claudeJsonlPath(session.sessionId, realCwd)
  if (!fs.existsSync(jsonlPath)) return null

  const content = fs.readFileSync(jsonlPath, `utf-8`)
  const lines = content.trim().split(`\n`)

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (typeof entry.gitBranch === `string`) return entry.gitBranch
    } catch {
      continue
    }
  }
  return null
}
