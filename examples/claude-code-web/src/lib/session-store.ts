import { nanoid } from "nanoid"
import type { Session, CreateSessionRequest, ContainerState } from "./types"

/**
 * In-memory session store
 *
 * In production, this would be backed by a database like PostgreSQL or SQLite.
 * For simplicity, we use an in-memory Map with persistence hooks.
 */

const sessions = new Map<string, Session>()

// Idle timers for sessions
const idleTimers = new Map<string, NodeJS.Timeout>()

export interface SessionStoreOptions {
  idleTimeoutMs: number
  onIdleTimeout?: (sessionId: string) => Promise<void>
}

let storeOptions: SessionStoreOptions = {
  idleTimeoutMs: 300000, // 5 minutes default
}

export function configureSessionStore(options: SessionStoreOptions): void {
  storeOptions = options
}

/**
 * Create a new session
 */
export function createSession(request: CreateSessionRequest): Session {
  const id = nanoid()
  const now = new Date().toISOString()

  const session: Session = {
    id,
    name:
      request.name || `${request.repoOwner}/${request.repoName} - ${id.slice(0, 6)}`,
    repoOwner: request.repoOwner,
    repoName: request.repoName,
    branch: request.branch,
    state: "stopped",
    sandboxId: null,
    parentSessionId: null,
    createdAt: now,
    updatedAt: now,
    idleTimerStartedAt: null,
  }

  sessions.set(id, session)
  return session
}

/**
 * Create a sub-instance session
 */
export function createSubSession(
  parentSessionId: string,
  request: CreateSessionRequest & { branch: string }
): Session {
  const parent = sessions.get(parentSessionId)
  if (!parent) {
    throw new Error(`Parent session not found: ${parentSessionId}`)
  }

  const id = nanoid()
  const now = new Date().toISOString()

  const session: Session = {
    id,
    name: `Sub: ${request.branch}`,
    repoOwner: request.repoOwner,
    repoName: request.repoName,
    branch: request.branch,
    state: "stopped",
    sandboxId: null,
    parentSessionId,
    createdAt: now,
    updatedAt: now,
    idleTimerStartedAt: null,
  }

  sessions.set(id, session)
  return session
}

/**
 * Get a session by ID
 */
export function getSession(id: string): Session | undefined {
  return sessions.get(id)
}

/**
 * List all sessions
 */
export function listSessions(): Session[] {
  return Array.from(sessions.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
}

/**
 * List sub-sessions of a parent
 */
export function listSubSessions(parentId: string): Session[] {
  return Array.from(sessions.values())
    .filter((s) => s.parentSessionId === parentId)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
}

/**
 * Update session state
 */
export function updateSessionState(
  id: string,
  state: ContainerState,
  sandboxId?: string | null
): Session | undefined {
  const session = sessions.get(id)
  if (!session) return undefined

  session.state = state
  session.updatedAt = new Date().toISOString()

  if (sandboxId !== undefined) {
    session.sandboxId = sandboxId
  }

  // Clear idle timer if moving to running
  if (state === "running") {
    clearIdleTimer(id)
    session.idleTimerStartedAt = null
  }

  sessions.set(id, session)
  return session
}

/**
 * Start idle timer for a session
 */
export function startIdleTimer(id: string): void {
  const session = sessions.get(id)
  if (!session) return

  // Clear existing timer
  clearIdleTimer(id)

  // Update session state
  session.state = "idle"
  session.idleTimerStartedAt = new Date().toISOString()
  session.updatedAt = new Date().toISOString()
  sessions.set(id, session)

  // Start new timer
  const timer = setTimeout(async () => {
    if (storeOptions.onIdleTimeout) {
      await storeOptions.onIdleTimeout(id)
    }
    updateSessionState(id, "stopped", null)
  }, storeOptions.idleTimeoutMs)

  idleTimers.set(id, timer)
}

/**
 * Clear idle timer for a session
 */
export function clearIdleTimer(id: string): void {
  const timer = idleTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    idleTimers.delete(id)
  }
}

/**
 * Delete a session
 */
export function deleteSession(id: string): boolean {
  clearIdleTimer(id)
  return sessions.delete(id)
}

/**
 * Get sessions by state
 */
export function getSessionsByState(state: ContainerState): Session[] {
  return Array.from(sessions.values()).filter((s) => s.state === state)
}
