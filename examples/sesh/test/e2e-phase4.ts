#!/usr/bin/env npx tsx

/**
 * End-to-end test for sesh Phase 4: merge.
 * Creates two sessions on different branches, merges them.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { execSync } from "node:child_process"

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
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `sesh-phase4-`))
  const repo = (() => {
    const p = path.join(tmpBase, `repo`)
    fs.mkdirSync(p)
    return fs.realpathSync(p)
  })()
  const cleanupDirs: Array<string> = []

  console.log(`=== Setup ===`)
  console.log(`  Base: ${tmpBase}`)

  // Create repo
  git(`init`, repo)
  git(`checkout -b main`, repo)
  fs.mkdirSync(path.join(repo, `src`), { recursive: true })
  fs.writeFileSync(
    path.join(repo, `src/app.ts`),
    `export function greet() { return "hello" }\n`
  )
  fs.writeFileSync(
    path.join(repo, `src/utils.ts`),
    `export function add(a: number, b: number) { return a + b }\n`
  )
  git(`add -A`, repo)
  git(`commit -m "init"`, repo)

  // Create branch A
  git(`checkout -b sesh/branch-a`, repo)
  fs.writeFileSync(
    path.join(repo, `src/app.ts`),
    `export function greet(name: string) { return \`hello \${name}\` }\n`
  )
  git(`add -A`, repo)
  git(`commit -m "add name param"`, repo)

  // Create branch B
  git(`checkout main`, repo)
  git(`checkout -b sesh/branch-b`, repo)
  fs.writeFileSync(
    path.join(repo, `src/utils.ts`),
    `export function add(a: number, b: number) { return a + b }\nexport function multiply(a: number, b: number) { return a * b }\n`
  )
  git(`add -A`, repo)
  git(`commit -m "add multiply"`, repo)
  git(`checkout main`, repo)

  // Create fake sessions
  const sessionAId = crypto.randomUUID()
  const sessionBId = crypto.randomUUID()

  const claudeProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(repo)
  )
  cleanupDirs.push(claudeProjectDir)
  fs.mkdirSync(claudeProjectDir, { recursive: true })

  fs.writeFileSync(
    path.join(claudeProjectDir, `${sessionAId}.jsonl`),
    [
      JSON.stringify({
        type: `user`,
        message: { role: `user`, content: `Add name param to greet` },
        uuid: `a-1`,
        parentUuid: null,
        cwd: repo,
        sessionId: sessionAId,
        gitBranch: `sesh/branch-a`,
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: `assistant`,
        message: {
          role: `assistant`,
          content: [{ type: `text`, text: `Done, added name parameter.` }],
        },
        uuid: `a-2`,
        parentUuid: `a-1`,
        cwd: repo,
        sessionId: sessionAId,
        gitBranch: `sesh/branch-a`,
        timestamp: new Date().toISOString(),
      }),
    ].join(`\n`) + `\n`
  )

  fs.writeFileSync(
    path.join(claudeProjectDir, `${sessionBId}.jsonl`),
    [
      JSON.stringify({
        type: `user`,
        message: { role: `user`, content: `Add multiply function` },
        uuid: `b-1`,
        parentUuid: null,
        cwd: repo,
        sessionId: sessionBId,
        gitBranch: `sesh/branch-b`,
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: `assistant`,
        message: {
          role: `assistant`,
          content: [{ type: `text`, text: `Done, added multiply.` }],
        },
        uuid: `b-2`,
        parentUuid: `b-1`,
        cwd: repo,
        sessionId: sessionBId,
        gitBranch: `sesh/branch-b`,
        timestamp: new Date().toISOString(),
      }),
    ].join(`\n`) + `\n`
  )

  try {
    const { writeConfig } = await import(`../src/config.js`)
    const { writeSessionFile, listSessionFiles } = await import(
      `../src/sessions.js`
    )
    const { merge } = await import(`../src/merge.js`)

    // Init sesh (no DS server needed for merge — it's all local)
    writeConfig(repo, { server: `http://localhost:4437`, version: 1 })

    writeSessionFile(repo, {
      sessionId: sessionAId,
      parentSessionId: null,
      streamUrl: null,
      lastOffset: null,
      entryCount: 0,
      name: `greet-refactor`,
      cwd: `.`,
      agent: `claude`,
      createdBy: `alice`,
      forkedFromOffset: null,
    })

    writeSessionFile(repo, {
      sessionId: sessionBId,
      parentSessionId: null,
      streamUrl: null,
      lastOffset: null,
      entryCount: 0,
      name: `add-multiply`,
      cwd: `.`,
      agent: `claude`,
      createdBy: `bob`,
      forkedFromOffset: null,
    })

    console.log(`  Session A: ${sessionAId.slice(0, 8)} (branch-a)`)
    console.log(`  Session B: ${sessionBId.slice(0, 8)} (branch-b)`)

    // Merge
    console.log(`\n=== Testing merge ===`)
    merge({ sessionA: sessionAId, sessionB: sessionBId, repoRoot: repo })

    // Verify
    console.log(`\n=== Verifying ===`)
    const mergeDir = fs
      .readdirSync(repo)
      .find((f) => f.startsWith(`session-merge-`))

    if (!mergeDir) {
      console.error(`No merge worktree found!`)
      process.exit(1)
    }

    const mergePath = path.join(repo, mergeDir)
    const mergedApp = fs.readFileSync(
      path.join(mergePath, `src/app.ts`),
      `utf-8`
    )
    const mergedUtils = fs.readFileSync(
      path.join(mergePath, `src/utils.ts`),
      `utf-8`
    )

    console.log(`  Has greet(name): ${mergedApp.includes(`name`)}`)
    console.log(`  Has multiply: ${mergedUtils.includes(`multiply`)}`)

    // Check merged session in sesh index
    const allSessions = listSessionFiles(repo)
    const mergedSession = allSessions.find(
      (s) => s.parentSessionId === sessionAId
    )
    console.log(`  Merged session exists: ${mergedSession !== undefined}`)
    if (mergedSession) {
      console.log(`  Name: ${mergedSession.name}`)
    }

    // Check JSONL has merge context
    const mergeProjectDir = path.join(
      os.homedir(),
      `.claude`,
      `projects`,
      encodeCwd(mergePath)
    )
    cleanupDirs.push(mergeProjectDir)

    if (fs.existsSync(mergeProjectDir)) {
      const jsonlFiles = fs
        .readdirSync(mergeProjectDir)
        .filter((f) => f.endsWith(`.jsonl`))
      console.log(`  JSONL files: ${jsonlFiles.length} (expected 1)`)
    }

    if (mergedApp.includes(`name`) && mergedUtils.includes(`multiply`)) {
      console.log(`\n=== All Phase 4 tests passed! ===`)
    } else {
      console.error(`\n=== FAILED ===`)
      process.exit(1)
    }

    // Clean up worktree
    try {
      git(`worktree remove ${mergePath} --force`, repo)
    } catch {
      // best effort
    }
  } finally {
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
