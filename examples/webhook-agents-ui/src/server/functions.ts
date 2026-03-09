/**
 * Server functions for task management using @durable-streams/client.
 */

import { DurableStream } from "@durable-streams/client"
import { taskStateSchema } from "../lib/schema"
import {
  ensureServer,
  getAllTasks,
  getDSServerUrl,
  registerTask,
} from "./setup"

/**
 * Create a new task: creates the stream, appends an "assigned" event,
 * and registers it in the task registry.
 */
export async function createTask(selfBaseUrl: string, description: string) {
  await ensureServer(selfBaseUrl)
  const baseUrl = getDSServerUrl()
  const taskId = `task-${Date.now().toString(36)}`
  const path = `/agents/${taskId}`

  const handle = await DurableStream.create({
    url: `${baseUrl}${path}`,
    contentType: `application/json`,
  })

  await handle.append(
    JSON.stringify(
      taskStateSchema.events.insert({
        value: {
          id: `${taskId}-assigned`,
          type: `assigned`,
          task: description,
          timestamp: Date.now(),
        },
      })
    )
  )

  registerTask(taskId, path, description)
  console.log(`[functions] Created task ${taskId}: "${description}"`)

  return { taskId, path }
}

/**
 * Send a follow-up to an existing task stream, triggering a re-wake.
 */
export async function addFollowUp(
  selfBaseUrl: string,
  path: string,
  description: string
) {
  await ensureServer(selfBaseUrl)
  const baseUrl = getDSServerUrl()
  const taskId = path.split(`/`).pop()!

  const handle = new DurableStream({
    url: `${baseUrl}${path}`,
    contentType: `application/json`,
  })

  await handle.append(
    JSON.stringify(
      taskStateSchema.events.insert({
        value: {
          id: `${taskId}-followup-${Date.now().toString(36)}`,
          type: `follow_up`,
          task: description,
          timestamp: Date.now(),
        },
      })
    )
  )

  console.log(`[functions] Follow-up on ${taskId}: "${description}"`)
}

/**
 * Get the DS server base URL for browser-side stream reads.
 */
export async function getServerUrl(selfBaseUrl: string) {
  await ensureServer(selfBaseUrl)
  return getDSServerUrl()
}

/**
 * Get all registered tasks.
 */
export async function getTasks(selfBaseUrl: string) {
  await ensureServer(selfBaseUrl)
  return getAllTasks()
}
