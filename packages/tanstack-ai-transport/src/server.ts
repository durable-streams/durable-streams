import {
  DurableStream,
  DurableStreamError,
  IdempotentProducer,
} from "@durable-streams/client"
import { sanitizeChunkForStorage } from "./client"
import { DEFAULT_FORK_POINT_MARKER_NAME } from "./types"
import type { HeadersRecord } from "@durable-streams/client"
import type {
  DurableMessageOffsetMarker,
  DurableStreamTarget,
  ForkPointOptions,
  TanStackChunk,
  ToDurableChatSessionResponseOptions,
  ToDurableStreamResponseOptions,
} from "./types"

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
  } catch (error: unknown) {
    const status =
      error instanceof DurableStreamError
        ? error.status
        : error != null &&
            typeof error === `object` &&
            `status` in error &&
            typeof (error as { status: unknown }).status === `number`
          ? (error as { status: number }).status
          : undefined
    if (status === 409) {
      return
    }
    throw error
  }
}

async function ensureDurableStreamWithContentType(
  streamTarget: DurableStreamTarget,
  contentType: string
): Promise<DurableStream> {
  const writeUrl = resolveUrl(streamTarget.writeUrl)
  const headers = await resolveHeaders(streamTarget.headers)
  const createIfMissing = streamTarget.createIfMissing ?? true

  const stream = new DurableStream({
    url: writeUrl,
    headers,
    contentType,
  })
  await ensureStreamExists(stream, contentType, createIfMissing)
  return stream
}

export async function ensureDurableChatSessionStream(
  streamTarget: DurableStreamTarget
): Promise<DurableStream> {
  const configuredContentType = streamTarget.contentType
  if (
    configuredContentType !== undefined &&
    configuredContentType !== DEFAULT_CONTENT_TYPE
  ) {
    throw new Error(
      `Chat session streams must use content type "${DEFAULT_CONTENT_TYPE}"`
    )
  }

  return ensureDurableStreamWithContentType(streamTarget, DEFAULT_CONTENT_TYPE)
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
    // Always close so readers can terminate loading state.
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

function messageText(message: {
  parts?: Array<{ type?: string; content?: string; text?: string }>
}): string {
  if (!Array.isArray(message.parts)) return ``
  return message.parts
    .filter((part) => part.type === `text`)
    .map((part) =>
      typeof part.content === `string`
        ? part.content
        : typeof part.text === `string`
          ? part.text
          : ``
    )
    .join(``)
}

function normalizeRole(
  role: string | undefined
): `user` | `assistant` | `system` | `tool` {
  if (role === `assistant` || role === `system` || role === `tool`) return role
  return `user`
}

export function toMessageEchoChunks(message: {
  id?: string
  role?: string
  parts?: Array<{ type?: string; content?: string; text?: string }>
}): Array<TanStackChunk> {
  const messageId =
    typeof message.id === `string` && message.id.length > 0
      ? message.id
      : crypto.randomUUID()
  const role = normalizeRole(message.role)
  const text = messageText(message)
  const timestamp = Date.now()
  return [
    {
      type: `TEXT_MESSAGE_START`,
      messageId,
      role,
      model: `client`,
      timestamp,
    },
    ...(text.length > 0
      ? [
          {
            type: `TEXT_MESSAGE_CONTENT`,
            messageId,
            delta: text,
            model: `client`,
            timestamp,
          },
        ]
      : []),
    {
      type: `TEXT_MESSAGE_END`,
      messageId,
      model: `client`,
      timestamp,
    },
  ]
}

export async function appendSanitizedChunksToStream(
  stream: DurableStream,
  chunks: ReadonlyArray<TanStackChunk>,
  contentType: string = DEFAULT_CONTENT_TYPE
): Promise<void> {
  for (const chunk of chunks) {
    await stream.append(JSON.stringify(sanitizeChunkForStorage(chunk)), {
      contentType,
    })
  }
}

export async function pipeSanitizedChunksToStream(
  source: AsyncIterable<TanStackChunk>,
  stream: DurableStream,
  contentType: string = DEFAULT_CONTENT_TYPE
): Promise<void> {
  for await (const chunk of source) {
    await stream.append(JSON.stringify(sanitizeChunkForStorage(chunk)), {
      contentType,
    })
  }
}

export async function toDurableStreamResponse(
  source: AsyncIterable<unknown>,
  options: ToDurableStreamResponseOptions
): Promise<Response> {
  const mode = options.mode ?? `immediate`
  const contentType = options.stream.contentType ?? DEFAULT_CONTENT_TYPE
  const readUrl = resolveUrl(options.stream.readUrl ?? options.stream.writeUrl)
  const stream = await ensureDurableStreamWithContentType(
    options.stream,
    contentType
  )
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
  // Use waitUntil when available so worker runtimes keep writing after response.
  // Without it, we still return immediately and best-effort continue in background.
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

function resolveForkPointOptions(opts?: ForkPointOptions): {
  enabled: boolean
  markerName: string
} {
  if (opts === true)
    return { enabled: true, markerName: DEFAULT_FORK_POINT_MARKER_NAME }
  if (opts === false || opts === undefined)
    return { enabled: false, markerName: DEFAULT_FORK_POINT_MARKER_NAME }
  return {
    enabled: opts.enabled !== false,
    markerName: opts.markerName ?? DEFAULT_FORK_POINT_MARKER_NAME,
  }
}

function createForkPointMarker(
  messageId: string,
  endOffset: string,
  markerName: string,
  inherited?: boolean,
  sourceStreamPath?: string
): DurableMessageOffsetMarker {
  return {
    type: `CUSTOM`,
    timestamp: Date.now(),
    name: markerName,
    value: {
      version: 1,
      messageId,
      endOffset,
      ...(inherited ? { inherited: true } : {}),
      ...(sourceStreamPath ? { sourceStreamPath } : {}),
    },
  }
}

async function writeChatSessionWithForkPoints(
  stream: DurableStream,
  newMessages: Array<{
    id?: string
    role?: string
    parts?: Array<{ type?: string; content?: string; text?: string }>
  }>,
  responseStream: AsyncIterable<TanStackChunk>,
  markerName: string
): Promise<void> {
  const producerId = `fork-writer-${crypto.randomUUID()}`
  const producer = new IdempotentProducer(stream, producerId, {
    autoClaim: true,
    lingerMs: 0,
    maxInFlight: 1,
  })

  try {
    for (const message of newMessages) {
      const chunks = toMessageEchoChunks(message)
      const messageId = chunks.find(
        (c) => c.type === `TEXT_MESSAGE_START`
      )?.messageId

      for (const chunk of chunks) {
        producer.append(JSON.stringify(sanitizeChunkForStorage(chunk)))
      }

      if (messageId) {
        const result = await producer.flush()
        const marker = createForkPointMarker(
          messageId,
          result.offset,
          markerName
        )
        producer.append(JSON.stringify(marker))
        await producer.flush()
      }
    }

    let currentAssistantMessageId: string | null = null
    for await (const chunk of responseStream) {
      producer.append(JSON.stringify(sanitizeChunkForStorage(chunk)))

      if (
        chunk &&
        typeof chunk === `object` &&
        chunk.type === `TEXT_MESSAGE_START`
      ) {
        currentAssistantMessageId =
          typeof chunk.messageId === `string` ? chunk.messageId : null
      }

      if (
        chunk &&
        typeof chunk === `object` &&
        chunk.type === `TEXT_MESSAGE_END` &&
        currentAssistantMessageId
      ) {
        const result = await producer.flush()
        const marker = createForkPointMarker(
          currentAssistantMessageId,
          result.offset,
          markerName
        )
        producer.append(JSON.stringify(marker))
        await producer.flush()
        currentAssistantMessageId = null
      }
    }
  } finally {
    await producer.detach()
  }
}

export async function toDurableChatSessionResponse(
  options: ToDurableChatSessionResponseOptions
): Promise<Response> {
  const mode = options.mode ?? `immediate`
  const contentType = DEFAULT_CONTENT_TYPE
  const stream = await ensureDurableChatSessionStream(options.stream)

  const forkOpts = resolveForkPointOptions(options.includeForkPoints)

  let writeTask: Promise<void>

  if (forkOpts.enabled) {
    writeTask = writeChatSessionWithForkPoints(
      stream,
      options.newMessages,
      options.responseStream,
      forkOpts.markerName
    )
  } else {
    const newMessageChunks = options.newMessages.flatMap((message) =>
      toMessageEchoChunks(message)
    )
    await appendSanitizedChunksToStream(stream, newMessageChunks, contentType)
    writeTask = pipeSanitizedChunksToStream(
      options.responseStream,
      stream,
      contentType
    )
  }

  if (mode === `await`) {
    await writeTask
    return new Response(null, {
      status: 200,
      headers: { "Cache-Control": `no-store` },
    })
  }

  const backgroundTask = writeTask.catch((error) => {
    console.error(`Durable chat session write failed`, error)
  })
  options.waitUntil?.(backgroundTask)

  return new Response(null, {
    status: 202,
    headers: { "Cache-Control": `no-store` },
  })
}
