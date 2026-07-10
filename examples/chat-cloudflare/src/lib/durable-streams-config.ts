import { env } from "cloudflare:workers"
import { createStreamsHandler } from "@durable-streams/server-cloudflare"

/**
 * Server-side stream calls never leave this Worker: the StreamObject
 * binding lives here (src/server.ts), so requests go straight to an
 * in-process streams handler — no HTTP hop, and no "Worker cannot fetch
 * its own hostname" restriction when deployed. The host part of the URL
 * is a placeholder; only the path (the stream name) matters.
 */
const INTERNAL_BASE_URL = `http://streams.internal/streams`

const streams = createStreamsHandler({
  // Internal calls originate from our own server routes — no auth hook.
  auth: () => undefined,
  cors: false,
})

/** Fetch for server-side stream calls — dispatches in-process. */
export const streamsFetch: typeof fetch = async (input, init) =>
  streams(new Request(input, init), env as never)

/** Builds the endpoint URL for a durable stream path. */
export function buildStreamUrl(streamPath: string): string {
  return new URL(
    streamPath.replace(/^\/+/, ``),
    `${INTERNAL_BASE_URL}/`
  ).toString()
}

/** Canonical stream path convention for chat sessions. */
export function buildChatStreamPath(chatId: string): string {
  return `chat/${chatId}`
}
