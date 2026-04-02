#!/usr/bin/env npx tsx

/**
 * End-to-end test for sesh Phase 2: git hooks + time travel.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
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
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `sesh-phase2-`))
  const repo = (() => {
    const p = path.join(tmpBase, `repo`)
    fs.mkdirSync(p)
    return fs.realpathSync(p)
  })()
  const cleanupDirs: Array<string> = []

  console.log(`=== Setup ===`)
  console.log(`  Base: ${tmpBase}`)

  git(`init`, repo)
  git(`checkout -b main`, repo)
  fs.writeFileSync(path.join(repo, `README.md`), `# Test\n`)
  git(`add -A`, repo)
  git(`commit -m "init"`, repo)

  // Create fake CC session
  const fakeSessionId = crypto.randomUUID()
  const claudeProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(repo)
  )
  cleanupDirs.push(claudeProjectDir)
  fs.mkdirSync(claudeProjectDir, { recursive: true })

  const makeEntry = (
    uuid: string,
    parentUuid: string | null,
    content: string
  ) =>
    JSON.stringify({
      type: `user`,
      message: { role: `user`, content },
      uuid,
      parentUuid,
      cwd: repo,
      sessionId: fakeSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    })

  fs.writeFileSync(
    path.join(claudeProjectDir, `${fakeSessionId}.jsonl`),
    [
      makeEntry(`uuid-1`, null, `First message`),
      makeEntry(`uuid-2`, `uuid-1`, `Second message`),
    ].join(`\n`) + `\n`
  )
  console.log(`  Session: ${fakeSessionId}`)

  // Start DS server
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
    const { writeConfig } = await import(`../src/config.js`)
    const { writeSessionFile, readSessionFile } = await import(
      `../src/sessions.js`
    )
    const { pushAll } = await import(`../src/push.js`)
    const { resume } = await import(`../src/resume.js`)

    // Initialize sesh
    writeConfig(repo, { server: baseUrl, version: 1 })
    writeSessionFile(repo, {
      sessionId: fakeSessionId,
      parentSessionId: null,
      streamUrl: null,
      lastOffset: null,
      entryCount: 0,
      name: `test-session`,
      cwd: `.`,
      agent: `claude`,
      createdBy: `test-user`,
      forkedFromOffset: null,
    })

    // === Test: push + commit (simulate pre-commit hook) ===
    console.log(`\n=== Test: push + commit 1 ===`)
    await pushAll(repo)

    git(`add .sesh/`, repo)
    git(`commit -m "commit 1: initial session"`, repo)
    const commit1 = git(`rev-parse HEAD`, repo)
    console.log(`  Commit 1: ${commit1.slice(0, 8)}`)

    const afterCommit1 = readSessionFile(repo, fakeSessionId)
    console.log(`  Offset at commit 1: ${afterCommit1?.lastOffset?.slice(-8)}`)

    // === Add more entries + commit 2 ===
    console.log(`\n=== Test: push + commit 2 ===`)
    fs.appendFileSync(
      path.join(claudeProjectDir, `${fakeSessionId}.jsonl`),
      makeEntry(`uuid-3`, `uuid-2`, `Third message`) +
        `\n` +
        makeEntry(`uuid-4`, `uuid-3`, `Fourth message`) +
        `\n`
    )

    await pushAll(repo)
    git(`add .sesh/`, repo)
    git(`commit -m "commit 2: more messages"`, repo)
    const commit2 = git(`rev-parse HEAD`, repo)
    console.log(`  Commit 2: ${commit2.slice(0, 8)}`)

    const afterCommit2 = readSessionFile(repo, fakeSessionId)
    console.log(`  Offset at commit 2: ${afterCommit2?.lastOffset?.slice(-8)}`)
    console.log(
      `  Offsets differ: ${afterCommit1?.lastOffset !== afterCommit2?.lastOffset}`
    )

    // === Test: time travel — resume from commit 1 ===
    console.log(`\n=== Test: time travel (resume at commit 1) ===`)
    const result = await resume({
      sessionId: fakeSessionId,
      repoRoot: repo,
      atCommit: commit1,
    })

    console.log(`  New session: ${result.newSessionId.slice(0, 8)}`)
    console.log(`  Entries restored: ${result.entriesRestored}`)

    // The session at commit 1 had 2 entries, so we should get 2
    console.log(`  Expected 2 entries: ${result.entriesRestored === 2}`)

    // Verify the new session's forkedFromOffset matches commit 1's offset
    const newSession = readSessionFile(repo, result.newSessionId)
    console.log(
      `  Forked from commit 1 offset: ${newSession?.forkedFromOffset === afterCommit1?.lastOffset}`
    )

    // === Test: resume from latest (commit 2) ===
    console.log(`\n=== Test: resume from latest ===`)
    const result2 = await resume({
      sessionId: fakeSessionId,
      repoRoot: repo,
    })

    console.log(`  New session: ${result2.newSessionId.slice(0, 8)}`)
    console.log(`  Entries restored: ${result2.entriesRestored}`)
    console.log(`  Expected 4 entries: ${result2.entriesRestored === 4}`)

    const newJsonlDir = path.join(
      os.homedir(),
      `.claude`,
      `projects`,
      encodeCwd(result.cwd)
    )
    cleanupDirs.push(newJsonlDir)
    const newJsonlDir2 = path.join(
      os.homedir(),
      `.claude`,
      `projects`,
      encodeCwd(result2.cwd)
    )
    cleanupDirs.push(newJsonlDir2)

    console.log(`\n=== All Phase 2 tests passed! ===`)
  } finally {
    await server.stop()
    fs.rmSync(tmpBase, { recursive: true, force: true })
    for (const dir of cleanupDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Test failed:`, err)
    process.exit(1)
  })
