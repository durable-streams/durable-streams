/**
 * sesh config management.
 * .sesh/config.json — checked into git (server URL)
 * .sesh/.local/credentials.json — per-user, gitignored (token)
 * .sesh/.local/ — gitignored (push state)
 */

import * as fs from "node:fs"
import * as path from "node:path"

export interface SeshConfig {
  server: string
  version: number
}

export interface Credentials {
  token?: string
}

export interface LocalSessionState {
  lastPushedUuid?: string
}

/**
 * Per-user preferences stored in .sesh/.local/ (gitignored) so that one
 * dev's agent choice doesn't leak to teammates via the shared config.json.
 */
export interface SeshPreferences {
  agent?: `claude` | `codex`
}

/**
 * Find the repo root by looking for .git directory.
 */
export function findRepoRoot(from: string = process.cwd()): string | null {
  let dir = path.resolve(from)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    if (fs.existsSync(path.join(dir, `.git`))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Get the .sesh directory path.
 */
export function getSeshDir(repoRoot: string): string {
  return path.join(repoRoot, `.sesh`)
}

/**
 * Read the sesh config. Returns null if not initialized.
 */
export function readConfig(repoRoot: string): SeshConfig | null {
  const configPath = path.join(getSeshDir(repoRoot), `config.json`)
  if (!fs.existsSync(configPath)) return null
  return JSON.parse(fs.readFileSync(configPath, `utf-8`)) as SeshConfig
}

/**
 * Write the sesh config.
 */
export function writeConfig(repoRoot: string, config: SeshConfig): void {
  const seshDir = getSeshDir(repoRoot)
  fs.mkdirSync(seshDir, { recursive: true })
  fs.writeFileSync(
    path.join(seshDir, `config.json`),
    JSON.stringify(config, null, 2) + `\n`
  )

  // Create .local directory with .gitignore
  const localDir = path.join(seshDir, `.local`)
  fs.mkdirSync(localDir, { recursive: true })
  const gitignorePath = path.join(seshDir, `.local`, `.gitignore`)
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `*\n`)
  }

  // Create sessions directory
  fs.mkdirSync(path.join(seshDir, `sessions`), { recursive: true })
}

/**
 * Get auth headers for DS requests.
 */
export function getAuthHeaders(repoRoot: string): Record<string, string> {
  // Check env var first
  const envToken = process.env.SESH_TOKEN
  if (envToken) {
    return { Authorization: `Bearer ${envToken}` }
  }

  // Check credentials file in .sesh/.local/
  const credPath = path.join(getSeshDir(repoRoot), `.local`, `credentials.json`)
  if (fs.existsSync(credPath)) {
    const creds = JSON.parse(fs.readFileSync(credPath, `utf-8`)) as Credentials
    if (creds.token) {
      return { Authorization: `Bearer ${creds.token}` }
    }
  }

  return {}
}

/**
 * Save token to credentials file in .sesh/.local/ (gitignored).
 */
export function saveToken(repoRoot: string, token: string): void {
  const localDir = path.join(getSeshDir(repoRoot), `.local`)
  fs.mkdirSync(localDir, { recursive: true })
  fs.writeFileSync(
    path.join(localDir, `credentials.json`),
    JSON.stringify({ token }, null, 2) + `\n`
  )
}

/**
 * Read local push state for a session.
 */
export function readLocalState(
  repoRoot: string,
  sessionId: string
): LocalSessionState {
  const statePath = path.join(
    getSeshDir(repoRoot),
    `.local`,
    `${sessionId}.json`
  )
  if (!fs.existsSync(statePath)) return {}
  return JSON.parse(fs.readFileSync(statePath, `utf-8`)) as LocalSessionState
}

/**
 * Write local push state for a session.
 */
export function writeLocalState(
  repoRoot: string,
  sessionId: string,
  state: LocalSessionState
): void {
  const localDir = path.join(getSeshDir(repoRoot), `.local`)
  fs.mkdirSync(localDir, { recursive: true })
  fs.writeFileSync(
    path.join(localDir, `${sessionId}.json`),
    JSON.stringify(state, null, 2) + `\n`
  )
}

/**
 * Read per-user preferences from .sesh/.local/preferences.json.
 */
export function readPreferences(repoRoot: string): SeshPreferences {
  const prefsPath = path.join(
    getSeshDir(repoRoot),
    `.local`,
    `preferences.json`
  )
  if (!fs.existsSync(prefsPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(prefsPath, `utf-8`)) as SeshPreferences
  } catch {
    return {}
  }
}

/**
 * Write per-user preferences to .sesh/.local/preferences.json.
 */
export function writePreferences(
  repoRoot: string,
  prefs: SeshPreferences
): void {
  const localDir = path.join(getSeshDir(repoRoot), `.local`)
  fs.mkdirSync(localDir, { recursive: true })
  fs.writeFileSync(
    path.join(localDir, `preferences.json`),
    JSON.stringify(prefs, null, 2) + `\n`
  )
}
