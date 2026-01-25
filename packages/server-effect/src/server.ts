/**
 * Effect-based HTTP server for Durable Streams.
 */
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerError,
} from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Stream, Either } from "effect"
import { createServer } from "node:http"

import { StreamStoreService, normalizeContentType } from "./StreamStore"
import { generateResponseCursor, DEFAULT_CURSOR_EPOCH, DEFAULT_CURSOR_INTERVAL_SECONDS } from "./Cursor"
import { Headers as ProtocolHeaders } from "./types"

/**
 * Parse an integer header value strictly.
 */
function parseStrictInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  if (value.length > 1 && value.startsWith("0")) return null
  const num = parseInt(value, 10)
  if (!Number.isFinite(num) || num < 0) return null
  return num
}

/**
 * Validate TTL header value.
 */
function validateTtl(value: string | undefined): { value?: number; error?: string } {
  if (!value) return {}
  const num = parseStrictInteger(value)
  if (num === null || num <= 0) {
    return { error: "Invalid TTL: must be a positive integer" }
  }
  return { value: num }
}

/**
 * Validate Expires-At header value.
 */
function validateExpiresAt(value: string | undefined): { value?: string; error?: string } {
  if (!value) return {}
  const date = new Date(value)
  if (isNaN(date.getTime())) {
    return { error: "Invalid Expires-At: must be a valid ISO 8601 timestamp" }
  }
  return { value }
}

/**
 * Validate offset format.
 */
function validateOffset(offset: string): boolean {
  // Must be "-1", "now", or match our offset format (digits_digits)
  const validOffsetPattern = /^(-1|now|\d+_\d+)$/
  return validOffsetPattern.test(offset)
}

/**
 * Generate ETag for a response.
 */
function generateETag(path: string, startOffset: string, endOffset: string): string {
  return `"${Buffer.from(path).toString("base64")}:${startOffset}:${endOffset}"`
}

/**
 * Encode data for SSE format.
 */
function encodeSSEData(payload: string): string {
  const lines = payload.split(/\r\n|\r|\n/)
  return lines.map((line) => `data:${line}`).join("\n") + "\n\n"
}

/**
 * Create a response with common headers.
 */
function createResponse(
  body: Uint8Array | string,
  options: {
    status?: number
    contentType?: string
    headers?: Record<string, string>
  } = {}
): HttpServerResponse.HttpServerResponse {
  const { status = 200, contentType, headers = {} } = options

  let response: HttpServerResponse.HttpServerResponse

  // Handle empty body
  if ((typeof body === "string" && body.length === 0) || (body instanceof Uint8Array && body.length === 0)) {
    response = HttpServerResponse.empty({ status })
  } else if (typeof body === "string") {
    // For non-empty strings, use raw to avoid default content-type
    response = HttpServerResponse.raw(new TextEncoder().encode(body), { status })
  } else {
    // For non-empty Uint8Array, use raw to avoid default content-type (application/octet-stream)
    response = HttpServerResponse.raw(body, { status })
  }

  if (contentType) {
    response = HttpServerResponse.setHeader(response, "content-type", contentType)
  }

  for (const [key, value] of Object.entries(headers)) {
    response = HttpServerResponse.setHeader(response, key, value)
  }

  response = HttpServerResponse.setHeader(response, "x-content-type-options", "nosniff")
  response = HttpServerResponse.setHeader(response, "cross-origin-resource-policy", "cross-origin")

  return response
}

/**
 * Add CORS headers to a response.
 */
function addCorsHeaders(
  response: HttpServerResponse.HttpServerResponse
): HttpServerResponse.HttpServerResponse {
  return response.pipe(
    HttpServerResponse.setHeader("access-control-allow-origin", "*"),
    HttpServerResponse.setHeader(
      "access-control-allow-methods",
      "GET, POST, PUT, DELETE, HEAD, OPTIONS"
    ),
    HttpServerResponse.setHeader(
      "access-control-allow-headers",
      "content-type, authorization, stream-seq, stream-ttl, stream-expires-at, producer-id, producer-epoch, producer-seq"
    ),
    HttpServerResponse.setHeader(
      "access-control-expose-headers",
      "stream-next-offset, stream-cursor, stream-up-to-date, producer-epoch, producer-seq, producer-expected-seq, producer-received-seq, etag, content-type"
    )
  )
}

/**
 * Get header value (case-insensitive).
 */
function getHeader(
  headers: HttpServerRequest.HttpServerRequest["headers"],
  name: string
): string | undefined {
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

const cursorOptions = {
  intervalSeconds: DEFAULT_CURSOR_INTERVAL_SECONDS,
  epoch: DEFAULT_CURSOR_EPOCH,
}

const longPollTimeout = 30000

/**
 * Build the main HTTP router.
 */
const makeRouter = (port: number, host: string) => Effect.gen(function* () {
  const store = yield* StreamStoreService

  /**
   * Handle OPTIONS - CORS preflight.
   */
  const handleOptions = Effect.succeed(
    addCorsHeaders(HttpServerResponse.empty({ status: 204 }))
  )

  /**
   * Handle PUT - Create stream.
   */
  const handleCreate = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, `http://${host}:${port}`)
    const path = url.pathname

    const contentType = getHeader(request.headers, "content-type")
    const ttlHeader = getHeader(request.headers, ProtocolHeaders.STREAM_TTL)
    const expiresAtHeader = getHeader(request.headers, ProtocolHeaders.STREAM_EXPIRES_AT)

    // Validate TTL and Expires-At cannot both be specified
    if (ttlHeader && expiresAtHeader) {
      return addCorsHeaders(createResponse("Cannot specify both Stream-TTL and Stream-Expires-At", { status: 400 }))
    }

    const ttlResult = validateTtl(ttlHeader)
    if (ttlResult.error) {
      return addCorsHeaders(createResponse(ttlResult.error, { status: 400 }))
    }

    const expiresResult = validateExpiresAt(expiresAtHeader)
    if (expiresResult.error) {
      return addCorsHeaders(createResponse(expiresResult.error, { status: 400 }))
    }

    const bodyArray = yield* request.arrayBuffer.pipe(
      Effect.map((buf) => new Uint8Array(buf))
    )

    const exists = yield* store.has(path)

    const result = yield* store
      .create(path, {
        contentType,
        ttlSeconds: ttlResult.value,
        expiresAt: expiresResult.value,
        initialData: bodyArray.length > 0 ? bodyArray : undefined,
      })
      .pipe(Effect.either)

    if (result._tag === "Left") {
      return addCorsHeaders(createResponse(result.left.message, { status: 409 }))
    }

    const stream = result.right
    const status = exists ? 200 : 201

    const responseHeaders: Record<string, string> = {
      [ProtocolHeaders.STREAM_NEXT_OFFSET]: stream.currentOffset,
    }

    // Add Location header for 201 Created responses
    if (!exists) {
      responseHeaders["location"] = `http://${host}:${port}${path}`
    }

    return addCorsHeaders(
      createResponse("", {
        status,
        contentType: stream.contentType || "application/octet-stream",
        headers: responseHeaders,
      })
    )
  })

  /**
   * Handle HEAD - Get metadata.
   */
  const handleHead = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.url, "http://localhost").pathname

    const result = yield* store.get(path).pipe(Effect.either)

    if (result._tag === "Left") {
      return addCorsHeaders(createResponse("Stream not found", { status: 404 }))
    }

    const stream = result.right
    return addCorsHeaders(
      HttpServerResponse.empty({ status: 200 }).pipe(
        HttpServerResponse.setHeader(ProtocolHeaders.STREAM_NEXT_OFFSET, stream.currentOffset),
        HttpServerResponse.setHeader("content-type", stream.contentType || "application/octet-stream"),
        HttpServerResponse.setHeader("cache-control", "no-store"),
        HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
        HttpServerResponse.setHeader("cross-origin-resource-policy", "cross-origin")
      )
    )
  })

  /**
   * Handle GET - Read stream.
   */
  const handleRead = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://localhost")
    const path = url.pathname

    const offsetParam = url.searchParams.get("offset")
    const liveMode = url.searchParams.get("live")
    const clientCursor = url.searchParams.get("cursor")

    // Validate offset parameter
    if (offsetParam !== null) {
      // Reject empty offset
      if (offsetParam === "") {
        return addCorsHeaders(createResponse("Empty offset parameter", { status: 400 }))
      }

      // Reject multiple offset parameters
      const allOffsets = url.searchParams.getAll("offset")
      if (allOffsets.length > 1) {
        return addCorsHeaders(createResponse("Multiple offset parameters not allowed", { status: 400 }))
      }

      // Validate offset format
      if (!validateOffset(offsetParam)) {
        return addCorsHeaders(createResponse("Invalid offset format", { status: 400 }))
      }
    }

    // Require offset parameter for long-poll and SSE per protocol spec
    if ((liveMode === "long-poll" || liveMode === "sse") && !offsetParam) {
      const modeName = liveMode === "sse" ? "SSE" : "Long-poll"
      return addCorsHeaders(createResponse(`${modeName} requires offset parameter`, { status: 400 }))
    }

    const streamResult = yield* store.get(path).pipe(Effect.either)

    if (streamResult._tag === "Left") {
      return addCorsHeaders(createResponse("Stream not found", { status: 404 }))
    }

    const stream = streamResult.right
    const streamContentType = stream.contentType || "application/octet-stream"

    // For offset=now, convert to actual tail offset
    const effectiveOffset = offsetParam === "now" ? stream.currentOffset : offsetParam

    let offset: string | undefined
    if (effectiveOffset && effectiveOffset !== "-1") {
      offset = effectiveOffset
    }

    // Handle SSE mode
    if (liveMode === "sse") {
      const contentType = normalizeContentType(stream.contentType)
      if (contentType !== "application/json" && !contentType.startsWith("text/")) {
        return addCorsHeaders(
          createResponse("SSE mode not supported for this content type", { status: 400 })
        )
      }

      let currentOffset = offset || stream.currentOffset
      const isJsonStream = contentType === "application/json"

      const sseStream = Stream.async<string, never>((emit) => {
        const run = async () => {
          try {
            while (true) {
              const readResult = await Effect.runPromise(store.read(path, currentOffset))

              for (const msg of readResult.messages) {
                // Format data based on content type
                let dataPayload: string
                if (isJsonStream) {
                  const jsonBytes = await Effect.runPromise(store.formatResponse(path, [msg]))
                  dataPayload = new TextDecoder().decode(jsonBytes)
                } else {
                  dataPayload = new TextDecoder().decode(msg.data)
                }
                await emit.single(`event: data\n${encodeSSEData(dataPayload)}`)
                currentOffset = msg.offset
              }

              // Compute offset the same way as HTTP GET: last message's offset, or stream's current offset
              const controlOffset = readResult.messages[readResult.messages.length - 1]?.offset ?? currentOffset

              const cursor = generateResponseCursor(clientCursor || undefined, cursorOptions)
              const control = JSON.stringify({
                streamNextOffset: controlOffset,
                streamCursor: cursor,
                upToDate: true,
              })
              await emit.single(`event: control\n${encodeSSEData(control)}`)
              currentOffset = controlOffset

              const waitResult = await Effect.runPromise(
                store.waitForMessages(path, currentOffset, longPollTimeout)
              )

              if (waitResult.timedOut) {
                const keepAliveCursor = generateResponseCursor(clientCursor || undefined, cursorOptions)
                const keepAlive = JSON.stringify({
                  streamNextOffset: currentOffset,
                  streamCursor: keepAliveCursor,
                  upToDate: true,
                })
                await emit.single(`event: control\n${encodeSSEData(keepAlive)}`)
              }
            }
          } catch {
            await emit.end()
          }
        }
        run()
      })

      return addCorsHeaders(
        HttpServerResponse.stream(sseStream.pipe(Stream.encodeText), { status: 200 }).pipe(
          HttpServerResponse.setHeader("content-type", "text/event-stream"),
          HttpServerResponse.setHeader("cache-control", "no-cache, no-store"),
          HttpServerResponse.setHeader("connection", "keep-alive"),
          HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
          HttpServerResponse.setHeader("cross-origin-resource-policy", "cross-origin")
        )
      )
    }

    // Handle catch-up mode offset=now: return empty response with tail offset
    // For long-poll mode, we fall through to wait for new data instead
    if (offsetParam === "now" && liveMode !== "long-poll") {
      const isJsonMode = normalizeContentType(stream.contentType) === "application/json"
      const responseBody = isJsonMode ? "[]" : ""

      return addCorsHeaders(
        createResponse(responseBody, {
          status: 200,
          contentType: streamContentType,
          headers: {
            [ProtocolHeaders.STREAM_NEXT_OFFSET]: stream.currentOffset,
            [ProtocolHeaders.STREAM_UP_TO_DATE]: "true",
            "cache-control": "no-store",
          },
        })
      )
    }

    // Read current messages
    const readResult = yield* store.read(path, offset)

    // Only wait in long-poll if:
    // 1. long-poll mode is enabled
    // 2. Client provided an offset (not first request) OR used offset=now
    // 3. Client's offset matches current offset (already caught up)
    // 4. No new messages
    const clientIsCaughtUp =
      (offset && offset === stream.currentOffset) ||
      offsetParam === "now"

    if (liveMode === "long-poll" && clientIsCaughtUp && readResult.messages.length === 0) {
      const waitResult = yield* store.waitForMessages(
        path,
        offset || stream.currentOffset,
        longPollTimeout
      )

      const cursor = generateResponseCursor(clientCursor || undefined, cursorOptions)

      if (waitResult.timedOut) {
        return addCorsHeaders(
          HttpServerResponse.empty({ status: 204 }).pipe(
            HttpServerResponse.setHeader(ProtocolHeaders.STREAM_NEXT_OFFSET, offset || stream.currentOffset),
            HttpServerResponse.setHeader(ProtocolHeaders.STREAM_UP_TO_DATE, "true"),
            HttpServerResponse.setHeader(ProtocolHeaders.STREAM_CURSOR, cursor),
            HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
            HttpServerResponse.setHeader("cross-origin-resource-policy", "cross-origin")
          )
        )
      }

      if (waitResult.messages.length > 0) {
        const body = yield* store.formatResponse(path, waitResult.messages)
        const lastOffset = waitResult.messages[waitResult.messages.length - 1]!.offset

        return addCorsHeaders(
          createResponse(body, {
            status: 200,
            contentType: streamContentType,
            headers: {
              [ProtocolHeaders.STREAM_NEXT_OFFSET]: lastOffset,
              [ProtocolHeaders.STREAM_UP_TO_DATE]: "true",
              [ProtocolHeaders.STREAM_CURSOR]: cursor,
            },
          })
        )
      }
    }

    // Long-poll with data already available - return immediately with cursor
    if (liveMode === "long-poll" && readResult.messages.length > 0) {
      const cursor = generateResponseCursor(clientCursor || undefined, cursorOptions)
      const body = yield* store.formatResponse(path, readResult.messages)
      const lastOffset = readResult.messages[readResult.messages.length - 1]!.offset

      return addCorsHeaders(
        createResponse(body, {
          status: 200,
          contentType: streamContentType,
          headers: {
            [ProtocolHeaders.STREAM_NEXT_OFFSET]: lastOffset,
            [ProtocolHeaders.STREAM_UP_TO_DATE]: "true",
            [ProtocolHeaders.STREAM_CURSOR]: cursor,
          },
        })
      )
    }

    // Normal catch-up read
    if (readResult.messages.length === 0) {
      const responseOffset = offset || stream.currentOffset
      const startOffsetStr = offsetParam ?? "-1"
      const etag = generateETag(path, startOffsetStr, responseOffset)

      // Check If-None-Match
      const ifNoneMatch = getHeader(request.headers, "if-none-match")
      if (ifNoneMatch && ifNoneMatch === etag) {
        return addCorsHeaders(
          HttpServerResponse.empty({ status: 304 }).pipe(
            HttpServerResponse.setHeader("etag", etag),
            HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
            HttpServerResponse.setHeader("cross-origin-resource-policy", "cross-origin")
          )
        )
      }

      // For JSON mode, return empty array; otherwise empty body
      const isJsonMode = normalizeContentType(stream.contentType) === "application/json"
      const responseBody = isJsonMode ? "[]" : ""

      return addCorsHeaders(
        createResponse(responseBody, {
          status: 200,
          contentType: streamContentType,
          headers: {
            [ProtocolHeaders.STREAM_NEXT_OFFSET]: responseOffset,
            [ProtocolHeaders.STREAM_UP_TO_DATE]: "true",
            "etag": etag,
          },
        })
      )
    }

    const body = yield* store.formatResponse(path, readResult.messages)
    const lastOffset = readResult.messages[readResult.messages.length - 1]!.offset
    const startOffsetStr = offsetParam ?? "-1"
    const etag = generateETag(path, startOffsetStr, lastOffset)

    // Check If-None-Match
    const ifNoneMatch = getHeader(request.headers, "if-none-match")
    if (ifNoneMatch && ifNoneMatch === etag) {
      return addCorsHeaders(
        HttpServerResponse.empty({ status: 304 }).pipe(
          HttpServerResponse.setHeader("etag", etag),
          HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
          HttpServerResponse.setHeader("cross-origin-resource-policy", "cross-origin")
        )
      )
    }

    return addCorsHeaders(
      createResponse(body, {
        status: 200,
        contentType: streamContentType,
        headers: {
          [ProtocolHeaders.STREAM_NEXT_OFFSET]: lastOffset,
          [ProtocolHeaders.STREAM_UP_TO_DATE]: "true",
          "etag": etag,
        },
      })
    )
  })

  /**
   * Handle POST - Append to stream.
   */
  const handleAppend = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.url, "http://localhost").pathname

    const contentType = getHeader(request.headers, "content-type")
    const seqHeader = getHeader(request.headers, ProtocolHeaders.STREAM_SEQ)

    // Content-Type is required per protocol
    if (!contentType) {
      return addCorsHeaders(createResponse("Content-Type header is required", { status: 400 }))
    }

    const producerId = getHeader(request.headers, ProtocolHeaders.PRODUCER_ID)
    const producerEpochHeader = getHeader(request.headers, ProtocolHeaders.PRODUCER_EPOCH)
    const producerSeqHeader = getHeader(request.headers, ProtocolHeaders.PRODUCER_SEQ)

    const hasProducerId = producerId !== undefined
    const hasProducerEpoch = producerEpochHeader !== undefined
    const hasProducerSeq = producerSeqHeader !== undefined

    if (
      (hasProducerId || hasProducerEpoch || hasProducerSeq) &&
      !(hasProducerId && hasProducerEpoch && hasProducerSeq)
    ) {
      return addCorsHeaders(
        createResponse(
          "All producer headers (Producer-Id, Producer-Epoch, Producer-Seq) must be provided together",
          { status: 400 }
        )
      )
    }

    // Check for empty producer ID
    if (hasProducerId && producerId === "") {
      return addCorsHeaders(createResponse("Invalid Producer-Id: must not be empty", { status: 400 }))
    }

    let producerEpoch: number | undefined
    let producerSeq: number | undefined

    if (hasProducerId && producerId !== "") {
      const epochNum = parseStrictInteger(producerEpochHeader!)
      if (epochNum === null) {
        return addCorsHeaders(
          createResponse("Invalid Producer-Epoch: must be a non-negative integer", { status: 400 })
        )
      }
      producerEpoch = epochNum

      const seqNum = parseStrictInteger(producerSeqHeader!)
      if (seqNum === null) {
        return addCorsHeaders(
          createResponse("Invalid Producer-Seq: must be a non-negative integer", { status: 400 })
        )
      }
      producerSeq = seqNum
    }

    const bodyArray = yield* request.arrayBuffer.pipe(Effect.map((buf) => new Uint8Array(buf)))

    if (bodyArray.length === 0) {
      return addCorsHeaders(createResponse("Empty body", { status: 400 }))
    }

    const appendResult = yield* store
      .append(path, bodyArray, {
        contentType,
        seq: seqHeader,
        producerId: hasProducerId && producerId !== "" ? producerId : undefined,
        producerEpoch,
        producerSeq,
      })
      .pipe(Effect.either)

    if (appendResult._tag === "Left") {
      const err = appendResult.left
      switch (err._tag) {
        case "StreamNotFoundError":
          return addCorsHeaders(createResponse("Stream not found", { status: 404 }))
        case "ContentTypeMismatchError":
          return addCorsHeaders(
            createResponse(
              `Content-Type mismatch: expected ${err.expected}, got ${err.received}`,
              { status: 409 }
            )
          )
        case "SequenceConflictError":
          return addCorsHeaders(
            createResponse(`Sequence conflict: ${err.receivedSeq} <= ${err.currentSeq}`, {
              status: 409,
            })
          )
        case "InvalidJsonError":
          return addCorsHeaders(createResponse("Invalid JSON", { status: 400 }))
        case "EmptyArrayError":
          return addCorsHeaders(createResponse("Empty arrays are not allowed", { status: 400 }))
      }
    }

    const result = Either.getOrThrow(appendResult)

    if (result.producerResult) {
      const pr = result.producerResult

      switch (pr.status) {
        case "duplicate":
          return addCorsHeaders(
            HttpServerResponse.empty({ status: 204 }).pipe(
              HttpServerResponse.setHeader(ProtocolHeaders.PRODUCER_EPOCH, String(producerEpoch)),
              HttpServerResponse.setHeader(ProtocolHeaders.PRODUCER_SEQ, String(pr.lastSeq)),
              HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
              HttpServerResponse.setHeader("cross-origin-resource-policy", "cross-origin")
            )
          )

        case "stale_epoch":
          return addCorsHeaders(
            createResponse("Stale producer epoch", {
              status: 403,
              headers: {
                [ProtocolHeaders.PRODUCER_EPOCH]: String(pr.currentEpoch),
              },
            })
          )

        case "invalid_epoch_seq":
          return addCorsHeaders(
            createResponse("New epoch must start with sequence 0", { status: 400 })
          )

        case "sequence_gap":
          return addCorsHeaders(
            createResponse("Sequence gap detected", {
              status: 409,
              headers: {
                [ProtocolHeaders.PRODUCER_EXPECTED_SEQ]: String(pr.expectedSeq),
                [ProtocolHeaders.PRODUCER_RECEIVED_SEQ]: String(pr.receivedSeq),
              },
            })
          )

        case "accepted":
          break
      }
    }

    const stream = yield* store.get(path)

    // Standard append (no producer) returns 204
    // With producer returns 200
    const hasValidProducer = hasProducerId && producerId !== ""
    const status = hasValidProducer ? 200 : 204

    let response = HttpServerResponse.empty({ status }).pipe(
      HttpServerResponse.setHeader(ProtocolHeaders.STREAM_NEXT_OFFSET, stream.currentOffset),
      HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
      HttpServerResponse.setHeader("cross-origin-resource-policy", "cross-origin")
    )

    if (hasValidProducer && result.producerResult?.status === "accepted") {
      response = response.pipe(
        HttpServerResponse.setHeader(
          ProtocolHeaders.PRODUCER_EPOCH,
          String(result.producerResult.proposedState.epoch)
        ),
        HttpServerResponse.setHeader(
          ProtocolHeaders.PRODUCER_SEQ,
          String(result.producerResult.proposedState.lastSeq)
        )
      )
    }

    return addCorsHeaders(response)
  })

  /**
   * Handle DELETE - Delete stream.
   */
  const handleDelete = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.url, "http://localhost").pathname

    const deleted = yield* store.delete(path)

    if (!deleted) {
      return addCorsHeaders(createResponse("Stream not found", { status: 404 }))
    }

    return addCorsHeaders(
      HttpServerResponse.empty({ status: 204 }).pipe(
        HttpServerResponse.setHeader("x-content-type-options", "nosniff"),
        HttpServerResponse.setHeader("cross-origin-resource-policy", "cross-origin")
      )
    )
  })

  return HttpRouter.empty.pipe(
    HttpRouter.options("/*", handleOptions),
    HttpRouter.put("/*", handleCreate),
    HttpRouter.head("/*", handleHead),
    HttpRouter.get("/*", handleRead),
    HttpRouter.post("/*", handleAppend),
    HttpRouter.del("/*", handleDelete)
  )
})

/**
 * Create the server layer.
 */
export const makeServerLayer = (
  port: number = 4437,
  host: string = "127.0.0.1"
): Layer.Layer<never, HttpServerError.ServeError, StreamStoreService> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const router = yield* makeRouter(port, host)

      const ServerLive = NodeHttpServer.layer(() => createServer(), { port, host })

      return HttpServer.serve(router).pipe(
        HttpServer.withLogAddress,
        Layer.provide(ServerLive)
      )
    })
  )

/**
 * Run the server.
 */
export const runServer = (
  port: number = 4437,
  host: string = "127.0.0.1"
): Effect.Effect<void, HttpServerError.ServeError, StreamStoreService> =>
  Effect.gen(function* () {
    const router = yield* makeRouter(port, host)

    console.log(`Starting Effect Durable Streams server on http://${host}:${port}`)

    yield* HttpServer.serve(router).pipe(
      HttpServer.withLogAddress,
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port, host })),
      Layer.launch
    )
  })
