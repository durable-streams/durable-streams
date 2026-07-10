import { env } from "cloudflare:workers"
import { createStreamsHandler } from "@durable-streams/server-cloudflare"

function withProtocol(url: string): string {
  return url.includes(`://`) ? url : `http://${url}`
}

function authHeader(token?: string): { Authorization: string } | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

/**
 * By default, server-side stream calls never leave this Worker: the
 * StreamObject binding lives here (src/server.ts), so requests go straight
 * to an in-process streams handler — no HTTP hop, and no "Worker cannot
 * fetch its own hostname" restriction when deployed. The host part of the
 * internal URL is a placeholder; only the path (the stream name) matters.
 *
 * Set DURABLE_STREAMS_URL (or the WRITE/READ variants) to point at a
 * separately deployed streams server over real HTTP instead.
 */
const INTERNAL_BASE_URL = `http://streams.internal/streams`

const EXTERNAL_SHARED_URL =
  process.env.DURABLE_STREAMS_URL ??
  process.env.DURABLE_STREAMS_WRITE_URL ??
  process.env.DURABLE_STREAMS_READ_URL

const SHARED_URL = process.env.DURABLE_STREAMS_URL ?? INTERNAL_BASE_URL
const DURABLE_STREAMS_WRITE_URL = withProtocol(
  process.env.DURABLE_STREAMS_WRITE_URL ?? SHARED_URL
)
const DURABLE_STREAMS_READ_URL = withProtocol(
  process.env.DURABLE_STREAMS_READ_URL ?? SHARED_URL
)

const internalStreams = createStreamsHandler({
  // Internal calls originate from our own server routes — no bearer check.
  auth: () => undefined,
  cors: false,
})

/** Fetch for server-side stream calls: in-process by default, HTTP when external. */
export const streamsFetch: typeof fetch = EXTERNAL_SHARED_URL
  ? (input, init) => globalThis.fetch(input, init)
  : async (input, init) =>
      internalStreams(new Request(input, init), env as never)

export const DURABLE_STREAMS_WRITE_HEADERS = authHeader(
  process.env.DURABLE_STREAMS_WRITE_BEARER_TOKEN
)

export const DURABLE_STREAMS_READ_HEADERS =
  authHeader(process.env.DURABLE_STREAMS_READ_BEARER_TOKEN) ??
  authHeader(process.env.DURABLE_STREAMS_WRITE_BEARER_TOKEN)

function buildStreamUrl(baseUrl: string, streamPath: string): string {
  return new URL(
    streamPath.replace(/^\/+/, ``),
    `${baseUrl.replace(/\/+$/, ``)}/`
  ).toString()
}

/** Builds the write endpoint for a durable stream path. */
export function buildWriteStreamUrl(streamPath: string): string {
  return buildStreamUrl(DURABLE_STREAMS_WRITE_URL, streamPath)
}

/** Builds the read endpoint for a durable stream path. */
export function buildReadStreamUrl(streamPath: string): string {
  return buildStreamUrl(DURABLE_STREAMS_READ_URL, streamPath)
}

/** Canonical stream path convention for chat sessions. */
export function buildChatStreamPath(chatId: string): string {
  return `chat/${chatId}`
}
