/**
 * ds-cc merge: merge a forked CC session into the current session.
 *
 * Flow:
 * 1. Git merge the incoming fork's branch into a new merge branch
 * 2. If conflicts: get brief summaries, invoke agent to resolve
 * 3. Get detailed contexts from both sessions (in parallel with step 2 if conflicts)
 * 4. Create merged session: original JSONL + synthetic merge context message
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { execSync } from "node:child_process"
import { isGitRepo } from "./git.js"
import { sanitizeJsonLine } from "./sanitize.js"
import { rewriteJsonlLines } from "./rewrite.js"

interface MergeOptions {
  forkUrl: string
  into: string
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
  return execSync(
    `claude -p ${JSON.stringify(prompt)} --model haiku --max-turns 0`,
    { cwd, encoding: `utf-8`, stdio: [`pipe`, `pipe`, `pipe`] }
  ).trim()
}

function claudeAgent(prompt: string, cwd: string): void {
  execSync(
    `claude -p ${JSON.stringify(prompt)} --dangerously-skip-permissions`,
    {
      cwd,
      encoding: `utf-8`,
      stdio: `inherit`,
    }
  )
}

/**
 * Read session entries from a DS fork URL.
 */
async function readSessionFromDS(forkUrl: string): Promise<Array<unknown>> {
  const sessionStreamUrl = `${forkUrl}/session`
  const res = await fetch(`${sessionStreamUrl}?offset=-1`)
  if (!res.ok) {
    throw new Error(`Could not read session stream: ${res.status}`)
  }
  const body = await res.text()
  const entries = JSON.parse(body)
  return Array.isArray(entries) ? entries : [entries]
}

/**
 * Read fork metadata from a DS fork URL.
 */
async function readMetadata(forkUrl: string): Promise<ForkMetadata> {
  const metaStreamUrl = `${forkUrl}/meta`
  const res = await fetch(`${metaStreamUrl}?offset=-1`)
  if (!res.ok) {
    throw new Error(`Could not read metadata stream: ${res.status}`)
  }
  const body = await res.text()
  const parsed = JSON.parse(body)
  return Array.isArray(parsed) ? parsed[0] : parsed
}

/**
 * Get a brief summary of what a session did, by reading its JSONL from DS.
 */
function getSessionSummary(
  sessionEntries: Array<unknown>,
  originalBranch: string,
  cwd: string
): string {
  // Extract user and assistant messages for context
  const messages: Array<string> = []
  for (const entry of sessionEntries) {
    const e = entry as Record<string, unknown>
    if (e.type === `user` && e.message) {
      const msg = e.message as { content?: unknown }
      if (typeof msg.content === `string`) {
        messages.push(`User: ${msg.content.slice(0, 200)}`)
      }
    } else if ((!e.type || e.type === `assistant`) && e.message) {
      const msg = e.message as { role?: string; content?: unknown }
      if (msg.role === `assistant` && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            (block as Record<string, unknown>).type === `text` &&
            typeof (block as Record<string, unknown>).text === `string`
          ) {
            messages.push(
              `Assistant: ${((block as Record<string, unknown>).text as string).slice(0, 200)}`
            )
          }
        }
      }
    }
  }

  const conversationSnippet = messages.slice(-20).join(`\n`)

  return claude(
    `Here is a snippet of a Claude Code conversation from a forked session (branch: ${originalBranch}):\n\n${conversationSnippet}\n\nSummarize what this session accomplished in 3-5 sentences. Focus on what was changed, why, and key decisions made.`,
    cwd
  )
}

/**
 * Get a detailed context of what a session did, for the merged session.
 */
function getDetailedContext(
  sessionEntries: Array<unknown>,
  originalBranch: string,
  cwd: string
): string {
  const messages: Array<string> = []
  for (const entry of sessionEntries) {
    const e = entry as Record<string, unknown>
    if (e.type === `user` && e.message) {
      const msg = e.message as { content?: unknown }
      if (typeof msg.content === `string`) {
        messages.push(`User: ${msg.content.slice(0, 500)}`)
      }
    } else if ((!e.type || e.type === `assistant`) && e.message) {
      const msg = e.message as { role?: string; content?: unknown }
      if (msg.role === `assistant` && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            (block as Record<string, unknown>).type === `text` &&
            typeof (block as Record<string, unknown>).text === `string`
          ) {
            messages.push(
              `Assistant: ${((block as Record<string, unknown>).text as string).slice(0, 500)}`
            )
          }
        }
      }
    }
  }

  const conversationSnippet = messages.slice(-30).join(`\n`)

  return claude(
    `Here is a Claude Code conversation from a forked session (branch: ${originalBranch}):\n\n${conversationSnippet}\n\nGive a detailed summary of everything this session accomplished. Include all key decisions, changes made, problems encountered, and current state. This will be used to brief Claude in a merged session, so be thorough.`,
    cwd
  )
}

export async function merge(options: MergeOptions): Promise<void> {
  const { forkUrl } = options
  const repoCwd = process.cwd()

  if (!isGitRepo(repoCwd)) {
    console.error(`Current directory is not a git repository.`)
    process.exit(1)
  }

  // === Read incoming fork metadata ===
  console.log(`Reading incoming fork metadata...`)
  const incomingMeta = await readMetadata(forkUrl)
  console.log(`  Branch: ${incomingMeta.branch}`)
  console.log(`  Original session: ${incomingMeta.sessionId}`)

  // Fetch the incoming branch
  console.log(`  Fetching branch...`)
  git(`fetch origin ${incomingMeta.branch}`, repoCwd)

  // === Verify the target branch exists ===
  const targetBranch = options.into
  console.log(`  Target branch: ${targetBranch}`)

  // Verify common ancestor
  const mergeBase = gitMayFail(
    `merge-base origin/${incomingMeta.branch} ${targetBranch}`,
    repoCwd
  )
  if (!mergeBase.ok) {
    console.error(
      `No common ancestor between ${incomingMeta.branch} and ${targetBranch}.`
    )
    console.error(`These branches may not be from the same fork.`)
    process.exit(1)
  }
  console.log(`  Common ancestor: ${mergeBase.stdout.slice(0, 8)}`)

  // === Create merge worktree ===
  const mergeId = crypto.randomUUID().slice(0, 8)
  const mergeBranch = `cc-session/merge-${mergeId}`
  const mergePath = path.resolve(`session-merge-${mergeId}`)

  console.log(`\nCreating merge worktree...`)
  git(`worktree add ${mergePath} -b ${mergeBranch} ${targetBranch}`, repoCwd)
  console.log(`  Created ${mergePath} on branch ${mergeBranch}`)

  // === Attempt git merge ===
  console.log(`\nMerging code...`)
  const mergeResult = gitMayFail(
    `merge origin/${incomingMeta.branch} --no-commit --no-ff`,
    mergePath
  )

  let hasConflicts = false
  let conflictNotes = ``

  if (!mergeResult.ok) {
    // Check if there are actual conflicts
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

  // === Read sessions from DS ===
  console.log(`\nReading sessions from DS...`)
  const incomingEntries = await readSessionFromDS(forkUrl)
  console.log(`  Incoming session: ${incomingEntries.length} entries`)

  // === Handle conflicts ===
  if (hasConflicts) {
    console.log(`\nGenerating summaries for conflict resolution...`)
    const incomingSummary = getSessionSummary(
      incomingEntries,
      incomingMeta.branch,
      mergePath
    )
    console.log(`  Incoming: ${incomingSummary.slice(0, 100)}...`)

    // Get target session summary from git diff (we don't have a DS stream for it)
    const targetDiff = gitMayFail(
      `diff ${mergeBase.stdout.slice(0, 8)}..${targetBranch} --stat`,
      mergePath
    )
    const targetSummaryPrompt = `The target branch (${targetBranch}) made the following changes from the common ancestor:\n\n${targetDiff.stdout}\n\nSummarize what this branch did in 2-3 sentences.`
    const targetSummary = claude(targetSummaryPrompt, mergePath)
    console.log(`  Target: ${targetSummary.slice(0, 100)}...`)

    console.log(`\nResolving conflicts with agent...`)
    claudeAgent(
      `Two branches of work are being merged and there are conflicts.\n\nBranch A (incoming, ${incomingMeta.branch}) did: ${incomingSummary}\n\nBranch B (target, ${targetBranch}) did: ${targetSummary}\n\nPlease resolve all merge conflicts in the working directory. Use git status to find conflicted files and resolve them. After resolving, stage the files with git add.`,
      mergePath
    )

    conflictNotes = `Conflicts were resolved by an agent. Incoming branch did: ${incomingSummary}. Target branch did: ${targetSummary}.`

    // Verify conflicts are resolved
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
    `commit --no-edit -m "Merge ${incomingMeta.branch} into ${targetBranch}"`,
    mergePath
  )
  if (!commitResult.ok) {
    // Nothing to commit (identical trees) is fine
    console.log(`  Nothing to commit (trees are identical)`)
  } else {
    console.log(`  Merge committed.`)
  }

  // === Get detailed contexts ===
  console.log(`\nGenerating detailed contexts for merged session...`)
  const incomingContext = getDetailedContext(
    incomingEntries,
    incomingMeta.branch,
    mergePath
  )
  console.log(`  Incoming context: ${incomingContext.length} chars`)

  const targetDiffForContext = gitMayFail(
    `diff ${mergeBase.stdout.slice(0, 8)}..${targetBranch}`,
    mergePath
  )
  const targetContext = claude(
    `Here is the git diff of changes made on branch ${targetBranch} from the common ancestor:\n\n${targetDiffForContext.stdout.slice(0, 5000)}\n\nGive a detailed summary of what was accomplished. Include key decisions, changes, and current state. This will be used to brief Claude in a merged session.`,
    mergePath
  )
  console.log(`  Target context: ${targetContext.length} chars`)

  // === Create merged session ===
  console.log(`\nCreating merged session...`)

  // Read the original session JSONL from the incoming fork's DS stream
  // (this is the base session that both forks diverged from)
  const originalEntries = incomingEntries

  const mergedSessionId = crypto.randomUUID()
  const jsonlLines = originalEntries.map((entry) => JSON.stringify(entry))
  const rewrittenLines = rewriteJsonlLines(
    jsonlLines,
    incomingMeta.sessionId,
    mergedSessionId,
    incomingMeta.originalCwd,
    mergePath,
    mergeBranch
  )

  // Create synthetic merge context message
  const lastEntry = originalEntries[originalEntries.length - 1] as Record<
    string,
    unknown
  >
  const lastUuid = (lastEntry.uuid as string | undefined) ?? `merge-parent`
  const mergeContextMessage = JSON.stringify({
    parentUuid: lastUuid,
    isSidechain: false,
    type: `user`,
    message: {
      role: `user`,
      content: `Two branches of work have been merged into this session.\n\nIncoming branch (${incomingMeta.branch}):\n${incomingContext}\n\nTarget branch (${targetBranch}):\n${targetContext}\n\n${conflictNotes ? `Conflict resolution: ${conflictNotes}\n\n` : ``}The code has been merged. The working directory reflects the merged state.`,
    },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: mergedSessionId,
    cwd: mergePath,
    gitBranch: mergeBranch,
  })

  rewrittenLines.push(mergeContextMessage)

  // Write JSONL
  const mergeProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(mergePath)
  )
  fs.mkdirSync(mergeProjectDir, { recursive: true })

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
