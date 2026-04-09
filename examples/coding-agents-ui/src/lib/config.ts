import { resolve } from "node:path"

function withProtocol(url: string): string {
  return url.includes(`://`) ? url : `http://${url}`
}

function authHeader(token?: string): Record<string, string> | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

export const DURABLE_STREAMS_BASE_URL = withProtocol(
  process.env.DURABLE_STREAMS_URL ?? `http://localhost:4437`
)

export const DEFAULT_AGENT_CWD =
  process.env.CODING_AGENTS_DEFAULT_CWD ?? resolve(process.cwd(), `../..`)

export const DURABLE_STREAMS_READ_HEADERS =
  authHeader(
    process.env.DURABLE_STREAMS_READ_BEARER_TOKEN ??
      process.env.DURABLE_STREAMS_WRITE_BEARER_TOKEN
  ) ?? {}

export const DURABLE_STREAMS_WRITE_HEADERS =
  authHeader(process.env.DURABLE_STREAMS_WRITE_BEARER_TOKEN) ?? {}

export function buildUpstreamStreamUrl(id: string): string {
  return new URL(
    `v1/stream/coding-agents-ui/${encodeURIComponent(id)}`,
    `${DURABLE_STREAMS_BASE_URL.replace(/\/+$/, ``)}/`
  ).toString()
}
