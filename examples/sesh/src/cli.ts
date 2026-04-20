#!/usr/bin/env node

/**
 * sesh — Git-integrated CC session management via Durable Streams.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { discoverSessions } from "@durable-streams/agent-session-protocol"
import {
  findRepoRoot,
  readConfig,
  readPreferences,
  saveToken,
  writeConfig,
  writePreferences,
} from "./config.js"
import { getGitUser, listSessionFiles, writeSessionFile } from "./sessions.js"
import { pushAll } from "./push.js"
import { resume } from "./resume.js"
import { merge } from "./merge.js"
import type {
  AgentType,
  DiscoveredSession,
} from "@durable-streams/agent-session-protocol"

const args = process.argv.slice(2)
const command = args[0]

function usage(): void {
  console.log(`Usage:
  sesh init --server <url> [--token <token>] [--agent claude|codex]  Initialize sesh
  sesh checkin [--session <id>] [--name <name>] [--agent claude|codex]  Mark a session
  sesh push                                       Push session deltas to DS
  sesh list                                       List tracked sessions
  sesh resume [<session-id>] [--agent claude|codex] [--no-checkin] [--at <commit>]  Fork and resume
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

/**
 * Resolve the agent to use for a command. Checks --agent first, then the
 * user's local preference (.sesh/.local/preferences.json, gitignored so it
 * doesn't leak across teammates). When `required`, errors out if neither
 * is set — no silent default, since a mismatched default would bite
 * codex-only users.
 */
function resolveAgent(
  repoRoot: string,
  required: boolean
): AgentType | undefined {
  const flag = parseArg(`--agent`)
  const prefs = readPreferences(repoRoot)
  const resolved = (flag ?? prefs.agent) as AgentType | undefined
  if (!resolved && required) {
    console.error(`No agent specified and no preferred agent configured.`)
    console.error(`Either:`)
    console.error(`  - pass --agent claude|codex to this command, or`)
    console.error(
      `  - set a local preference: sesh init --agent claude|codex --server <url>`
    )
    process.exit(1)
  }
  return resolved
}

/**
 * Read the Claude session slug from the first entry that has one.
 * Claude-only — codex sessions don't have slugs.
 */
function readClaudeSlug(jsonlPath: string): string | null {
  try {
    const content = fs.readFileSync(jsonlPath, `utf-8`)
    for (const line of content.split(`\n`)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (typeof entry.slug === `string`) return entry.slug
      } catch {
        continue
      }
    }
  } catch {
    return null
  }
  return null
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

    const agent = parseArg(`--agent`) as AgentType | undefined
    if (agent) {
      // Preference is per-user, not per-repo: stored in .sesh/.local/ so
      // teammates aren't silently nudged toward one dev's chosen agent.
      writePreferences(repoRoot, { agent })
    }

    const token = parseArg(`--token`)
    if (token) {
      saveToken(repoRoot, token)
      console.log(`Token saved to .sesh/.local/credentials.json`)
    }

    console.log(`Initialized sesh in ${repoRoot}`)
    console.log(`  Config: .sesh/config.json (shared)`)
    if (agent) {
      console.log(
        `  Preferred agent: ${agent} (local only — .sesh/.local/preferences.json)`
      )
    } else {
      console.log(
        `  No preferred agent set. Pass --agent to checkin/resume, or re-init with --agent.`
      )
    }
    console.log(
      `  Add to git: git add .sesh/config.json .sesh/sessions/ .sesh/.local/.gitignore`
    )
  } else if (command === `checkin`) {
    const repoRoot = requireRepoRoot()
    requireConfig(repoRoot)
    const checkinAgent = resolveAgent(repoRoot, true)!

    let sessionId = parseArg(`--session`)
    let cwd: string | undefined
    let match: DiscoveredSession | undefined

    if (!sessionId) {
      // Auto-detect — only claude has a process registry, so for codex this
      // will return nothing active and the user has to pass --session.
      const all = await discoverSessions(checkinAgent)
      const active = all.filter((s) => s.active)
      let candidates = active.filter((s) => s.cwd === process.cwd())
      if (candidates.length === 0) candidates = active
      if (candidates.length === 0) {
        console.error(`No active ${checkinAgent} sessions found.`)
        console.error(`Use --session <id> to specify one explicitly.`)
        process.exit(1)
      }
      if (candidates.length > 1) {
        console.error(`Multiple active sessions found:`)
        for (const s of candidates) {
          console.error(`  ${s.sessionId} (cwd: ${s.cwd ?? `?`})`)
        }
        console.error(`\nUse --session <id> to specify which one.`)
        process.exit(1)
      }
      match = candidates[0]
      sessionId = match.sessionId
      cwd = match.cwd
    } else {
      // Explicit session: find it in discovery to learn its cwd
      const all = await discoverSessions(checkinAgent)
      match = all.find((s) => s.sessionId === sessionId)
      cwd = match?.cwd
    }

    const resolvedCwd = cwd ?? process.cwd()

    // Make cwd relative to repo root (handle symlinks via realpath)
    const realCwd = fs.existsSync(resolvedCwd)
      ? fs.realpathSync(resolvedCwd)
      : resolvedCwd
    const realRoot = fs.realpathSync(repoRoot)
    let relativeCwd: string
    if (realCwd.startsWith(realRoot)) {
      const rel = realCwd.slice(realRoot.length + 1)
      relativeCwd = rel ? `./${rel}` : `.`
    } else if (resolvedCwd.startsWith(repoRoot)) {
      const rel = resolvedCwd.slice(repoRoot.length + 1)
      relativeCwd = rel ? `./${rel}` : `.`
    } else {
      relativeCwd = resolvedCwd
    }

    // Get name. Claude sessions may have an embedded slug; codex doesn't.
    let name = parseArg(`--name`)
    if (!name) {
      if (checkinAgent === `claude` && match?.path) {
        name = readClaudeSlug(match.path) ?? sessionId.slice(0, 8)
      } else {
        name = sessionId.slice(0, 8)
      }
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
      agent: checkinAgent,
      createdBy: getGitUser(),
      forkedFromOffset: null,
    })

    console.log(`Checked in session: ${name} (${sessionId})`)
    console.log(`  cwd: ${relativeCwd}`)
    console.log(`  agent: ${checkinAgent}`)
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
        `${prefix}${s.sessionId}  "${s.name}"  by ${s.createdBy}  cwd: ${s.cwd}  agent: ${s.agent}  ${offset}`
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
          console.error(`  ${s.sessionId}  "${s.name}"  by ${s.createdBy}`)
        }
        console.error(`\nSpecify which one: sesh resume <session-id>`)
        process.exit(1)
      }
    }

    // Resolve short ID or name to full session ID
    const allSessions = listSessionFiles(repoRoot)
    const match =
      allSessions.find((s) => s.sessionId === sessionId) ??
      allSessions.find((s) => s.name === sessionId)
    if (match) {
      sessionId = match.sessionId
    }

    const noCheckin = hasFlag(`--no-checkin`)
    const atCommit = parseArg(`--at`)
    // Resolve target agent: --agent > local preference > fall through to
    // source agent (determined inside resume()). No silent claude default.
    const targetAgent = resolveAgent(repoRoot, false)

    console.log(`Forking session ${sessionId.slice(0, 8)}...`)

    const result = await resume({
      sessionId,
      repoRoot,
      noCheckin,
      atCommit,
      targetAgent,
    })

    console.log(`  New session: ${result.newSessionId}`)
    console.log(`  Restored ${result.entriesRestored} entries`)
    console.log(`  Agent: ${result.agent}`)
    if (!noCheckin) {
      console.log(`  Checked in: .sesh/sessions/${result.newSessionId}.json`)
    }

    if (result.agent === `codex`) {
      console.log(
        `\nResume with: cd ${result.cwd} && codex resume ${result.newSessionId}`
      )
    } else {
      console.log(
        `\nResume with: cd ${result.cwd} && claude --resume ${result.newSessionId}`
      )
    }
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

    // Resolve the compiled CLI (dist/cli.js). When sesh is invoked via the
    // globally linked `sesh` bin, import.meta.url points at dist/cli.js, so
    // `./cli.js` resolves correctly alongside it. We invoke via plain node
    // so the hook doesn't need tsx at commit time.
    const seshCliPath = new URL(`./cli.js`, import.meta.url).pathname

    const hookContent = `#!/bin/sh
# sesh pre-commit hook — pushes session data to DS and stages updated files
# set -e so a failing push aborts the commit (better to catch problems early
# than silently ship an unpushed session).
set -e
node ${seshCliPath} push
# Stage any updated session files (best-effort — no sessions is fine).
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
