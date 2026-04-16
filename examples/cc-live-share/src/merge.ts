/**
 * cods merge: merge two local CC sessions.
 *
 * Both sessions must exist locally (JSONL + git branch).
 * Remote sessions should be cloned first via `cods clone`.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { execSync } from "node:child_process"
import { isGitRepo } from "./git.js"
import { rewriteJsonlLines } from "./rewrite.js"
import { sanitizeJsonLine } from "./sanitize.js"

interface MergeOptions {
  sessionA: string
  sessionB: string
}

interface SessionInfo {
  sessionId: string
  jsonlPath: string
  gitBranch: string
  cwd: string
  entries: Array<Record<string, unknown>>
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, `-`)
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
  // Pipe prompt via stdin to avoid shell escaping issues with backticks,
  // quotes, and other special characters in conversation content.
  return execSync(`claude -p --model haiku --max-turns 0`, {
    cwd,
    encoding: `utf-8`,
    input: prompt,
    stdio: [`pipe`, `pipe`, `pipe`],
  }).trim()
}

function claudeAgent(prompt: string, cwd: string): void {
  // Write prompt to a temp file to avoid shell escaping issues.
  // Can't use stdin pipe here because stdio is 'inherit' for interactive output.
  const tmpFile = path.join(os.tmpdir(), `cods-merge-prompt-${Date.now()}.txt`)
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
 * Find a CC session by ID. Searches ~/.claude/projects/ for matching JSONL.
 */
function findSession(sessionId: string): SessionInfo | null {
  const projectsDir = path.join(os.homedir(), `.claude`, `projects`)
  if (!fs.existsSync(projectsDir)) return null

  const projectDirs = fs.readdirSync(projectsDir)
  for (const dir of projectDirs) {
    const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`)
    if (!fs.existsSync(jsonlPath)) continue

    const content = fs.readFileSync(jsonlPath, `utf-8`)
    const lines = content.trim().split(`\n`)
    const entries: Array<Record<string, unknown>> = []
    let gitBranch = ``
    let cwd = ``

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        entries.push(entry)
        if (entry.gitBranch && typeof entry.gitBranch === `string`) {
          gitBranch = entry.gitBranch
        }
        if (entry.cwd && typeof entry.cwd === `string`) {
          cwd = entry.cwd
        }
      } catch {
        // skip unparseable lines
      }
    }

    if (!gitBranch || !cwd) continue

    return { sessionId, jsonlPath, gitBranch, cwd, entries }
  }

  return null
}

/**
 * Extract conversation messages from JSONL entries for summarization.
 */
function extractMessages(
  entries: Array<Record<string, unknown>>,
  maxMessages: number,
  maxChars: number
): string {
  const messages: Array<string> = []
  for (const e of entries) {
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
  }
  return messages.slice(-maxMessages).join(`\n`)
}

export function merge(options: MergeOptions): void {
  // === Find both sessions ===
  console.log(`Finding sessions...`)

  const sessionA = findSession(options.sessionA)
  if (!sessionA) {
    console.error(`Session not found: ${options.sessionA}`)
    console.error(`Search path: ~/.claude/projects/*/${options.sessionA}.jsonl`)
    process.exit(1)
  }
  console.log(
    `  Session A: ${sessionA.sessionId} (branch: ${sessionA.gitBranch}, cwd: ${sessionA.cwd})`
  )

  const sessionB = findSession(options.sessionB)
  if (!sessionB) {
    console.error(`Session not found: ${options.sessionB}`)
    console.error(`Search path: ~/.claude/projects/*/${options.sessionB}.jsonl`)
    process.exit(1)
  }
  console.log(
    `  Session B: ${sessionB.sessionId} (branch: ${sessionB.gitBranch}, cwd: ${sessionB.cwd})`
  )

  // We need a git repo to work in. Use session A's cwd.
  const repoCwd = sessionA.cwd
  if (!isGitRepo(repoCwd)) {
    console.error(`Session A's cwd is not a git repo: ${repoCwd}`)
    process.exit(1)
  }

  // Fetch latest from origin so we have both branches
  console.log(`  Fetching latest from origin...`)
  gitMayFail(`fetch origin`, repoCwd)

  // If session B's branch still isn't found, try creating it from the remote ref
  const hasBranchB = gitMayFail(
    `rev-parse --verify ${sessionB.gitBranch}`,
    repoCwd
  )
  if (!hasBranchB.ok) {
    // Try creating from remote tracking branch
    const fromRemote = gitMayFail(
      `branch ${sessionB.gitBranch} origin/${sessionB.gitBranch}`,
      repoCwd
    )
    if (!fromRemote.ok) {
      console.error(
        `Branch '${sessionB.gitBranch}' not found locally or on origin.`
      )
      console.error(
        `Session B's changes may not have been pushed. Try:\n` +
          `  cd ${sessionB.cwd} && git push origin ${sessionB.gitBranch}`
      )
      process.exit(1)
    }
  }

  // === Verify common ancestor ===
  console.log(`\nVerifying common ancestor...`)
  const mergeBase = gitMayFail(
    `merge-base ${sessionA.gitBranch} ${sessionB.gitBranch}`,
    repoCwd
  )
  if (!mergeBase.ok) {
    console.error(
      `No common ancestor between ${sessionA.gitBranch} and ${sessionB.gitBranch}.`
    )
    console.error(
      `These sessions may not have been forked from the same point.`
    )
    process.exit(1)
  }
  console.log(`  Common ancestor: ${mergeBase.stdout.slice(0, 8)}`)

  // === Create merge worktree ===
  const mergeId = crypto.randomUUID().slice(0, 8)
  const mergeBranch = `cc-session/merge-${mergeId}`
  const mergePath = path.resolve(`session-merge-${mergeId}`)

  console.log(`\nCreating merge worktree...`)
  git(
    `worktree add ${mergePath} -b ${mergeBranch} ${sessionA.gitBranch}`,
    repoCwd
  )
  console.log(`  Created ${mergePath} on branch ${mergeBranch}`)

  // === Git merge ===
  console.log(`\nMerging code...`)
  const mergeResult = gitMayFail(
    `merge ${sessionB.gitBranch} --no-commit --no-ff`,
    mergePath
  )

  let hasConflicts = false
  let conflictNotes = ``

  if (!mergeResult.ok) {
    const status = git(`status --porcelain`, mergePath)
    hasConflicts =
      status.includes(`UU `) || status.includes(`AA `) || status.includes(`DD `)

    if (!hasConflicts) {
      console.error(`Git merge failed for a non-conflict reason.`)
      process.exit(1)
    }
    console.log(`  Conflicts detected!`)
  } else {
    console.log(`  Clean merge, no conflicts.`)
  }

  // === Conflict resolution ===
  if (hasConflicts) {
    console.log(`\nGenerating summaries for conflict resolution...`)

    const snippetA = extractMessages(sessionA.entries, 20, 200)
    const summaryA = claude(
      `Here is a snippet of a Claude Code conversation:\n\n${snippetA}\n\nSummarize what this session accomplished in 3-5 sentences.`,
      mergePath
    )
    console.log(`  Session A: ${summaryA.slice(0, 100)}...`)

    const snippetB = extractMessages(sessionB.entries, 20, 200)
    const summaryB = claude(
      `Here is a snippet of a Claude Code conversation:\n\n${snippetB}\n\nSummarize what this session accomplished in 3-5 sentences.`,
      mergePath
    )
    console.log(`  Session B: ${summaryB.slice(0, 100)}...`)

    console.log(`\nResolving conflicts with agent...`)
    claudeAgent(
      `Two branches of work are being merged and there are conflicts.\n\nBranch A (${sessionA.gitBranch}) did: ${summaryA}\n\nBranch B (${sessionB.gitBranch}) did: ${summaryB}\n\nPlease resolve all merge conflicts in the working directory. Use git status to find conflicted files and resolve them. After resolving, stage the files with git add.`,
      mergePath
    )

    conflictNotes = `Conflicts were resolved by an agent. Session A did: ${summaryA}. Session B did: ${summaryB}.`

    const postStatus = git(`status --porcelain`, mergePath)
    if (postStatus.includes(`UU `) || postStatus.includes(`AA `)) {
      console.error(
        `Some conflicts were not resolved. Please resolve manually.`
      )
      console.error(`Merge worktree: ${mergePath}`)
      process.exit(1)
    }
  }

  // Commit the merge
  git(`add -A`, mergePath)
  const commitResult = gitMayFail(
    `commit --no-edit -m "Merge ${sessionB.gitBranch} into ${sessionA.gitBranch}"`,
    mergePath
  )
  if (!commitResult.ok) {
    console.log(`  Nothing to commit (trees are identical)`)
  } else {
    console.log(`  Merge committed.`)
  }

  // === Get detailed contexts ===
  console.log(`\nGenerating detailed contexts for merged session...`)

  const detailA = extractMessages(sessionA.entries, 30, 500)
  const contextA = claude(
    `Here is a Claude Code conversation:\n\n${detailA}\n\nGive a detailed summary of everything this session accomplished. Include all key decisions, changes made, and current state. This will be used to brief Claude in a merged session.`,
    mergePath
  )
  console.log(`  Session A context: ${contextA.length} chars`)

  const detailB = extractMessages(sessionB.entries, 30, 500)
  const contextB = claude(
    `Here is a Claude Code conversation:\n\n${detailB}\n\nGive a detailed summary of everything this session accomplished. Include all key decisions, changes made, and current state. This will be used to brief Claude in a merged session.`,
    mergePath
  )
  console.log(`  Session B context: ${contextB.length} chars`)

  // === Create merged session ===
  console.log(`\nCreating merged session...`)

  const mergedSessionId = crypto.randomUUID()

  // Use session A's JSONL as the base
  const jsonlLines = sessionA.entries.map((entry) => JSON.stringify(entry))
  const rewrittenLines = rewriteJsonlLines(
    jsonlLines,
    sessionA.sessionId,
    mergedSessionId,
    sessionA.cwd,
    mergePath,
    mergeBranch
  )

  // Append synthetic merge context message
  const lastEntry = sessionA.entries.at(-1)
  const lastUuid = (lastEntry?.uuid as string | undefined) ?? `merge-parent`
  const mergeContextMessage = JSON.stringify({
    parentUuid: lastUuid,
    isSidechain: false,
    type: `user`,
    message: {
      role: `user`,
      content: `Two branches of work have been merged into this session.\n\nSession A (${sessionA.gitBranch}):\n${contextA}\n\nSession B (${sessionB.gitBranch}):\n${contextB}\n\n${conflictNotes ? `Conflict resolution: ${conflictNotes}\n\n` : ``}The code has been merged. The working directory reflects the merged state.\n\nNote: File paths in the session contexts above may refer to different working directories. The current working directory for this merged session is: ${mergePath}. All files should be treated as relative to this directory. This may be a different machine from where the original sessions ran, so absolute paths outside this working directory may not exist — only rely on files within the working directory.`,
    },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: mergedSessionId,
    cwd: mergePath,
    gitBranch: mergeBranch,
  })
  rewrittenLines.push(mergeContextMessage)

  // Write JSONL — first clean up any intermediate sessions created by
  // the claude -p calls (summaries, conflict resolution) that ran in this cwd
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

  const jsonlPath = path.join(mergeProjectDir, `${mergedSessionId}.jsonl`)
  const jsonlContent =
    rewrittenLines
      .map((line) => sanitizeJsonLine(line))
      .filter(Boolean)
      .join(`\n`) + `\n`
  fs.writeFileSync(jsonlPath, jsonlContent)

  console.log(`  Session ID: ${mergedSessionId}`)
  console.log(`  Wrote ${rewrittenLines.length} entries`)

  console.log(`\nReady! Start the merged session with:`)
  console.log(`  cd ${mergePath} && claude --continue`)
}
