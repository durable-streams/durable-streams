import { createFileRoute } from "@tanstack/react-router"
import {
  DURABLE_STREAMS_READ_HEADERS,
  DURABLE_STREAMS_WRITE_HEADERS,
} from "~/lib/config"
import { getSessionRecord } from "~/lib/session-store"

function copyResponseHeaders(response: Response): Headers {
  const headers = new Headers()
  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (lowerKey === `connection` || lowerKey === `transfer-encoding`) {
      continue
    }
    headers.set(key, value)
  }
  headers.set(`Cache-Control`, `no-store`)
  return headers
}

function copyRequestHeaders(
  request: Request,
  extra: Record<string, string>
): Headers {
  const headers = new Headers()
  const contentType = request.headers.get(`content-type`)
  const accept = request.headers.get(`accept`)

  if (contentType) {
    headers.set(`Content-Type`, contentType)
  }

  if (accept) {
    headers.set(`Accept`, accept)
  }

  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value)
  }

  return headers
}

async function getUpstreamUrl(
  id: string,
  requestUrl: string
): Promise<URL | null> {
  const record = await getSessionRecord(id)
  if (!record) {
    return null
  }

  const upstreamUrl = new URL(record.upstreamStreamUrl)
  const incomingUrl = new URL(requestUrl)

  for (const [key, value] of incomingUrl.searchParams.entries()) {
    upstreamUrl.searchParams.append(key, value)
  }

  return upstreamUrl
}

export const Route = createFileRoute(`/api/stream/$id`)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const upstreamUrl = await getUpstreamUrl(params.id, request.url)
        if (!upstreamUrl) {
          return new Response(`unknown session`, { status: 404 })
        }

        const upstreamResponse = await fetch(upstreamUrl, {
          method: `GET`,
          headers: copyRequestHeaders(request, DURABLE_STREAMS_READ_HEADERS),
        })

        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: copyResponseHeaders(upstreamResponse),
        })
      },

      POST: async ({ request, params }) => {
        const upstreamUrl = await getUpstreamUrl(params.id, request.url)
        if (!upstreamUrl) {
          return new Response(`unknown session`, { status: 404 })
        }

        const upstreamResponse = await fetch(upstreamUrl, {
          method: `POST`,
          headers: copyRequestHeaders(request, DURABLE_STREAMS_WRITE_HEADERS),
          body: await request.arrayBuffer(),
        })

        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: copyResponseHeaders(upstreamResponse),
        })
      },

      HEAD: async ({ request, params }) => {
        const upstreamUrl = await getUpstreamUrl(params.id, request.url)
        if (!upstreamUrl) {
          return new Response(`unknown session`, { status: 404 })
        }

        const upstreamResponse = await fetch(upstreamUrl, {
          method: `HEAD`,
          headers: copyRequestHeaders(request, DURABLE_STREAMS_READ_HEADERS),
        })

        return new Response(null, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: copyResponseHeaders(upstreamResponse),
        })
      },
    },
  },
})
