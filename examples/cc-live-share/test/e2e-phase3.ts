#!/usr/bin/env npx tsx

/**
 * End-to-end test for Phase 3: merge.
 * Creates two forks, makes different changes, merges them.
 * Requires `claude` CLI to be installed (for conflict resolution agent).
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
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `ds-cc-phase3-`))
  const bareRepo = path.join(tmpBase, `remote.git`)
  const workRepo = path.join(tmpBase, `work`)
  const cleanupDirs: Array<string> = []

  console.log(`=== Setup ===`)
  console.log(`  Base: ${tmpBase}`)

  // Create bare repo
  fs.mkdirSync(bareRepo)
  git(`init --bare`, bareRepo)

  // Create working repo with initial commit
  fs.mkdirSync(workRepo)
  git(`init`, workRepo)
  git(`checkout -b main`, workRepo)
  fs.mkdirSync(path.join(workRepo, `src`), { recursive: true })
  fs.writeFileSync(path.join(workRepo, `README.md`), `# Merge Test\n`)
  fs.writeFileSync(
    path.join(workRepo, `src/app.ts`),
    `export function greet() { return "hello" }\n`
  )
  fs.writeFileSync(
    path.join(workRepo, `src/utils.ts`),
    `export function add(a: number, b: number) { return a + b }\n`
  )
  git(`add -A`, workRepo)
  git(`commit -m "initial commit"`, workRepo)
  git(`remote add origin ${bareRepo}`, workRepo)
  git(`push origin main`, workRepo)

  // Create a fake base CC session
  const baseSessionId = `00000000-0000-0000-0000-000000000099`
  const baseProjectDir = path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(workRepo)
  )
  cleanupDirs.push(baseProjectDir)
  fs.mkdirSync(baseProjectDir, { recursive: true })

  const baseJsonlEntries = [
    JSON.stringify({
      type: `user`,
      message: {
        role: `user`,
        content: `Set up a project with greet and add functions.`,
      },
      uuid: `base-1`,
      parentUuid: null,
      cwd: workRepo,
      sessionId: baseSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: `assistant`,
      message: {
        role: `assistant`,
        content: [
          {
            type: `text`,
            text: `Created src/app.ts with greet() and src/utils.ts with add().`,
          },
        ],
      },
      uuid: `base-2`,
      parentUuid: `base-1`,
      cwd: workRepo,
      sessionId: baseSessionId,
      gitBranch: `main`,
      timestamp: new Date().toISOString(),
    }),
  ]
  fs.writeFileSync(
    path.join(baseProjectDir, `${baseSessionId}.jsonl`),
    baseJsonlEntries.join(`\n`) + `\n`
  )

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
    const { DurableStream } = await import(`@durable-streams/client`)
    const { sanitizeJsonLine } = await import(`../src/sanitize.js`)
    const { exportBranch, getRemoteUrl } = await import(`../src/git.js`)

    // === Create Fork A (changes greet function) ===
    console.log(`\n=== Creating Fork A ===`)

    // Make changes for fork A
    fs.writeFileSync(
      path.join(workRepo, `src/app.ts`),
      `export function greet(name: string) { return \`hello \${name}\` }\n`
    )
    const epochA = Date.now()
    const forkABranch = `cc-session/${baseSessionId}/${epochA}`
    exportBranch(workRepo, forkABranch, `origin`)

    // Restore working dir
    fs.writeFileSync(
      path.join(workRepo, `src/app.ts`),
      `export function greet() { return "hello" }\n`
    )

    // Write Fork A to DS
    const forkAUrl = `${baseUrl}/cc/${baseSessionId}/${epochA}`
    await DurableStream.create({
      url: `${forkAUrl}/session`,
      contentType: `application/json`,
    })
    const forkAStream = new DurableStream({
      url: `${forkAUrl}/session`,
      contentType: `application/json`,
    })

    const forkAEntries = [
      ...baseJsonlEntries,
      JSON.stringify({
        type: `user`,
        message: { role: `user`, content: `Add a name parameter to greet()` },
        uuid: `a-1`,
        parentUuid: `base-2`,
        cwd: workRepo,
        sessionId: baseSessionId,
        gitBranch: forkABranch,
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: `assistant`,
        message: {
          role: `assistant`,
          content: [
            {
              type: `text`,
              text: `Updated greet() to accept a name parameter.`,
            },
          ],
        },
        uuid: `a-2`,
        parentUuid: `a-1`,
        cwd: workRepo,
        sessionId: baseSessionId,
        gitBranch: forkABranch,
        timestamp: new Date().toISOString(),
      }),
    ]

    for (const entry of forkAEntries) {
      const sanitized = sanitizeJsonLine(entry)
      if (sanitized) await forkAStream.append(sanitized)
    }

    await DurableStream.create({
      url: `${forkAUrl}/meta`,
      contentType: `application/json`,
    })
    const forkAMeta = new DurableStream({
      url: `${forkAUrl}/meta`,
      contentType: `application/json`,
    })
    await forkAMeta.append(
      JSON.stringify({
        type: `fork-metadata`,
        version: 1,
        sessionId: baseSessionId,
        repo: getRemoteUrl(workRepo, `origin`),
        branch: forkABranch,
        originalCwd: workRepo,
        createdAt: new Date().toISOString(),
      })
    )
    console.log(`  Fork A: ${forkAUrl}`)
    console.log(`  Branch: ${forkABranch}`)

    // === Create Fork B (changes utils function) ===
    console.log(`\n=== Creating Fork B ===`)

    fs.writeFileSync(
      path.join(workRepo, `src/utils.ts`),
      `export function add(a: number, b: number) { return a + b }\nexport function multiply(a: number, b: number) { return a * b }\n`
    )
    const epochB = Date.now() + 1 // ensure different
    const forkBBranch = `cc-session/${baseSessionId}/${epochB}`
    exportBranch(workRepo, forkBBranch, `origin`)

    // Restore working dir
    fs.writeFileSync(
      path.join(workRepo, `src/utils.ts`),
      `export function add(a: number, b: number) { return a + b }\n`
    )

    // Write Fork B to DS
    const forkBUrl = `${baseUrl}/cc/${baseSessionId}/${epochB}`
    await DurableStream.create({
      url: `${forkBUrl}/session`,
      contentType: `application/json`,
    })
    const forkBStream = new DurableStream({
      url: `${forkBUrl}/session`,
      contentType: `application/json`,
    })

    const forkBEntries = [
      ...baseJsonlEntries,
      JSON.stringify({
        type: `user`,
        message: { role: `user`, content: `Add a multiply function to utils` },
        uuid: `b-1`,
        parentUuid: `base-2`,
        cwd: workRepo,
        sessionId: baseSessionId,
        gitBranch: forkBBranch,
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: `assistant`,
        message: {
          role: `assistant`,
          content: [
            { type: `text`, text: `Added multiply() to src/utils.ts.` },
          ],
        },
        uuid: `b-2`,
        parentUuid: `b-1`,
        cwd: workRepo,
        sessionId: baseSessionId,
        gitBranch: forkBBranch,
        timestamp: new Date().toISOString(),
      }),
    ]

    for (const entry of forkBEntries) {
      const sanitized = sanitizeJsonLine(entry)
      if (sanitized) await forkBStream.append(sanitized)
    }

    await DurableStream.create({
      url: `${forkBUrl}/meta`,
      contentType: `application/json`,
    })
    const forkBMeta = new DurableStream({
      url: `${forkBUrl}/meta`,
      contentType: `application/json`,
    })
    await forkBMeta.append(
      JSON.stringify({
        type: `fork-metadata`,
        version: 1,
        sessionId: baseSessionId,
        repo: getRemoteUrl(workRepo, `origin`),
        branch: forkBBranch,
        originalCwd: workRepo,
        createdAt: new Date().toISOString(),
      })
    )
    console.log(`  Fork B: ${forkBUrl}`)
    console.log(`  Branch: ${forkBBranch}`)

    // === Test merge: Fork A into Fork B's branch ===
    console.log(`\n=== Testing merge (Fork A into Fork B) ===`)

    // We need to be in a repo that has both branches
    // Use the workRepo which has all branches via the bare remote
    git(`fetch origin`, workRepo)

    const { merge: mergeFn } = await import(`../src/merge.js`)
    // Save cwd and change to workRepo for the merge
    const savedCwd = process.cwd()
    process.chdir(workRepo)

    try {
      await mergeFn({
        forkUrl: forkAUrl,
        into: `origin/${forkBBranch}`,
      })
    } catch (err) {
      console.error(`Merge failed:`, err)
    }

    process.chdir(savedCwd)

    // Check if merge worktree was created
    const mergeWorktrees = fs
      .readdirSync(tmpBase)
      .filter((f) => f.startsWith(`session-merge-`))

    // Also check in workRepo parent for worktrees
    const workRepoParent = path.dirname(workRepo)
    const mergeInParent = fs
      .readdirSync(workRepoParent)
      .filter((f) => f.startsWith(`session-merge-`))

    console.log(
      `\n  Merge worktrees found: ${mergeWorktrees.length + mergeInParent.length}`
    )

    // Check in the workRepo itself (path.resolve uses cwd which was workRepo)
    const allFiles = fs.readdirSync(workRepo)
    const mergeInWork = allFiles.filter((f) => f.startsWith(`session-merge-`))
    if (mergeInWork.length > 0) {
      const mergePath = path.join(workRepo, mergeInWork[0])
      console.log(`  Merge worktree: ${mergePath}`)

      // Verify merged code has both changes
      const mergedApp = fs.readFileSync(
        path.join(mergePath, `src/app.ts`),
        `utf-8`
      )
      console.log(`  Has greet(name): ${mergedApp.includes(`name`)}`)

      const mergedUtils = fs.readFileSync(
        path.join(mergePath, `src/utils.ts`),
        `utf-8`
      )
      console.log(`  Has multiply: ${mergedUtils.includes(`multiply`)}`)
    }

    console.log(`\n=== Phase 3 test complete! ===`)
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

main().catch((err) => {
  console.error(`Test failed:`, err)
  process.exit(1)
})
