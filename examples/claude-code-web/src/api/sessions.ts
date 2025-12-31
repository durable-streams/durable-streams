import { createServerFn } from "@tanstack/start"
import { z } from "zod"
import {
  createSession,
  getSession,
  listSessions,
  updateSessionState,
  deleteSession,
  startIdleTimer,
  clearIdleTimer,
  createSubSession,
} from "~/lib/session-store"
import { ensureSessionStreams, getSessionStreams } from "~/lib/durable-streams"
import { createSandbox, terminateSandbox, resizePty } from "~/lib/modal"
import { getEnvConfig, generateSessionToken } from "~/lib/env"
import { CreateSessionSchema, SpawnRequestSchema } from "~/lib/types"

// List all sessions
export const getSessions = createServerFn({ method: "GET" }).handler(async () => {
  const sessions = listSessions()
  return { sessions }
})

// Get a single session
export const getSessionById = createServerFn({ method: "GET" })
  .validator(z.object({ sessionId: z.string() }))
  .handler(async ({ data }) => {
    const session = getSession(data.sessionId)
    if (!session) {
      throw new Error("Session not found")
    }
    return { session }
  })

// Create a new session
export const createNewSession = createServerFn({ method: "POST" })
  .validator(CreateSessionSchema)
  .handler(async ({ data }) => {
    const env = getEnvConfig()

    // Create session in store
    const session = createSession(data)

    // Ensure durable streams exist for this session
    await ensureSessionStreams(session.id, env.durableStreamsUrl)

    return session
  })

// Connect to a session (starts container if needed)
export const connectToSession = createServerFn({ method: "POST" })
  .validator(z.object({ sessionId: z.string() }))
  .handler(async ({ data }) => {
    const session = getSession(data.sessionId)
    if (!session) {
      throw new Error("Session not found")
    }

    const env = getEnvConfig()
    const streams = getSessionStreams(data.sessionId)

    // If session is stopped, start it
    if (session.state === "stopped" || session.state === "idle") {
      // Clear any existing idle timer
      clearIdleTimer(data.sessionId)

      // Update state to starting
      updateSessionState(data.sessionId, "starting")

      try {
        // Create Modal sandbox
        const sandbox = await createSandbox({
          sessionId: data.sessionId,
          repoOwner: session.repoOwner,
          repoName: session.repoName,
          branch: session.branch,
          anthropicApiKey: env.anthropicApiKey,
          githubToken: env.githubToken,
          apiUrl: env.durableStreamsUrl.replace("/v1/stream", ""),
          apiToken: generateSessionToken(data.sessionId),
        })

        // Update session with sandbox ID and running state
        updateSessionState(data.sessionId, "running", sandbox.id)
      } catch (err) {
        // Revert to stopped on failure
        updateSessionState(data.sessionId, "stopped", null)
        throw err
      }
    }

    // Get updated session
    const updatedSession = getSession(data.sessionId)

    return {
      session: updatedSession,
      inputStreamUrl: `${env.durableStreamsUrl}/${streams.input}`,
      outputStreamUrl: `${env.durableStreamsUrl}/${streams.output}`,
    }
  })

// Disconnect from a session (stops container but keeps session)
export const disconnectSession = createServerFn({ method: "POST" })
  .validator(z.object({ sessionId: z.string() }))
  .handler(async ({ data }) => {
    const session = getSession(data.sessionId)
    if (!session) {
      throw new Error("Session not found")
    }

    if (session.sandboxId) {
      await terminateSandbox(session.sandboxId)
    }

    updateSessionState(data.sessionId, "stopped", null)
    clearIdleTimer(data.sessionId)

    return { success: true }
  })

// Delete a session
export const deleteSessionById = createServerFn({ method: "DELETE" })
  .validator(z.object({ sessionId: z.string() }))
  .handler(async ({ data }) => {
    const session = getSession(data.sessionId)
    if (!session) {
      return { success: true }
    }

    // Terminate sandbox if running
    if (session.sandboxId) {
      await terminateSandbox(session.sandboxId)
    }

    // Delete from store
    deleteSession(data.sessionId)

    return { success: true }
  })

// Resize terminal
export const resizeSession = createServerFn({ method: "POST" })
  .validator(
    z.object({
      sessionId: z.string(),
      cols: z.number(),
      rows: z.number(),
    })
  )
  .handler(async ({ data }) => {
    const session = getSession(data.sessionId)
    if (!session || !session.sandboxId) {
      return { success: false }
    }

    // Get the process ID from session (we'd need to store this)
    // For now, we assume the main process
    await resizePty(session.sandboxId, "main", data.cols, data.rows)

    return { success: true }
  })

// Session idle hook (called by Claude Code Stop hook)
export const sessionIdle = createServerFn({ method: "POST" })
  .validator(
    z.object({
      sessionId: z.string(),
      stopHookActive: z.boolean().optional(),
    })
  )
  .handler(async ({ data }) => {
    const session = getSession(data.sessionId)
    if (!session) {
      return { success: false }
    }

    // Start idle timer
    startIdleTimer(data.sessionId)

    return { success: true }
  })

// Session ended hook (called by Claude Code SessionEnd hook)
export const sessionEnded = createServerFn({ method: "POST" })
  .validator(
    z.object({
      sessionId: z.string(),
      reason: z.string().optional(),
    })
  )
  .handler(async ({ data }) => {
    const session = getSession(data.sessionId)
    if (!session) {
      return { success: false }
    }

    // Terminate immediately
    if (session.sandboxId) {
      await terminateSandbox(session.sandboxId)
    }

    updateSessionState(data.sessionId, "stopped", null)
    clearIdleTimer(data.sessionId)

    return { success: true }
  })

// Session started hook (called by Claude Code SessionStart hook)
export const sessionStarted = createServerFn({ method: "POST" })
  .validator(z.object({ sessionId: z.string() }))
  .handler(async ({ data }) => {
    const session = getSession(data.sessionId)
    if (!session) {
      return { success: false }
    }

    // Ensure we're in running state
    if (session.state !== "running") {
      updateSessionState(data.sessionId, "running")
    }

    return { success: true }
  })

// Spawn a sub-instance
export const spawnSubInstance = createServerFn({ method: "POST" })
  .validator(SpawnRequestSchema)
  .handler(async ({ data }) => {
    const parentSession = getSession(data.parentSessionId)
    if (!parentSession) {
      throw new Error("Parent session not found")
    }

    const env = getEnvConfig()

    // Parse repo
    const [repoOwner, repoName] = data.repo.split("/")

    // Create sub-session
    const subSession = createSubSession(data.parentSessionId, {
      repoOwner,
      repoName,
      branch: data.branch,
      name: `Task: ${data.task.slice(0, 50)}`,
    })

    // Ensure durable streams exist
    await ensureSessionStreams(subSession.id, env.durableStreamsUrl)

    // Create Modal sandbox with the task as initial prompt
    const initialPrompt = data.context
      ? `${data.task}\n\nContext:\n${data.context}`
      : data.task

    try {
      const sandbox = await createSandbox({
        sessionId: subSession.id,
        repoOwner,
        repoName,
        branch: data.branch,
        anthropicApiKey: env.anthropicApiKey,
        githubToken: env.githubToken,
        apiUrl: env.durableStreamsUrl.replace("/v1/stream", ""),
        apiToken: generateSessionToken(subSession.id),
        initialPrompt,
      })

      updateSessionState(subSession.id, "running", sandbox.id)
    } catch (err) {
      updateSessionState(subSession.id, "stopped", null)
      throw err
    }

    return {
      sessionId: subSession.id,
      branch: data.branch,
    }
  })

// Create direct access session
export const createDirectAccess = createServerFn({ method: "POST" })
  .validator(z.object({ sessionId: z.string() }))
  .handler(async ({ data }) => {
    const session = getSession(data.sessionId)
    if (!session || !session.sandboxId) {
      throw new Error("Session not running")
    }

    const env = getEnvConfig()

    // Create a new direct access session ID
    const directSessionId = `${data.sessionId}-direct-${Date.now()}`

    // Ensure streams for direct access
    await ensureSessionStreams(directSessionId, env.durableStreamsUrl)

    const streams = getSessionStreams(directSessionId)

    return {
      directSessionId,
      inputStream: `${env.durableStreamsUrl}/${streams.input}`,
      outputStream: `${env.durableStreamsUrl}/${streams.output}`,
    }
  })
