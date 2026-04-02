#!/usr/bin/env node

/**
 * sesh — Git-integrated CC session management via Durable Streams.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { findRepoRoot, readConfig, saveToken, writeConfig } from "./config.js"
import {
  findActiveSessions,
  getGitUser,
  getSessionSlug,
  listSessionFiles,
  writeSessionFile,
} from "./sessions.js"
import { pushAll } from "./push.js"
import { resume } from "./resume.js"
import { merge } from "./merge.js"

const args = process.argv.slice(2)
const command = args[0]

function usage(): void {
  console.log(`Usage:
  sesh init --server <url> [--token <token>]     Initialize sesh for this repo
  sesh checkin [--session <id>] [--name <name>]  Mark a session for tracking
  sesh push                                       Push session deltas to DS
  sesh list                                       List tracked sessions
  sesh resume [<session-id>] [--no-checkin] [--at <commit>]  Fork and resume a session
  sesh merge <session-A> <session-B>               Merge two sessions
  sesh install-hooks                              Install git pre-commit hook
  sesh install-skills [--global]                  Install /checkin skill for Claude Code
`)
}

function parseArg(flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return undefined
  return args[idx + 1]
}

function hasFlag(flag: string): boolean {
  return args.includes(flag)
}

function requireRepoRoot(): string {
  const root = findRepoRoot()
  if (!root) {
    console.error(`Not inside a git repository.`)
    process.exit(1)
  }
  return root
}

function requireConfig(repoRoot: string): void {
  if (!readConfig(repoRoot)) {
    console.error(`sesh not initialized. Run 'sesh init --server <url>' first.`)
    process.exit(1)
  }
}

async function main(): Promise<void> {
  if (!command || command === `--help` || command === `-h`) {
    usage()
    process.exit(0)
  }

  if (command === `init`) {
    const server = parseArg(`--server`)
    if (!server) {
      console.error(`Error: --server <url> is required\n`)
      usage()
      process.exit(1)
    }

    const repoRoot = requireRepoRoot()
    writeConfig(repoRoot, { server, version: 1 })

    const token = parseArg(`--token`)
    if (token) {
      saveToken(token)
      console.log(`Token saved to ~/.sesh/credentials.json`)
    }

    console.log(`Initialized sesh in ${repoRoot}`)
    console.log(`  Config: .sesh/config.json`)
    console.log(
      `  Add to git: git add .sesh/config.json .sesh/sessions/ .sesh/.local/.gitignore`
    )
  } else if (command === `checkin`) {
    const repoRoot = requireRepoRoot()
    requireConfig(repoRoot)

    let sessionId = parseArg(`--session`)
    let cwd: string

    if (!sessionId) {
      // Auto-detect
      let sessions = findActiveSessions(process.cwd())
      if (sessions.length === 0) {
        sessions = findActiveSessions()
      }
      if (sessions.length === 0) {
        console.error(`No active CC sessions found.`)
        console.error(`Use --session <id> to specify one explicitly.`)
        process.exit(1)
      }
      if (sessions.length > 1) {
        console.error(`Multiple active sessions found:`)
        for (const s of sessions) {
          console.error(`  ${s.sessionId} (cwd: ${s.cwd}, pid: ${s.pid})`)
        }
        console.error(`\nUse --session <id> to specify which one.`)
        process.exit(1)
      }
      sessionId = sessions[0].sessionId
      cwd = sessions[0].cwd
    } else {
      // Find cwd from active sessions or use current dir
      const all = findActiveSessions()
      const match = all.find((s) => s.sessionId === sessionId)
      cwd = match?.cwd ?? process.cwd()
    }

    // Make cwd relative to repo root (handle symlinks via realpath)
    const realCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd
    const realRoot = fs.realpathSync(repoRoot)
    let relativeCwd: string
    if (realCwd.startsWith(realRoot)) {
      const rel = realCwd.slice(realRoot.length + 1)
      relativeCwd = rel ? `./${rel}` : `.`
    } else if (cwd.startsWith(repoRoot)) {
      const rel = cwd.slice(repoRoot.length + 1)
      relativeCwd = rel ? `./${rel}` : `.`
    } else {
      relativeCwd = cwd
    }

    // Get name
    let name = parseArg(`--name`)
    if (!name) {
      name = getSessionSlug(sessionId, cwd) ?? sessionId.slice(0, 8)
    }

    // Check if already checked in
    const existing = listSessionFiles(repoRoot)
    if (existing.find((s) => s.sessionId === sessionId)) {
      console.log(`Session ${sessionId} is already checked in.`)
      process.exit(0)
    }

    writeSessionFile(repoRoot, {
      sessionId,
      parentSessionId: null,
      streamUrl: null,
      lastOffset: null,
      entryCount: 0,
      name,
      cwd: relativeCwd,
      agent: `claude`,
      createdBy: getGitUser(),
      forkedFromOffset: null,
    })

    console.log(`Checked in session: ${name} (${sessionId})`)
    console.log(`  cwd: ${relativeCwd}`)
    console.log(`  File: .sesh/sessions/${sessionId}.json`)
  } else if (command === `push`) {
    const repoRoot = requireRepoRoot()
    requireConfig(repoRoot)

    console.log(`Pushing sessions...`)
    const results = await pushAll(repoRoot)

    for (const r of results) {
      if (r.skipped) {
        console.log(`  ${r.sessionId.slice(0, 8)}: skipped (${r.reason})`)
      } else {
        console.log(
          `  ${r.sessionId.slice(0, 8)}: ${r.entriesPushed} entries → offset ${r.newOffset?.slice(-8) ?? `?`}`
        )
      }
    }

    console.log(`Done. Remember to commit updated session files.`)
  } else if (command === `list`) {
    const repoRoot = requireRepoRoot()
    const sessions = listSessionFiles(repoRoot)

    if (sessions.length === 0) {
      console.log(`No sessions checked in. Use 'sesh checkin' to add one.`)
      process.exit(0)
    }

    // Build lineage tree
    const byId = new Map(sessions.map((s) => [s.sessionId, s]))
    const children = new Map<string | null, Array<(typeof sessions)[0]>>()
    for (const s of sessions) {
      const parent = s.parentSessionId
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent)!.push(s)
    }

    function printSession(s: (typeof sessions)[0], indent: number): void {
      const prefix = indent > 0 ? `${`  `.repeat(indent - 1)}└── ` : ``
      const offset = s.lastOffset
        ? `offset: ...${s.lastOffset.slice(-8)}`
        : `not pushed`
      console.log(
        `${prefix}${s.sessionId.slice(0, 8)}  "${s.name}"  by ${s.createdBy}  cwd: ${s.cwd}  agent: ${s.agent}  ${offset}`
      )
      const kids = children.get(s.sessionId) ?? []
      for (const kid of kids) {
        printSession(kid, indent + 1)
      }
    }

    console.log(`Sessions:`)
    const roots = children.get(null) ?? []
    // Also include sessions whose parent isn't in the index
    for (const s of sessions) {
      if (s.parentSessionId && !byId.has(s.parentSessionId)) {
        roots.push(s)
      }
    }
    for (const s of roots) {
      printSession(s, 0)
    }
  } else if (command === `resume`) {
    const repoRoot = requireRepoRoot()
    requireConfig(repoRoot)

    let sessionId = args[1]
    if (!sessionId || sessionId.startsWith(`-`)) {
      // Auto-select
      const sessions = listSessionFiles(repoRoot)
      if (sessions.length === 0) {
        console.error(`No sessions to resume.`)
        process.exit(1)
      }
      if (sessions.length === 1) {
        sessionId = sessions[0].sessionId
      } else {
        console.error(`Multiple sessions available:`)
        for (const s of sessions) {
          console.error(
            `  ${s.sessionId.slice(0, 8)}  "${s.name}"  by ${s.createdBy}`
          )
        }
        console.error(`\nSpecify which one: sesh resume <session-id>`)
        process.exit(1)
      }
    }

    const noCheckin = hasFlag(`--no-checkin`)
    const atCommit = parseArg(`--at`)

    console.log(`Forking session ${sessionId.slice(0, 8)}...`)

    const result = await resume({
      sessionId,
      repoRoot,
      noCheckin,
      atCommit,
    })

    console.log(`  New session: ${result.newSessionId}`)
    console.log(`  Restored ${result.entriesRestored} entries`)
    if (!noCheckin) {
      console.log(`  Checked in: .sesh/sessions/${result.newSessionId}.json`)
    }

    console.log(`\nResume with: cd ${result.cwd} && claude --continue`)
  } else if (command === `merge`) {
    const repoRoot = requireRepoRoot()
    requireConfig(repoRoot)

    const sessionA = args[1]
    const sessionB = args[2]
    if (
      !sessionA ||
      !sessionB ||
      sessionA.startsWith(`-`) ||
      sessionB.startsWith(`-`)
    ) {
      console.error(`Error: two session IDs are required\n`)
      usage()
      process.exit(1)
    }

    merge({ sessionA, sessionB, repoRoot })
  } else if (command === `install-hooks`) {
    const repoRoot = requireRepoRoot()

    const hooksDir = `${repoRoot}/.git/hooks`
    const hookPath = `${hooksDir}/pre-commit`

    // Get the path to sesh CLI
    const seshCliPath = new URL(`./cli.ts`, import.meta.url).pathname

    const hookContent = `#!/bin/sh
# sesh pre-commit hook — pushes session data to DS and stages updated files
npx tsx ${seshCliPath} push 2>&1
# Stage any updated session files
git add .sesh/sessions/ 2>/dev/null || true
`

    // Check if hook already exists
    if (
      fs.existsSync(hookPath) &&
      !fs.readFileSync(hookPath, `utf-8`).includes(`sesh`)
    ) {
      // Append to existing hook
      fs.appendFileSync(hookPath, `\n${hookContent}`)
      console.log(`Appended sesh to existing pre-commit hook.`)
    } else {
      fs.writeFileSync(hookPath, hookContent)
      fs.chmodSync(hookPath, `755`)
      console.log(`Installed pre-commit hook: ${hookPath}`)
    }

    console.log(`Sessions will be auto-pushed on each commit.`)
  } else if (command === `install-skills`) {
    const skillsSource = new URL(`../skills`, import.meta.url).pathname
    const global = hasFlag(`--global`)
    const targetDir = global
      ? path.join(os.homedir(), `.claude`, `skills`)
      : path.resolve(`.claude`, `skills`)
    fs.mkdirSync(targetDir, { recursive: true })

    for (const skill of [`checkin`]) {
      const target = path.join(targetDir, skill)
      const source = path.join(skillsSource, skill)
      if (fs.existsSync(target)) {
        console.log(`  ${skill}: already exists, skipping`)
      } else {
        fs.symlinkSync(source, target)
        console.log(`  ${skill}: linked → ${source}`)
      }
    }
    console.log(
      `\nSkills installed${global ? ` globally` : ``}. Use /checkin in Claude Code.`
    )
  } else {
    console.error(`Unknown command: ${command}\n`)
    usage()
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`Error:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
