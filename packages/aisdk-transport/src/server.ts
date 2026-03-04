import { DurableStream, DurableStreamError } from "@durable-streams/client"
import type { HeadersRecord } from "@durable-streams/client"
import type { ToDurableStreamResponseOptions } from "./types"

const DEFAULT_CONTENT_TYPE = `application/json`

function resolveUrl(url: string | URL): string {
  return url instanceof URL ? url.toString() : url
}

async function resolveHeaders(
  headers: HeadersRecord | undefined
): Promise<Record<string, string>> {
  if (!headers) return {}
  const entries = await Promise.all(
    Object.entries(headers).map(async ([key, value]) => {
      const resolved = typeof value === `function` ? await value() : value
      return [key, resolved] as const
    })
  )
  return Object.fromEntries(entries)
}

async function ensureStreamExists(
  stream: DurableStream,
  contentType: string,
  createIfMissing: boolean
): Promise<void> {
  if (!createIfMissing) return

  try {
    await stream.create({ contentType })
  } catch (error) {
    if (
      error instanceof DurableStreamError &&
      error.status === 409 &&
      (error.code === `CONFLICT_EXISTS` || error.code === `CONFLICT_SEQ`)
    ) {
      return
    }
    throw error
  }
}

async function writeSourceToStream(
  source: AsyncIterable<unknown>,
  stream: DurableStream,
  contentType: string
): Promise<string> {
  let finalOffset = ``
  let sourceError: unknown = undefined
  try {
    for await (const chunk of source) {
      await stream.append(JSON.stringify(chunk), { contentType })
    }
  } catch (error) {
    sourceError = error
  } finally {
    try {
      const closeResult = await stream.close()
      finalOffset = closeResult.finalOffset
    } catch (error) {
      if (
        !(
          error instanceof DurableStreamError && error.code === `STREAM_CLOSED`
        ) &&
        sourceError === undefined
      ) {
        sourceError = error
      }
    }
  }

  if (sourceError !== undefined) {
    throw sourceError
  }
  return finalOffset
}

export async function toDurableStreamResponse(
  source: AsyncIterable<unknown>,
  options: ToDurableStreamResponseOptions
): Promise<Response> {
  const mode = options.mode ?? `immediate`
  const contentType = options.stream.contentType ?? DEFAULT_CONTENT_TYPE
  const writeUrl = resolveUrl(options.stream.writeUrl)
  const readUrl = resolveUrl(options.stream.readUrl ?? options.stream.writeUrl)
  const headers = await resolveHeaders(options.stream.headers)
  const createIfMissing = options.stream.createIfMissing ?? true

  const stream = new DurableStream({
    url: writeUrl,
    headers,
    contentType,
  })

  await ensureStreamExists(stream, contentType, createIfMissing)
  const writer = writeSourceToStream(source, stream, contentType)

  if (mode === `await`) {
    const finalOffset = await writer
    return Response.json(
      { streamUrl: readUrl, finalOffset },
      { status: 200, headers: { Location: readUrl } }
    )
  }

  const backgroundTask = writer.catch((error) => {
    console.error(`Durable stream write failed`, error)
  })
  options.waitUntil?.(backgroundTask)

  const responseHeaders = new Headers({
    Location: readUrl,
    "Cache-Control": `no-store`,
  })

  if (options.exposeLocationHeader !== false) {
    responseHeaders.set(`Access-Control-Expose-Headers`, `Location`)
  }

  return Response.json(
    { streamUrl: readUrl },
    { status: 201, headers: responseHeaders }
  )
}
