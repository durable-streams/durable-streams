import {
  DurableStream,
  IdempotentProducer,
  stream,
} from "@durable-streams/client"
import {
  ensureDurableChatSessionStream,
  materializeSnapshotFromDurableStream,
} from "@durable-streams/tanstack-ai-transport"
import {
  DURABLE_STREAMS_READ_HEADERS,
  DURABLE_STREAMS_WRITE_HEADERS,
  buildChatStreamPath,
  buildReadStreamUrl,
  buildWriteStreamUrl,
} from "~/lib/durable-streams-config"
import {
  FORK_POINT_MARKER_NAME,
  forkPointCustomChunkHandler,
} from "~/lib/fork-points"

export async function createRootChatSession(): Promise<{
  id: string
  streamPath: string
}> {
  const id = crypto.randomUUID().slice(0, 8)
  const streamPath = buildChatStreamPath(id)
  await ensureDurableChatSessionStream({
    writeUrl: buildWriteStreamUrl(streamPath),
    headers: DURABLE_STREAMS_WRITE_HEADERS,
  })
  return { id, streamPath }
}

export async function loadChatSession(chatId: string) {
  const streamPath = buildChatStreamPath(chatId)

  try {
    await ensureDurableChatSessionStream({
      writeUrl: buildWriteStreamUrl(streamPath),
      headers: DURABLE_STREAMS_WRITE_HEADERS,
    })
  } catch {
    // Stream may already exist as a fork with different config — that's fine.
  }

  try {
    const snapshot = await materializeSnapshotFromDurableStream({
      readUrl: buildReadStreamUrl(streamPath),
      headers: DURABLE_STREAMS_READ_HEADERS,
      onCustomChunk: forkPointCustomChunkHandler,
    })
    return {
      messages: snapshot.messages,
      resumeOffset: snapshot.offset,
    }
  } catch (error) {
    console.warn(
      `Failed to materialize durable snapshot for chat`,
      chatId,
      error
    )
    return {
      messages: [],
      resumeOffset: undefined,
    }
  }
}

function mergeHeaders(
  headers?: Record<string, string> | { Authorization: string }
): Record<string, string> {
  if (!headers) return {}
  return { ...headers }
}

export async function createFork(opts: {
  sourceChatId: string
  sourceMessageId: string
  forkOffset: string
}): Promise<{
  id: string
  title: string
  createdAt: string
  parentId: string
  forkedFromMessageId: string
  forkOffset: string
  sourceStreamPath: string
  depth: number
}> {
  const { sourceChatId, sourceMessageId, forkOffset } = opts
  const sourceStreamPath = buildChatStreamPath(sourceChatId)
  const sourceReadUrl = buildReadStreamUrl(sourceStreamPath)

  const readHeaders = mergeHeaders(DURABLE_STREAMS_READ_HEADERS)

  const sourceStream = await stream({
    url: sourceReadUrl,
    json: true,
    live: false,
    headers: readHeaders,
  })
  const allChunks = await sourceStream.json()

  const markerName = FORK_POINT_MARKER_NAME
  const markers: Array<{
    messageId: string
    endOffset: string
    inherited?: boolean
    sourceStreamPath?: string
  }> = []

  let foundTarget = false
  for (const chunk of allChunks) {
    if (
      chunk &&
      typeof chunk === `object` &&
      (chunk as any).type === `CUSTOM` &&
      (chunk as any).name === markerName
    ) {
      const v = (chunk as any).value
      if (
        v &&
        typeof v.messageId === `string` &&
        typeof v.endOffset === `string`
      ) {
        markers.push({
          messageId: v.messageId,
          endOffset: v.endOffset,
          inherited: v.inherited,
          sourceStreamPath: v.sourceStreamPath,
        })
        if (v.messageId === sourceMessageId && v.endOffset === forkOffset) {
          foundTarget = true
        }
      }
    }
  }

  if (!foundTarget) {
    throw new ForkValidationError(
      `Fork point not found: message ${sourceMessageId} at offset ${forkOffset}`
    )
  }

  const inheritedMarkers = markers.filter((m) => {
    const offsetNum = parseOffsetForComparison(m.endOffset)
    const forkNum = parseOffsetForComparison(forkOffset)
    return offsetNum <= forkNum
  })

  const childId = crypto.randomUUID().slice(0, 8)
  const childStreamPath = buildChatStreamPath(childId)
  const childWriteUrl = buildWriteStreamUrl(childStreamPath)
  const writeHeaders = mergeHeaders(DURABLE_STREAMS_WRITE_HEADERS)

  const childStream = new DurableStream({
    url: childWriteUrl,
    headers: {
      ...writeHeaders,
      "Stream-Forked-From": `/${sourceStreamPath}`,
      "Stream-Fork-Offset": forkOffset,
    },
    contentType: `application/json`,
  })
  await childStream.create({
    contentType: `application/json`,
  })

  if (inheritedMarkers.length > 0) {
    const producerId = `fork-replay-${childId}`
    const producer = new IdempotentProducer(childStream, producerId, {
      autoClaim: true,
      lingerMs: 0,
      maxInFlight: 1,
    })

    for (const marker of inheritedMarkers) {
      const replayedMarker = {
        type: `CUSTOM`,
        timestamp: Date.now(),
        name: markerName,
        value: {
          version: 1,
          messageId: marker.messageId,
          endOffset: marker.endOffset,
          inherited: true,
          sourceStreamPath: marker.sourceStreamPath ?? sourceStreamPath,
        },
      }
      producer.append(JSON.stringify(replayedMarker))
    }

    await producer.detach()
  }

  const now = new Date().toISOString()
  return {
    id: childId,
    title: `Fork of chat`,
    createdAt: now,
    parentId: sourceChatId,
    forkedFromMessageId: sourceMessageId,
    forkOffset,
    sourceStreamPath: childStreamPath,
    depth: 0,
  }
}

function parseOffsetForComparison(offset: string): number {
  const parts = offset.split(`_`)
  if (parts.length >= 2) {
    return parseInt(parts[1], 10)
  }
  return parseInt(offset, 10) || 0
}

export class ForkValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = `ForkValidationError`
  }
}
