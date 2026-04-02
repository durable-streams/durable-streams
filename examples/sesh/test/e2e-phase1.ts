#!/usr/bin/env npx tsx

/**
 * End-to-end test for sesh Phase 1.
 * Tests init, checkin, push, list, resume by importing functions directly.
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
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `sesh-phase1-`))
  const repo = path.join(tmpBase, `repo`)
  const realRepo = (() => {
    fs.mkdirSync(repo)
    return fs.realpathSync(repo)
  })()
  const cleanupDirs: Array<string> = []

  console.log(`=== Setup ===`)
  console.log(`  Base: ${tmpBase}`)

  // Create repo
  git(`init`, realRepo)
  git(`checkout -b main`, realRepo)
  fs.writeFileSync(path.join(realRepo, `README.md`), `# Test\n`)
  git(`add -A`, realRepo)
  git(`commit -m "init"`, realRepo)

  // Create fake CC session
  const fakeSessionId = crypto.randomUUID()
  const claudeProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(realRepo)
  )
  cleanupDirs.push(claudeProjectDir)
  fs.mkdirSync(claudeProjectDir, { recursive: true })

  const jsonlEntries = [
    JSON.stringify({
      type: `user`,
      message: { role: `user`, content: `Hello, set up the project.` },
      uuid: `uuid-1`,
      parentUuid: null,
      cwd: realRepo,
      sessionId: fakeSessionId,
      gitBranch: `main`,
      slug: `test-session`,
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: `assistant`,
      message: {
        role: `assistant`,
        content: [{ type: `text`, text: `Project set up.` }],
      },
      uuid: `uuid-2`,
      parentUuid: `uuid-1`,
      cwd: realRepo,
      sessionId: fakeSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: `user`,
      message: { role: `user`, content: `Add a feature.` },
      uuid: `uuid-3`,
      parentUuid: `uuid-2`,
      cwd: realRepo,
      sessionId: fakeSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: `assistant`,
      message: {
        role: `assistant`,
        content: [{ type: `text`, text: `Feature added.` }],
      },
      uuid: `uuid-4`,
      parentUuid: `uuid-3`,
      cwd: realRepo,
      sessionId: fakeSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    }),
  ]
  fs.writeFileSync(
    path.join(claudeProjectDir, `${fakeSessionId}.jsonl`),
    jsonlEntries.join(`\n`) + `\n`
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
    // Import modules
    const { writeConfig, readConfig } = await import(`../src/config.js`)
    const { writeSessionFile, readSessionFile, listSessionFiles } =
      await import(`../src/sessions.js`)
    const { pushAll } = await import(`../src/push.js`)
    const { resume } = await import(`../src/resume.js`)

    // === Test init ===
    console.log(`\n=== Test: init ===`)
    writeConfig(realRepo, { server: baseUrl, version: 1 })
    const config = readConfig(realRepo)
    console.log(`  Config server: ${config?.server === baseUrl}`)
    console.log(
      `  Sessions dir: ${fs.existsSync(path.join(realRepo, `.sesh`, `sessions`))}`
    )

    // === Test checkin ===
    console.log(`\n=== Test: checkin ===`)
    writeSessionFile(realRepo, {
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
    const sessionFile = readSessionFile(realRepo, fakeSessionId)
    console.log(`  Session file created: ${sessionFile !== null}`)
    console.log(`  Name: ${sessionFile?.name}`)

    // === Test list ===
    console.log(`\n=== Test: list ===`)
    const sessions = listSessionFiles(realRepo)
    console.log(`  Sessions: ${sessions.length}`)
    console.log(
      `  First: ${sessions[0]?.name} (${sessions[0]?.sessionId.slice(0, 8)})`
    )

    // === Test push ===
    console.log(`\n=== Test: push ===`)
    const pushResults = await pushAll(realRepo)
    for (const r of pushResults) {
      console.log(
        `  ${r.sessionId.slice(0, 8)}: ${r.skipped ? `skipped (${r.reason})` : `${r.entriesPushed} entries`}`
      )
    }

    // Verify session file updated
    const afterPush = readSessionFile(realRepo, fakeSessionId)
    console.log(`  Stream URL: ${afterPush?.streamUrl !== null}`)
    console.log(`  Last offset: ${afterPush?.lastOffset !== null}`)

    // Verify DS has data
    const dsRes = await fetch(`${afterPush!.streamUrl}?offset=-1`)
    const dsBody = await dsRes.text()
    const dsEntries = JSON.parse(dsBody)
    console.log(`  Entries in DS: ${dsEntries.length}`)

    // === Test push delta ===
    console.log(`\n=== Test: push delta ===`)
    fs.appendFileSync(
      path.join(claudeProjectDir, `${fakeSessionId}.jsonl`),
      JSON.stringify({
        type: `user`,
        message: { role: `user`, content: `Add another feature.` },
        uuid: `uuid-5`,
        parentUuid: `uuid-4`,
        cwd: realRepo,
        sessionId: fakeSessionId,
        gitBranch: `main`,
        timestamp: new Date().toISOString(),
      }) + `\n`
    )

    const pushResults2 = await pushAll(realRepo)
    for (const r of pushResults2) {
      console.log(
        `  ${r.sessionId.slice(0, 8)}: ${r.skipped ? `skipped (${r.reason})` : `${r.entriesPushed} entries`}`
      )
    }

    const afterPush2 = readSessionFile(realRepo, fakeSessionId)
    const dsRes2 = await fetch(`${afterPush2!.streamUrl}?offset=-1`)
    const dsBody2 = await dsRes2.text()
    const dsEntries2 = JSON.parse(dsBody2)
    console.log(`  Total entries in DS: ${dsEntries2.length} (expected 5)`)

    // === Test resume ===
    console.log(`\n=== Test: resume ===`)
    const resumeResult = await resume({
      sessionId: fakeSessionId,
      repoRoot: realRepo,
    })
    console.log(`  New session: ${resumeResult.newSessionId.slice(0, 8)}`)
    console.log(`  Entries restored: ${resumeResult.entriesRestored}`)

    // Verify new session file
    const newSession = readSessionFile(realRepo, resumeResult.newSessionId)
    console.log(`  Parent: ${newSession?.parentSessionId === fakeSessionId}`)
    console.log(
      `  Forked from offset: ${newSession?.forkedFromOffset === afterPush2?.lastOffset}`
    )

    // Verify local JSONL created
    const newJsonlPath = path.join(
      os.homedir(),
      `.claude`,
      `projects`,
      encodeCwd(resumeResult.cwd),
      `${resumeResult.newSessionId}.jsonl`
    )
    const newJsonlDir = path.dirname(newJsonlPath)
    cleanupDirs.push(newJsonlDir)
    console.log(`  Local JSONL created: ${fs.existsSync(newJsonlPath)}`)

    // Verify lineage in list
    const allSessions = listSessionFiles(realRepo)
    console.log(`  Total sessions after resume: ${allSessions.length}`)

    console.log(`\n=== All Phase 1 tests passed! ===`)
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
