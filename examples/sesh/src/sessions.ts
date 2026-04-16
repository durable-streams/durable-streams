/**
 * Session file management — reading/writing .sesh/sessions/*.json
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execSync } from "node:child_process"
import { getSeshDir } from "./config.js"

export interface SessionFile {
  sessionId: string
  parentSessionId: string | null
  streamUrl: string | null
  lastOffset: string | null
  entryCount: number
  name: string
  cwd: string
  agent: string
  createdBy: string
  forkedFromOffset: string | null
}

/**
 * Get the sessions directory path.
 */
export function getSessionsDir(repoRoot: string): string {
  return path.join(getSeshDir(repoRoot), `sessions`)
}

/**
 * Read a session file.
 */
export function readSessionFile(
  repoRoot: string,
  sessionId: string
): SessionFile | null {
  const filePath = path.join(getSessionsDir(repoRoot), `${sessionId}.json`)
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, `utf-8`)) as SessionFile
}

/**
 * Write a session file.
 */
export function writeSessionFile(repoRoot: string, session: SessionFile): void {
  const dir = getSessionsDir(repoRoot)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${session.sessionId}.json`),
    JSON.stringify(session, null, 2) + `\n`
  )
}

/**
 * List all session files.
 */
export function listSessionFiles(repoRoot: string): Array<SessionFile> {
  const dir = getSessionsDir(repoRoot)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(`.json`))
    .map((f) => {
      const content = fs.readFileSync(path.join(dir, f), `utf-8`)
      return JSON.parse(content) as SessionFile
    })
}

/**
 * Encode a working directory path for CC's file naming convention.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, `-`)
}

/**
 * Get the local JSONL path for a CC session.
 */
export function getLocalJsonlPath(sessionId: string, cwd: string): string {
  return path.join(
    os.homedir(),
    `.claude`,
    `projects`,
    encodeCwd(cwd),
    `${sessionId}.jsonl`
  )
}

/**
 * Find active CC sessions for a given working directory.
 */
interface CCSessionMeta {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: string
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function findActiveSessions(filterCwd?: string): Array<CCSessionMeta> {
  const sessionsDir = path.join(os.homedir(), `.claude`, `sessions`)
  if (!fs.existsSync(sessionsDir)) return []

  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(`.json`))
  const sessions: Array<CCSessionMeta> = []

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), `utf-8`)
      const meta = JSON.parse(content) as CCSessionMeta
      if (!isProcessAlive(meta.pid)) continue
      if (filterCwd && meta.cwd !== filterCwd) continue

      const jsonlPath = getLocalJsonlPath(meta.sessionId, meta.cwd)
      if (!fs.existsSync(jsonlPath)) continue

      sessions.push(meta)
    } catch {
      // Skip invalid files
    }
  }

  return sessions
}

/**
 * Get the CC session slug/name if available.
 * Reads from the JSONL entries for a "slug" field.
 */
export function getSessionSlug(sessionId: string, cwd: string): string | null {
  const jsonlPath = getLocalJsonlPath(sessionId, cwd)
  if (!fs.existsSync(jsonlPath)) return null

  const content = fs.readFileSync(jsonlPath, `utf-8`)
  const lines = content.trim().split(`\n`)

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (typeof entry.slug === `string`) return entry.slug
    } catch {
      continue
    }
  }

  return null
}

/**
 * Find the cwd of a session by reading its JSONL file.
 * Searches all CC project directories for the session ID.
 */
export function getCwdFromJsonl(sessionId: string): string | null {
  const projectsDir = path.join(os.homedir(), `.claude`, `projects`)
  if (!fs.existsSync(projectsDir)) return null

  for (const dir of fs.readdirSync(projectsDir)) {
    const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`)
    if (!fs.existsSync(jsonlPath)) continue

    const content = fs.readFileSync(jsonlPath, `utf-8`)
    for (const line of content.split(`\n`)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (typeof entry.cwd === `string`) return entry.cwd
      } catch {
        continue
      }
    }
  }

  return null
}

/**
 * Get the current git user name.
 */
export function getGitUser(): string {
  try {
    return execSync(`git config user.name`, {
      encoding: `utf-8`,
      stdio: [`pipe`, `pipe`, `pipe`],
    }).trim()
  } catch {
    return os.userInfo().username
  }
}
