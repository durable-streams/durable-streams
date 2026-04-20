/**
 * Session file management — reading/writing .sesh/sessions/*.json
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execSync } from "node:child_process"
import { getSeshDir } from "./config.js"
import type { AgentType } from "@durable-streams/agent-session-protocol"

export interface SessionFile {
  sessionId: string
  parentSessionId: string | null
  streamUrl: string | null
  lastOffset: string | null
  entryCount: number
  name: string
  cwd: string
  agent: AgentType
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
 * Encode a working directory path for Claude's project-dir naming convention.
 * Used by the merge flow, which is Claude-specific.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, `-`)
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
