#!/usr/bin/env npx tsx

/**
 * End-to-end test for Phase 3: merge two local sessions.
 * Creates a repo with two branches making different changes, writes
 * fake CC sessions for each, then merges them.
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
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `ds-cc-phase3-`))
  const repo = path.join(tmpBase, `repo`)
  const cleanupDirs: Array<string> = []

  console.log(`=== Setup ===`)
  console.log(`  Base: ${tmpBase}`)

  // Create repo with initial commit
  fs.mkdirSync(repo)
  git(`init`, repo)
  git(`checkout -b main`, repo)
  fs.mkdirSync(path.join(repo, `src`), { recursive: true })
  fs.writeFileSync(path.join(repo, `README.md`), `# Merge Test\n`)
  fs.writeFileSync(
    path.join(repo, `src/app.ts`),
    `export function greet() { return "hello" }\n`
  )
  fs.writeFileSync(
    path.join(repo, `src/utils.ts`),
    `export function add(a: number, b: number) { return a + b }\n`
  )
  git(`add -A`, repo)
  git(`commit -m "initial commit"`, repo)

  // === Create Branch A: modifies app.ts ===
  console.log(`\n=== Creating Branch A ===`)
  git(`checkout -b cc-session/branch-a`, repo)
  fs.writeFileSync(
    path.join(repo, `src/app.ts`),
    `export function greet(name: string) { return \`hello \${name}\` }\n`
  )
  git(`add -A`, repo)
  git(`commit -m "add name param to greet"`, repo)

  // === Create Branch B: modifies utils.ts ===
  console.log(`=== Creating Branch B ===`)
  git(`checkout main`, repo)
  git(`checkout -b cc-session/branch-b`, repo)
  fs.writeFileSync(
    path.join(repo, `src/utils.ts`),
    `export function add(a: number, b: number) { return a + b }\nexport function multiply(a: number, b: number) { return a * b }\n`
  )
  git(`add -A`, repo)
  git(`commit -m "add multiply function"`, repo)
  git(`checkout main`, repo)

  // === Create fake CC sessions for each branch ===
  console.log(`=== Creating fake CC sessions ===`)

  const sessionAId = crypto.randomUUID()
  const sessionBId = crypto.randomUUID()

  // Session A JSONL
  const sessionADir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(repo)
  )
  cleanupDirs.push(sessionADir)
  fs.mkdirSync(sessionADir, { recursive: true })

  const sessionAEntries = [
    JSON.stringify({
      type: `user`,
      message: {
        role: `user`,
        content: `Add a name parameter to the greet function`,
      },
      uuid: `a-1`,
      parentUuid: null,
      cwd: repo,
      sessionId: sessionAId,
      gitBranch: `cc-session/branch-a`,
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: `assistant`,
      message: {
        role: `assistant`,
        content: [
          {
            type: `text`,
            text: `I updated greet() in src/app.ts to accept a name parameter and return a personalized greeting using a template literal.`,
          },
        ],
      },
      uuid: `a-2`,
      parentUuid: `a-1`,
      cwd: repo,
      sessionId: sessionAId,
      gitBranch: `cc-session/branch-a`,
      timestamp: new Date().toISOString(),
    }),
  ]
  fs.writeFileSync(
    path.join(sessionADir, `${sessionAId}.jsonl`),
    sessionAEntries.join(`\n`) + `\n`
  )
  console.log(`  Session A: ${sessionAId} (branch-a, modifies app.ts)`)

  // Session B JSONL
  const sessionBEntries = [
    JSON.stringify({
      type: `user`,
      message: { role: `user`, content: `Add a multiply function to utils` },
      uuid: `b-1`,
      parentUuid: null,
      cwd: repo,
      sessionId: sessionBId,
      gitBranch: `cc-session/branch-b`,
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: `assistant`,
      message: {
        role: `assistant`,
        content: [
          {
            type: `text`,
            text: `I added a multiply() function to src/utils.ts that takes two numbers and returns their product.`,
          },
        ],
      },
      uuid: `b-2`,
      parentUuid: `b-1`,
      cwd: repo,
      sessionId: sessionBId,
      gitBranch: `cc-session/branch-b`,
      timestamp: new Date().toISOString(),
    }),
  ]
  fs.writeFileSync(
    path.join(sessionADir, `${sessionBId}.jsonl`),
    sessionBEntries.join(`\n`) + `\n`
  )
  console.log(`  Session B: ${sessionBId} (branch-b, modifies utils.ts)`)

  // === Test merge ===
  console.log(`\n=== Testing merge ===`)

  const { merge } = await import(`../src/merge.js`)
  const savedCwd = process.cwd()
  process.chdir(repo)

  try {
    merge({ sessionA: sessionAId, sessionB: sessionBId })
  } catch (err) {
    console.error(`Merge failed:`, err)
    process.chdir(savedCwd)
    process.exit(1)
  }

  process.chdir(savedCwd)

  // === Verify results ===
  console.log(`\n=== Verifying results ===`)

  // Find the merge worktree
  const mergeDir = fs
    .readdirSync(repo)
    .find((f) => f.startsWith(`session-merge-`))

  if (!mergeDir) {
    console.error(`  ERROR: No merge worktree found`)
    process.exit(1)
  }

  const mergePath = path.join(repo, mergeDir)
  console.log(`  Merge worktree: ${mergePath}`)

  // Check merged code
  const mergedApp = fs.readFileSync(path.join(mergePath, `src/app.ts`), `utf-8`)
  const hasGreetName = mergedApp.includes(`name`)
  console.log(`  Has greet(name): ${hasGreetName}`)

  const mergedUtils = fs.readFileSync(
    path.join(mergePath, `src/utils.ts`),
    `utf-8`
  )
  const hasMultiply = mergedUtils.includes(`multiply`)
  console.log(`  Has multiply: ${hasMultiply}`)

  // Check merged session JSONL exists
  const mergeEncodedCwd = encodeCwd(mergePath)
  const mergeProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    mergeEncodedCwd
  )
  cleanupDirs.push(mergeProjectDir)

  if (fs.existsSync(mergeProjectDir)) {
    const jsonlFiles = fs
      .readdirSync(mergeProjectDir)
      .filter((f) => f.endsWith(`.jsonl`))
    console.log(`  Merged session JSONL: ${jsonlFiles.length > 0}`)

    if (jsonlFiles.length > 0) {
      const content = fs.readFileSync(
        path.join(mergeProjectDir, jsonlFiles[0]),
        `utf-8`
      )
      const lines = content.trim().split(`\n`)
      console.log(`  Merged session entries: ${lines.length}`)

      // Check the last entry is the merge context message
      const lastLine = JSON.parse(lines[lines.length - 1])
      const hasMergeContext =
        typeof lastLine.message?.content === `string` &&
        lastLine.message.content.includes(
          `Two branches of work have been merged`
        )
      console.log(`  Has merge context message: ${hasMergeContext}`)
    }
  } else {
    console.log(`  WARNING: No merged session directory found`)
  }

  if (hasGreetName && hasMultiply) {
    console.log(`\n=== All Phase 3 tests passed! ===`)
  } else {
    console.error(`\n=== FAILED: Missing expected code changes ===`)
    process.exit(1)
  }

  // Cleanup
  // Remove worktree first before deleting repo
  try {
    git(`worktree remove ${mergePath} --force`, repo)
  } catch {
    // best effort
  }
  fs.rmSync(tmpBase, { recursive: true, force: true })
  for (const dir of cleanupDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

main().catch((err) => {
  console.error(`Test failed:`, err)
  process.exit(1)
})
