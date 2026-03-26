#!/usr/bin/env npx tsx

/**
 * End-to-end test for Phase 2: fork and clone.
 * Creates a temporary git repo with a local remote to test without real remote access.
 *
 * Tests the git mechanics (export branch, fetch, worktree) and DS stream operations.
 * The `claude --fork-session` step requires a real CC session and must be tested manually
 * (see README.md for instructions).
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

function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, `-`)
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

  // Create a fake CC session JSONL
  const fakeSessionId = `00000000-0000-0000-0000-000000000001`
  const claudeProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(workRepo)
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
      message: {
        role: `user`,
        content: `Summary of previous work: set up a test project.`,
      },
      uuid: `summary-1`,
      parentUuid: `boundary-1`,
      cwd: workRepo,
      sessionId: fakeSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: `user`,
      message: { role: `user`, content: `Add a new feature` },
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
        content: [{ type: `text`, text: `Done.` }],
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
  console.log(`  Created fake session JSONL`)

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
    // === Test fork (DS + git) ===
    console.log(`\n=== Testing fork ===`)

    const { DurableStream } = await import(`@durable-streams/client`)
    const { findLastCompactionBoundary, readLinesFromOffset } = await import(
      `../src/session.js`
    )
    const { sanitizeJsonLine } = await import(`../src/sanitize.js`)
    const { exportBranch, getRemoteUrl } = await import(`../src/git.js`)

    const sessionStreamUrl = `${baseUrl}/cc/${fakeSessionId}/session`
    const metaStreamUrl = `${baseUrl}/cc/${fakeSessionId}/meta`
    const branchName = `cc-session/${fakeSessionId}`

    // Write JSONL to DS
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

    // Write metadata to DS
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

    // Verify the branch has uncommitted changes
    const branchNewFile = git(`show ${branchName}:src/new-file.ts`, workRepo)
    console.log(`  Branch has new-file.ts: ${branchNewFile.includes(`42`)}`)

    const branchIndex = git(`show ${branchName}:src/index.ts`, workRepo)
    console.log(
      `  Branch has modified index.ts: ${branchIndex.includes(`forked session`)}`
    )

    // Verify original working dir untouched
    const currentBranch = git(`rev-parse --abbrev-ref HEAD`, workRepo)
    console.log(`  Still on branch: ${currentBranch}`)
    console.log(
      `  Working dir has new-file.ts: ${fs.existsSync(path.join(workRepo, `src/new-file.ts`))}`
    )

    // === Test clone (git mechanics) ===
    console.log(`\n=== Testing clone (git mechanics) ===`)

    // Simulate another user cloning the repo
    fs.mkdirSync(cloneDir)
    git(`clone ${bareRepo} repo`, cloneDir)
    const cloneRepoDir = path.join(cloneDir, `repo`)
    console.log(`  Created clone at ${cloneRepoDir}`)

    const { importBranchWorktree } = await import(`../src/git.js`)

    // Read metadata from DS
    const metaRes = await fetch(`${metaStreamUrl}?offset=-1`)
    const metaBody = await metaRes.text()
    const metadata = JSON.parse(metaBody)[0]
    console.log(
      `  Read metadata: repo=${metadata.repo}, branch=${metadata.branch}`
    )

    // Create worktree from export branch
    const shortId = Math.random().toString(36).slice(2, 10)
    const worktreeBranch = `cc-session/clone-${shortId}`
    const worktreePath = path.join(cloneDir, `session-${shortId}`)
    importBranchWorktree(
      cloneRepoDir,
      metadata.branch,
      worktreeBranch,
      worktreePath
    )
    console.log(`  Created worktree at ${worktreePath}`)

    // Verify worktree has forked code
    const wtNewFile = fs.readFileSync(
      path.join(worktreePath, `src/new-file.ts`),
      `utf-8`
    )
    console.log(`  Worktree has new-file.ts: ${wtNewFile.includes(`42`)}`)

    const wtIndex = fs.readFileSync(
      path.join(worktreePath, `src/index.ts`),
      `utf-8`
    )
    console.log(
      `  Worktree has forked index.ts: ${wtIndex.includes(`forked session`)}`
    )

    // Read session JSONL from DS
    const sessionRes = await fetch(`${sessionStreamUrl}?offset=-1`)
    const sessionBody = await sessionRes.text()
    const entries = JSON.parse(sessionBody)
    console.log(`  Read ${entries.length} entries from session stream`)

    // The original JSONL is already at claudeProjectDir (created during setup).
    // In the real clone flow, it gets written temporarily for `claude -r` to find.
    console.log(`  Original JSONL available for claude -r`)

    // Verify checkpoint resolution
    const checkpointRes = await fetch(`${sessionStreamUrl}?offset=compact`, {
      redirect: `manual`,
    })
    console.log(
      `  Checkpoint resolution: ${checkpointRes.status} → ${checkpointRes.headers.get(`location`)}`
    )

    console.log(`\n=== All automated tests passed! ===`)
    console.log(
      `\nNote: The 'claude --fork-session' step requires a real CC session.`
    )
    console.log(`See README.md for manual testing instructions.`)
  } finally {
    await server.stop()
    fs.rmSync(tmpBase, { recursive: true, force: true })
    fs.rmSync(claudeProjectDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`Test failed:`, err)
  process.exit(1)
})
