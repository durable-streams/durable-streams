import {
  DURABLE_STREAMS_READ_HEADERS,
  buildReadStreamUrl,
  parseRequestUrl,
} from "../../utils"

function normalizeStreamPath(path: string | null): string | null {
  if (!path) return null
  const trimmed = path.trim()
  if (!trimmed) return null
  if (trimmed.includes(`://`)) return null
  if (trimmed.includes(`..`)) return null
  return trimmed.startsWith(`/`) ? trimmed.slice(1) : trimmed
}

function copyHeaders(response: Response): Headers {
  const headers = new Headers()
  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (lowerKey === `connection` || lowerKey === `transfer-encoding`) continue
    headers.set(key, value)
  }
  headers.set(`Cache-Control`, `no-store`)
  return headers
}

export async function GET(request: Request) {
  const incomingUrl = parseRequestUrl(request)
  const streamPath = normalizeStreamPath(incomingUrl.searchParams.get(`path`))
  if (!streamPath) {
    return Response.json(
      { error: `Missing or invalid stream path` },
      { status: 400 }
    )
  }

  const upstreamUrl = new URL(buildReadStreamUrl(streamPath))

  for (const [key, value] of incomingUrl.searchParams.entries()) {
    if (key === `path`) continue
    upstreamUrl.searchParams.append(key, value)
  }

  const accept = request.headers.get(`accept`)
  const upstreamResponse = await fetch(upstreamUrl, {
    method: `GET`,
    headers: {
      ...(accept ? { Accept: accept } : {}),
      ...(DURABLE_STREAMS_READ_HEADERS ?? {}),
    },
  })

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: copyHeaders(upstreamResponse),
  })
}
