/**
 * DS server singleton + webhook subscription.
 * Uses detect-port to find an available port for the DS server,
 * and discovers our own URL from the first incoming request so the
 * webhook subscription points back to the correct address.
 *
 * State lives on globalThis so Vite HMR module reloads don't lose it.
 */

import "./tracing"
import { DurableStreamTestServer } from "@durable-streams/server"
import detectPort from "detect-port"

console.log(`hi`)

const g = globalThis as any
g.__dsState ??= {
  server: null as DurableStreamTestServer | null,
  serverUrl: null as string | null,
  webhookSecret: ``,
  tasks: new Map<string, { id: string; path: string; description: string }>(),
  setupPromise: null as Promise<void> | null,
}

/**
 * Lazily starts the DS server and registers the webhook subscription.
 * @param selfBaseUrl — our own origin (e.g. "http://localhost:5173"),
 *   extracted from the first incoming request so we don't hardcode the port.
 */
export async function ensureServer(selfBaseUrl: string): Promise<void> {
  if (g.__dsState.setupPromise) {
    await g.__dsState.setupPromise
    return
  }

  g.__dsState.setupPromise = (async () => {
    const dsPort = await detectPort(4438)
    g.__dsState.server = new DurableStreamTestServer({
      port: dsPort,
      longPollTimeout: 500,
      webhooks: true,
    })
    g.__dsState.serverUrl = await g.__dsState.server.start()
    console.log(`[setup] DS server started on ${g.__dsState.serverUrl}`)

    const webhookUrl = `${selfBaseUrl}/api/webhook/agents`
    const subRes = await fetch(
      `${g.__dsState.serverUrl}/agents/*?subscription=agent-runner`,
      {
        method: `PUT`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({
          webhook: webhookUrl,
          description: `Webhook agents UI runner`,
        }),
      }
    )
    const subData = (await subRes.json()) as { webhook_secret?: string }
    g.__dsState.webhookSecret = subData.webhook_secret ?? ``
    console.log(`[setup] Subscription created → ${webhookUrl}`)
  })()

  await g.__dsState.setupPromise
}

export function getWebhookSecret(): string {
  return g.__dsState.webhookSecret
}

export function getDSServerUrl(): string {
  if (!g.__dsState.serverUrl) throw new Error(`DS server not started yet`)
  return g.__dsState.serverUrl
}

export function registerTask(id: string, path: string, description: string) {
  g.__dsState.tasks.set(id, { id, path, description })
}

export function getAllTasks() {
  return Array.from(g.__dsState.tasks.values())
}
