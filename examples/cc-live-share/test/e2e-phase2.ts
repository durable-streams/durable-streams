#!/usr/bin/env npx tsx

/**
 * End-to-end test for Phase 2: fork and clone.
 * Creates a temporary git repo with a local remote to test without real remote access.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execSync } from "node:child_process"
import { DurableStreamTestServer } from "@durable-streams/server"

function git(command: string, cwd: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: `utf-8`,
    stdio: [`pipe`, `pipe`, `pipe`],
  }).trim()
}

async function main() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `ds-cc-phase2-`))
  const bareRepo = path.join(tmpBase, `remote.git`)
  const workRepo = path.join(tmpBase, `work`)
  const cloneDir = path.join(tmpBase, `cloner`)

  console.log(`=== Setup: temporary git repos ===`)
  console.log(`  Base: ${tmpBase}`)

  // Create a bare repo as the "remote"
  fs.mkdirSync(bareRepo)
  git(`init --bare`, bareRepo)

  // Create a working repo and push initial commit
  fs.mkdirSync(workRepo)
  git(`init`, workRepo)
  git(`checkout -b main`, workRepo)
  fs.writeFileSync(path.join(workRepo, `README.md`), `# Test Project\n`)
  fs.mkdirSync(path.join(workRepo, `src`), { recursive: true })
  fs.writeFileSync(
    path.join(workRepo, `src/index.ts`),
    `console.log("hello")\n`
  )
  git(`add -A`, workRepo)
  git(`commit -m "initial commit"`, workRepo)
  git(`remote add origin ${bareRepo}`, workRepo)
  git(`push origin main`, workRepo)

  // Add some uncommitted changes (this is what fork should capture)
  fs.writeFileSync(
    path.join(workRepo, `src/index.ts`),
    `console.log("hello from forked session")\n`
  )
  fs.writeFileSync(
    path.join(workRepo, `src/new-file.ts`),
    `export const x = 42\n`
  )

  // Create a fake CC session JSONL in the work repo's session dir
  const fakeSessionId = `test-session-00000000-0000-0000-0000-000000000001`
  const encodedCwd = workRepo.replace(/\//g, `-`)
  const claudeProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodedCwd
  )
  fs.mkdirSync(claudeProjectDir, { recursive: true })

  const jsonlPath = path.join(claudeProjectDir, `${fakeSessionId}.jsonl`)
  const jsonlEntries = [
    JSON.stringify({
      type: `system`,
      subtype: `compact_boundary`,
      uuid: `boundary-1`,
      cwd: workRepo,
      sessionId: fakeSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: `user`,
      isCompactSummary: true,
      message: { role: `user`, content: `Summary of previous work...` },
      uuid: `summary-1`,
      parentUuid: `boundary-1`,
      cwd: workRepo,
      sessionId: fakeSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: `user`,
      message: { role: `user`, content: `Add a new feature to the project` },
      uuid: `user-1`,
      parentUuid: `summary-1`,
      cwd: workRepo,
      sessionId: fakeSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: `assistant`,
      message: {
        role: `assistant`,
        content: [{ type: `text`, text: `I'll add the feature now.` }],
      },
      uuid: `assistant-1`,
      parentUuid: `user-1`,
      cwd: workRepo,
      sessionId: fakeSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    }),
  ]
  fs.writeFileSync(jsonlPath, jsonlEntries.join(`\n`) + `\n`)
  console.log(`  Created fake session JSONL at ${jsonlPath}`)

  // === Start DS server ===
  console.log(`\n=== Starting DS server ===`)
  const server = new DurableStreamTestServer({
    port: 0,
    checkpointRules: [
      {
        name: `compact`,
        conditions: [
          { path: `.type`, value: `system` },
          { path: `.subtype`, value: `compact_boundary` },
        ],
      },
    ],
  })
  await server.start()
  const baseUrl = server.url
  console.log(`  Server at ${baseUrl}`)

  try {
    // === Test fork ===
    console.log(`\n=== Testing fork ===`)

    // Call the underlying pieces manually (can't use the CLI commands directly
    // since they use session auto-detection which won't find our fake session).
    const { DurableStream } = await import(`@durable-streams/client`)
    const { findLastCompactionBoundary, readLinesFromOffset } = await import(
      `../src/session.js`
    )
    const { sanitizeJsonLine } = await import(`../src/sanitize.js`)
    const { exportBranch, getRemoteUrl } = await import(`../src/git.js`)

    const sessionStreamUrl = `${baseUrl}/cc/${fakeSessionId}/session`
    const metaStreamUrl = `${baseUrl}/cc/${fakeSessionId}/meta`
    const branchName = `cc-session/${fakeSessionId}`

    // Create session stream and write JSONL
    await DurableStream.create({
      url: sessionStreamUrl,
      contentType: `application/json`,
    })
    const sessionStream = new DurableStream({
      url: sessionStreamUrl,
      contentType: `application/json`,
    })

    const startOffset = findLastCompactionBoundary(jsonlPath)
    const { lines } = readLinesFromOffset(jsonlPath, startOffset)
    for (const line of lines) {
      const sanitized = sanitizeJsonLine(line)
      if (sanitized) await sessionStream.append(sanitized)
    }
    console.log(`  Wrote ${lines.length} entries to session stream`)

    // Create metadata stream
    await DurableStream.create({
      url: metaStreamUrl,
      contentType: `application/json`,
    })
    const metaStream = new DurableStream({
      url: metaStreamUrl,
      contentType: `application/json`,
    })
    const repoUrl = getRemoteUrl(workRepo, `origin`)
    await metaStream.append(
      JSON.stringify({
        type: `fork-metadata`,
        version: 1,
        sessionId: fakeSessionId,
        repo: repoUrl,
        branch: branchName,
        originalCwd: workRepo,
        createdAt: new Date().toISOString(),
      })
    )
    console.log(`  Wrote metadata`)

    // Push git branch
    exportBranch(workRepo, branchName, `origin`)
    console.log(`  Pushed branch ${branchName}`)

    // Verify the branch has our uncommitted changes
    const branchFiles = git(`show ${branchName}:src/new-file.ts`, workRepo)
    console.log(`  Branch has new-file.ts: ${branchFiles.includes(`42`)}`)

    // Verify original branch is untouched
    const currentBranch = git(`rev-parse --abbrev-ref HEAD`, workRepo)
    console.log(`  Back on branch: ${currentBranch}`)
    const hasNewFile = fs.existsSync(path.join(workRepo, `src/new-file.ts`))
    console.log(`  Working dir still has new-file.ts: ${hasNewFile}`)

    // === Test clone ===
    console.log(`\n=== Testing clone ===`)

    // Create a second clone of the repo to simulate another user
    fs.mkdirSync(cloneDir)
    git(`clone ${bareRepo} repo`, cloneDir)
    const cloneRepoDir = path.join(cloneDir, `repo`)
    console.log(`  Created clone at ${cloneRepoDir}`)

    const { importBranchWorktree } = await import(`../src/git.js`)
    const { rewriteJsonlLines } = await import(`../src/rewrite.js`)
    const crypto = await import(`node:crypto`)

    // Read metadata
    const metaRes = await fetch(`${metaStreamUrl}?offset=-1`)
    const metaBody = await metaRes.text()
    const metadata = JSON.parse(metaBody)[0]
    console.log(
      `  Read metadata: repo=${metadata.repo}, branch=${metadata.branch}`
    )

    // Generate new session ID
    const newSessionId = crypto.randomUUID()
    const newBranchName = `cc-session/${newSessionId}`
    const worktreePath = path.join(
      cloneDir,
      `session-${newSessionId.slice(0, 8)}`
    )

    // Fetch and create worktree
    importBranchWorktree(
      cloneRepoDir,
      metadata.branch,
      newBranchName,
      worktreePath
    )
    console.log(
      `  Created worktree at ${worktreePath} on branch ${newBranchName}`
    )

    // Verify worktree has the forked code
    const worktreeNewFile = fs.readFileSync(
      path.join(worktreePath, `src/new-file.ts`),
      `utf-8`
    )
    console.log(`  Worktree has new-file.ts: ${worktreeNewFile.includes(`42`)}`)

    const worktreeIndex = fs.readFileSync(
      path.join(worktreePath, `src/index.ts`),
      `utf-8`
    )
    console.log(
      `  Worktree has forked index.ts: ${worktreeIndex.includes(`forked session`)}`
    )

    // Read session stream and rewrite JSONL
    const sessionRes = await fetch(`${sessionStreamUrl}?offset=-1`)
    const sessionBody = await sessionRes.text()
    const entries = JSON.parse(sessionBody)
    const jsonlLines = entries.map((e: unknown) => JSON.stringify(e))

    const rewrittenLines = rewriteJsonlLines(
      jsonlLines,
      metadata.sessionId,
      newSessionId,
      metadata.originalCwd,
      worktreePath,
      newBranchName
    )

    // Verify rewriting
    const firstEntry = JSON.parse(rewrittenLines[0])
    console.log(
      `  Rewritten sessionId: ${firstEntry.sessionId === newSessionId}`
    )
    console.log(`  Rewritten cwd: ${firstEntry.cwd === worktreePath}`)
    console.log(
      `  Rewritten gitBranch: ${firstEntry.gitBranch === newBranchName}`
    )

    // Write JSONL to CC directory
    const cloneEncodedCwd = worktreePath.replace(/\//g, `-`)
    const cloneClaudeDir = path.join(
      os.homedir(),
      `.claude`,
      `projects`,
      cloneEncodedCwd
    )
    fs.mkdirSync(cloneClaudeDir, { recursive: true })
    const cloneJsonlPath = path.join(cloneClaudeDir, `${newSessionId}.jsonl`)
    fs.writeFileSync(cloneJsonlPath, rewrittenLines.join(`\n`) + `\n`)
    console.log(`  Wrote JSONL to ${cloneJsonlPath}`)

    // Verify the JSONL is readable
    const cloneContent = fs.readFileSync(cloneJsonlPath, `utf-8`)
    const cloneLines = cloneContent.trim().split(`\n`)
    console.log(`  Clone JSONL has ${cloneLines.length} entries`)
    for (const line of cloneLines) {
      const entry = JSON.parse(line)
      if (entry.sessionId !== newSessionId) {
        console.error(
          `  ERROR: entry still has old sessionId: ${entry.sessionId}`
        )
        process.exit(1)
      }
    }
    console.log(`  All entries have correct sessionId`)

    console.log(`\n=== All Phase 2 tests passed! ===`)
  } finally {
    await server.stop()
    // Cleanup temporary files
    fs.rmSync(tmpBase, { recursive: true, force: true })
    // Cleanup fake session JSONL
    fs.rmSync(claudeProjectDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`Test failed:`, err)
  process.exit(1)
})
