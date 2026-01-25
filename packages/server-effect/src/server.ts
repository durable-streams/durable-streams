/**
 * Effect-based HTTP server for Durable Streams.
 */
import { createServer } from "node:http"
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Duration, Effect, Layer, Option, Stream } from "effect"

import { StreamStoreService, normalizeContentType } from "./StreamStore"
import {
  DEFAULT_CURSOR_EPOCH,
  DEFAULT_CURSOR_INTERVAL_SECONDS,
  generateResponseCursor,
} from "./Cursor"
import { Headers as ProtocolHeaders } from "./types"
import type { HttpServerError } from "@effect/platform"
import type { StreamNotFoundError } from "./errors"
import type { ServerConfigShape } from "./Config"

/**
 * Parse an integer header value strictly.
 */
function parseStrictInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  if (value.length > 1 && value.startsWith(`0`)) return null
  const num = parseInt(value, 10)
  if (!Number.isFinite(num) || num < 0) return null
  return num
}

/**
 * Validate TTL header value.
 */
function validateTtl(value: string | undefined): {
  value?: number
  error?: string
} {
  if (!value) return {}
  const num = parseStrictInteger(value)
  if (num === null || num <= 0) {
    return { error: `Invalid TTL: must be a positive integer` }
  }
  return { value: num }
}

/**
 * Validate Expires-At header value.
 */
function validateExpiresAt(value: string | undefined): {
  value?: string
  error?: string
} {
  if (!value) return {}
  const date = new Date(value)
  if (isNaN(date.getTime())) {
    return { error: `Invalid Expires-At: must be a valid ISO 8601 timestamp` }
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
function generateETag(
  path: string,
  startOffset: string,
  endOffset: string
): string {
  return `"${Buffer.from(path).toString(`base64`)}:${startOffset}:${endOffset}"`
}

/**
 * Encode data for SSE format.
 */
function encodeSSEData(payload: string): string {
  const lines = payload.split(/\r\n|\r|\n/)
  return lines.map((line) => `data:${line}`).join(`\n`) + `\n\n`
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
  if (
    (typeof body === `string` && body.length === 0) ||
    (body instanceof Uint8Array && body.length === 0)
  ) {
    response = HttpServerResponse.empty({ status })
  } else if (typeof body === `string`) {
    // For non-empty strings, use raw to avoid default content-type
    response = HttpServerResponse.raw(new TextEncoder().encode(body), {
      status,
    })
  } else {
    // For non-empty Uint8Array, use raw to avoid default content-type (application/octet-stream)
    response = HttpServerResponse.raw(body, { status })
  }

  if (contentType) {
    response = HttpServerResponse.setHeader(
      response,
      `content-type`,
      contentType
    )
  }

  for (const [key, value] of Object.entries(headers)) {
    response = HttpServerResponse.setHeader(response, key, value)
  }

  response = HttpServerResponse.setHeader(
    response,
    `x-content-type-options`,
    `nosniff`
  )
  response = HttpServerResponse.setHeader(
    response,
    `cross-origin-resource-policy`,
    `cross-origin`
  )

  return response
}

/**
 * Add CORS headers to a response.
 */
function addCorsHeaders(
  response: HttpServerResponse.HttpServerResponse
): HttpServerResponse.HttpServerResponse {
  return response.pipe(
    HttpServerResponse.setHeader(`access-control-allow-origin`, `*`),
    HttpServerResponse.setHeader(
      `access-control-allow-methods`,
      `GET, POST, PUT, DELETE, HEAD, OPTIONS`
    ),
    HttpServerResponse.setHeader(
      `access-control-allow-headers`,
      `content-type, authorization, stream-seq, stream-ttl, stream-expires-at, producer-id, producer-epoch, producer-seq`
    ),
    HttpServerResponse.setHeader(
      `access-control-expose-headers`,
      `stream-next-offset, stream-cursor, stream-up-to-date, producer-epoch, producer-seq, producer-expected-seq, producer-received-seq, etag, content-type`
    )
  )
}

/**
 * Get header value (case-insensitive).
 */
function getHeader(
  headers: HttpServerRequest.HttpServerRequest[`headers`],
  name: string
): string | undefined {
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Build the main HTTP router.
 */
const makeRouter = (port: number, host: string, config: ServerConfigShape) =>
  Effect.gen(function* () {
    const store = yield* StreamStoreService

    const cursorOptions = {
      intervalSeconds: config.cursorIntervalSeconds,
      epoch: config.cursorEpoch,
    }

    const longPollTimeoutMs = Duration.toMillis(config.longPollTimeout)

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

      yield* Effect.annotateCurrentSpan({ path, method: `PUT` })
      yield* Effect.logInfo(`Handling PUT request`).pipe(
        Effect.annotateLogs({ path })
      )

      const contentType = getHeader(request.headers, `content-type`)
      const ttlHeader = getHeader(request.headers, ProtocolHeaders.STREAM_TTL)
      const expiresAtHeader = getHeader(
        request.headers,
        ProtocolHeaders.STREAM_EXPIRES_AT
      )

      // Validate TTL and Expires-At cannot both be specified
      if (ttlHeader && expiresAtHeader) {
        return addCorsHeaders(
          createResponse(
            `Cannot specify both Stream-TTL and Stream-Expires-At`,
            { status: 400 }
          )
        )
      }

      const ttlResult = validateTtl(ttlHeader)
      if (ttlResult.error) {
        return addCorsHeaders(createResponse(ttlResult.error, { status: 400 }))
      }

      const expiresResult = validateExpiresAt(expiresAtHeader)
      if (expiresResult.error) {
        return addCorsHeaders(
          createResponse(expiresResult.error, { status: 400 })
        )
      }

      const bodyArray = yield* request.arrayBuffer.pipe(
        Effect.map((buf) => new Uint8Array(buf))
      )

      const exists = yield* store.has(path)

      return yield* store
        .create(path, {
          contentType,
          ttlSeconds: ttlResult.value,
          expiresAt: expiresResult.value,
          initialData: bodyArray.length > 0 ? bodyArray : undefined,
        })
        .pipe(
          Effect.map((stream) => {
            const status = exists ? 200 : 201
            const responseHeaders: Record<string, string> = {
              [ProtocolHeaders.STREAM_NEXT_OFFSET]: stream.currentOffset,
            }

            // Add Location header for 201 Created responses
            if (!exists) {
              responseHeaders[`location`] = `http://${host}:${port}${path}`
            }

            return addCorsHeaders(
              createResponse(``, {
                status,
                contentType: stream.contentType || `application/octet-stream`,
                headers: responseHeaders,
              })
            )
          }),
          Effect.catchTag(`StreamConflictError`, (err) =>
            Effect.succeed(
              addCorsHeaders(createResponse(err.message, { status: 409 }))
            )
          )
        )
    }).pipe(Effect.withSpan(`server.handleCreate`))

    /**
     * Handle HEAD - Get metadata.
     */
    const handleHead = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = new URL(request.url, `http://localhost`).pathname

      yield* Effect.annotateCurrentSpan({ path, method: `HEAD` })

      return yield* store.get(path).pipe(
        Effect.map((stream) =>
          addCorsHeaders(
            HttpServerResponse.empty({ status: 200 }).pipe(
              HttpServerResponse.setHeader(
                ProtocolHeaders.STREAM_NEXT_OFFSET,
                stream.currentOffset
              ),
              HttpServerResponse.setHeader(
                `content-type`,
                stream.contentType || `application/octet-stream`
              ),
              HttpServerResponse.setHeader(`cache-control`, `no-store`),
              HttpServerResponse.setHeader(`x-content-type-options`, `nosniff`),
              HttpServerResponse.setHeader(
                `cross-origin-resource-policy`,
                `cross-origin`
              )
            )
          )
        ),
        Effect.catchTag(`StreamNotFoundError`, () =>
          Effect.succeed(
            addCorsHeaders(createResponse(`Stream not found`, { status: 404 }))
          )
        )
      )
    }).pipe(Effect.withSpan(`server.handleHead`))

    /**
     * SSE state machine phases:
     * - 'read': Read messages and emit data + control events
     * - 'wait': Wait for new messages, emit keep-alive on timeout
     */
    type SSEPhase = `read` | `wait`
    interface SSEState {
      phase: SSEPhase
      offset: string | undefined
    }

    /**
     * Create SSE stream using Effect patterns.
     * Uses Stream.unfoldEffect with two phases to emit BEFORE waiting.
     */
    const createSSEStream = (
      path: string,
      initialOffset: string | undefined,
      streamCurrentOffset: string,
      isJsonStream: boolean,
      clientCursor: string | undefined
    ): Stream.Stream<string, StreamNotFoundError> =>
      Stream.unfoldEffect(
        { phase: `read`, offset: initialOffset } as SSEState,
        (state) =>
          Effect.gen(function* () {
            if (state.phase === `read`) {
              // Read phase: emit data events + control, then transition to wait
              const readResult = yield* store.read(path, state.offset)

              let events = ``
              let newOffset: string = streamCurrentOffset

              // Build data events for each message
              for (const msg of readResult.messages) {
                let dataPayload: string
                if (isJsonStream) {
                  const jsonBytes = yield* store.formatResponse(path, [msg])
                  dataPayload = new TextDecoder().decode(jsonBytes)
                } else {
                  dataPayload = new TextDecoder().decode(msg.data)
                }
                events += `event: data\n${encodeSSEData(dataPayload)}`
                newOffset = msg.offset
              }

              // Compute offset for control message (last message or stream's current offset)
              const controlOffset =
                readResult.messages[readResult.messages.length - 1]?.offset ??
                streamCurrentOffset

              // Build control event
              const cursor = generateResponseCursor(
                clientCursor || undefined,
                cursorOptions
              )
              const control = JSON.stringify({
                streamNextOffset: controlOffset,
                streamCursor: cursor,
                upToDate: true,
              })
              events += `event: control\n${encodeSSEData(control)}`
              newOffset = controlOffset

              // Emit events, then transition to wait phase
              return Option.some([
                events,
                { phase: `wait` as SSEPhase, offset: newOffset },
              ] as const)
            } else {
              // Wait phase: wait for new messages (offset is always valid at this point)
              const waitResult = yield* store.waitForMessages(
                path,
                state.offset!,
                longPollTimeoutMs
              )

              if (waitResult.timedOut) {
                // Timeout: emit keep-alive control, stay in wait phase
                const keepAliveCursor = generateResponseCursor(
                  clientCursor || undefined,
                  cursorOptions
                )
                const keepAlive = JSON.stringify({
                  streamNextOffset: state.offset,
                  streamCursor: keepAliveCursor,
                  upToDate: true,
                })
                return Option.some([
                  `event: control\n${encodeSSEData(keepAlive)}`,
                  { phase: `wait` as SSEPhase, offset: state.offset },
                ] as const)
              }

              // New data available: transition back to read phase
              // Emit empty string (will be filtered out)
              return Option.some([
                ``,
                { phase: `read` as SSEPhase, offset: state.offset },
              ] as const)
            }
          })
      ).pipe(Stream.filter((s) => s.length > 0))

    /**
     * Handle GET - Read stream.
     */
    const handleRead = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, `http://localhost`)
      const path = url.pathname

      yield* Effect.annotateCurrentSpan({ path, method: `GET` })
      yield* Effect.logInfo(`Handling GET request`).pipe(
        Effect.annotateLogs({ path })
      )

      const offsetParam = url.searchParams.get(`offset`)
      const liveMode = url.searchParams.get(`live`)
      const clientCursor = url.searchParams.get(`cursor`)

      // Validate offset parameter
      if (offsetParam !== null) {
        // Reject empty offset
        if (offsetParam === ``) {
          return addCorsHeaders(
            createResponse(`Empty offset parameter`, { status: 400 })
          )
        }

        // Reject multiple offset parameters
        const allOffsets = url.searchParams.getAll(`offset`)
        if (allOffsets.length > 1) {
          return addCorsHeaders(
            createResponse(`Multiple offset parameters not allowed`, {
              status: 400,
            })
          )
        }

        // Validate offset format
        if (!validateOffset(offsetParam)) {
          return addCorsHeaders(
            createResponse(`Invalid offset format`, { status: 400 })
          )
        }
      }

      // Require offset parameter for long-poll and SSE per protocol spec
      if ((liveMode === `long-poll` || liveMode === `sse`) && !offsetParam) {
        const modeName = liveMode === `sse` ? `SSE` : `Long-poll`
        return addCorsHeaders(
          createResponse(`${modeName} requires offset parameter`, {
            status: 400,
          })
        )
      }

      return yield* store.get(path).pipe(
        Effect.flatMap((stream) =>
          Effect.gen(function* () {
            const streamContentType =
              stream.contentType || `application/octet-stream`

            // For offset=now, convert to actual tail offset
            const effectiveOffset =
              offsetParam === `now` ? stream.currentOffset : offsetParam

            let offset: string | undefined
            if (effectiveOffset && effectiveOffset !== `-1`) {
              offset = effectiveOffset
            }

            // Handle SSE mode
            if (liveMode === `sse`) {
              const contentType = normalizeContentType(stream.contentType)
              if (
                contentType !== `application/json` &&
                !contentType.startsWith(`text/`)
              ) {
                return addCorsHeaders(
                  createResponse(
                    `SSE mode not supported for this content type`,
                    {
                      status: 400,
                    }
                  )
                )
              }

              // For SSE, preserve the original offset (-1 or undefined means from beginning)
              // store.read handles undefined/-1 as "read all from beginning"
              const sseOffset =
                offsetParam === `now`
                  ? stream.currentOffset
                  : offsetParam === `-1`
                    ? undefined
                    : offsetParam || undefined

              const isJsonStream = contentType === `application/json`
              const sseStream = createSSEStream(
                path,
                sseOffset,
                stream.currentOffset,
                isJsonStream,
                clientCursor || undefined
              )

              // Encode strings to bytes manually to avoid charset being added
              const encoder = new TextEncoder()
              const sseByteStream = sseStream.pipe(
                Stream.map((s) => encoder.encode(s))
              )

              return addCorsHeaders(
                HttpServerResponse.stream(sseByteStream, {
                  status: 200,
                  contentType: `text/event-stream`,
                }).pipe(
                  HttpServerResponse.setHeader(
                    `cache-control`,
                    `no-cache, no-store`
                  ),
                  HttpServerResponse.setHeader(`connection`, `keep-alive`),
                  HttpServerResponse.setHeader(
                    `x-content-type-options`,
                    `nosniff`
                  ),
                  HttpServerResponse.setHeader(
                    `cross-origin-resource-policy`,
                    `cross-origin`
                  )
                )
              )
            }

            // Handle catch-up mode offset=now: return empty response with tail offset
            // For long-poll mode, we fall through to wait for new data instead
            if (offsetParam === `now` && liveMode !== `long-poll`) {
              const isJsonMode =
                normalizeContentType(stream.contentType) === `application/json`
              const responseBody = isJsonMode ? `[]` : ``

              return addCorsHeaders(
                createResponse(responseBody, {
                  status: 200,
                  contentType: streamContentType,
                  headers: {
                    [ProtocolHeaders.STREAM_NEXT_OFFSET]: stream.currentOffset,
                    [ProtocolHeaders.STREAM_UP_TO_DATE]: `true`,
                    "cache-control": `no-store`,
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
              offsetParam === `now`

            if (
              liveMode === `long-poll` &&
              clientIsCaughtUp &&
              readResult.messages.length === 0
            ) {
              const waitResult = yield* store.waitForMessages(
                path,
                offset || stream.currentOffset,
                longPollTimeoutMs
              )

              const cursor = generateResponseCursor(
                clientCursor || undefined,
                cursorOptions
              )

              if (waitResult.timedOut) {
                return addCorsHeaders(
                  HttpServerResponse.empty({ status: 204 }).pipe(
                    HttpServerResponse.setHeader(
                      ProtocolHeaders.STREAM_NEXT_OFFSET,
                      offset || stream.currentOffset
                    ),
                    HttpServerResponse.setHeader(
                      ProtocolHeaders.STREAM_UP_TO_DATE,
                      `true`
                    ),
                    HttpServerResponse.setHeader(
                      ProtocolHeaders.STREAM_CURSOR,
                      cursor
                    ),
                    HttpServerResponse.setHeader(
                      `x-content-type-options`,
                      `nosniff`
                    ),
                    HttpServerResponse.setHeader(
                      `cross-origin-resource-policy`,
                      `cross-origin`
                    )
                  )
                )
              }

              if (waitResult.messages.length > 0) {
                const body = yield* store.formatResponse(
                  path,
                  waitResult.messages
                )
                const lastOffset =
                  waitResult.messages[waitResult.messages.length - 1]!.offset

                return addCorsHeaders(
                  createResponse(body, {
                    status: 200,
                    contentType: streamContentType,
                    headers: {
                      [ProtocolHeaders.STREAM_NEXT_OFFSET]: lastOffset,
                      [ProtocolHeaders.STREAM_UP_TO_DATE]: `true`,
                      [ProtocolHeaders.STREAM_CURSOR]: cursor,
                    },
                  })
                )
              }
            }

            // Long-poll with data already available - return immediately with cursor
            if (liveMode === `long-poll` && readResult.messages.length > 0) {
              const cursor = generateResponseCursor(
                clientCursor || undefined,
                cursorOptions
              )
              const body = yield* store.formatResponse(
                path,
                readResult.messages
              )
              const lastOffset =
                readResult.messages[readResult.messages.length - 1]!.offset

              return addCorsHeaders(
                createResponse(body, {
                  status: 200,
                  contentType: streamContentType,
                  headers: {
                    [ProtocolHeaders.STREAM_NEXT_OFFSET]: lastOffset,
                    [ProtocolHeaders.STREAM_UP_TO_DATE]: `true`,
                    [ProtocolHeaders.STREAM_CURSOR]: cursor,
                  },
                })
              )
            }

            // Normal catch-up read
            if (readResult.messages.length === 0) {
              const responseOffset = offset || stream.currentOffset
              const startOffsetStr = offsetParam ?? `-1`
              const etag = generateETag(path, startOffsetStr, responseOffset)

              // Check If-None-Match
              const ifNoneMatch = getHeader(request.headers, `if-none-match`)
              if (ifNoneMatch && ifNoneMatch === etag) {
                return addCorsHeaders(
                  HttpServerResponse.empty({ status: 304 }).pipe(
                    HttpServerResponse.setHeader(`etag`, etag),
                    HttpServerResponse.setHeader(
                      `x-content-type-options`,
                      `nosniff`
                    ),
                    HttpServerResponse.setHeader(
                      `cross-origin-resource-policy`,
                      `cross-origin`
                    )
                  )
                )
              }

              // For JSON mode, return empty array; otherwise empty body
              const isJsonMode =
                normalizeContentType(stream.contentType) === `application/json`
              const responseBody = isJsonMode ? `[]` : ``

              return addCorsHeaders(
                createResponse(responseBody, {
                  status: 200,
                  contentType: streamContentType,
                  headers: {
                    [ProtocolHeaders.STREAM_NEXT_OFFSET]: responseOffset,
                    [ProtocolHeaders.STREAM_UP_TO_DATE]: `true`,
                    etag: etag,
                  },
                })
              )
            }

            const body = yield* store.formatResponse(path, readResult.messages)
            const lastOffset =
              readResult.messages[readResult.messages.length - 1]!.offset
            const startOffsetStr = offsetParam ?? `-1`
            const etag = generateETag(path, startOffsetStr, lastOffset)

            // Check If-None-Match
            const ifNoneMatch = getHeader(request.headers, `if-none-match`)
            if (ifNoneMatch && ifNoneMatch === etag) {
              return addCorsHeaders(
                HttpServerResponse.empty({ status: 304 }).pipe(
                  HttpServerResponse.setHeader(`etag`, etag),
                  HttpServerResponse.setHeader(
                    `x-content-type-options`,
                    `nosniff`
                  ),
                  HttpServerResponse.setHeader(
                    `cross-origin-resource-policy`,
                    `cross-origin`
                  )
                )
              )
            }

            return addCorsHeaders(
              createResponse(body, {
                status: 200,
                contentType: streamContentType,
                headers: {
                  [ProtocolHeaders.STREAM_NEXT_OFFSET]: lastOffset,
                  [ProtocolHeaders.STREAM_UP_TO_DATE]: `true`,
                  etag: etag,
                },
              })
            )
          })
        ),
        Effect.catchTag(`StreamNotFoundError`, () =>
          Effect.succeed(
            addCorsHeaders(createResponse(`Stream not found`, { status: 404 }))
          )
        )
      )
    }).pipe(Effect.withSpan(`server.handleRead`))

    /**
     * Handle POST - Append to stream.
     */
    const handleAppend = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = new URL(request.url, `http://localhost`).pathname

      yield* Effect.annotateCurrentSpan({ path, method: `POST` })
      yield* Effect.logInfo(`Handling POST request`).pipe(
        Effect.annotateLogs({ path })
      )

      const contentType = getHeader(request.headers, `content-type`)
      const seqHeader = getHeader(request.headers, ProtocolHeaders.STREAM_SEQ)

      // Content-Type is required per protocol
      if (!contentType) {
        return addCorsHeaders(
          createResponse(`Content-Type header is required`, { status: 400 })
        )
      }

      const producerId = getHeader(request.headers, ProtocolHeaders.PRODUCER_ID)
      const producerEpochHeader = getHeader(
        request.headers,
        ProtocolHeaders.PRODUCER_EPOCH
      )
      const producerSeqHeader = getHeader(
        request.headers,
        ProtocolHeaders.PRODUCER_SEQ
      )

      const hasProducerId = producerId !== undefined
      const hasProducerEpoch = producerEpochHeader !== undefined
      const hasProducerSeq = producerSeqHeader !== undefined

      if (
        (hasProducerId || hasProducerEpoch || hasProducerSeq) &&
        !(hasProducerId && hasProducerEpoch && hasProducerSeq)
      ) {
        return addCorsHeaders(
          createResponse(
            `All producer headers (Producer-Id, Producer-Epoch, Producer-Seq) must be provided together`,
            { status: 400 }
          )
        )
      }

      // Check for empty producer ID
      if (hasProducerId && producerId === ``) {
        return addCorsHeaders(
          createResponse(`Invalid Producer-Id: must not be empty`, {
            status: 400,
          })
        )
      }

      let producerEpoch: number | undefined
      let producerSeq: number | undefined

      if (hasProducerId && producerId !== ``) {
        const epochNum = parseStrictInteger(producerEpochHeader!)
        if (epochNum === null) {
          return addCorsHeaders(
            createResponse(
              `Invalid Producer-Epoch: must be a non-negative integer`,
              {
                status: 400,
              }
            )
          )
        }
        producerEpoch = epochNum

        const seqNum = parseStrictInteger(producerSeqHeader!)
        if (seqNum === null) {
          return addCorsHeaders(
            createResponse(
              `Invalid Producer-Seq: must be a non-negative integer`,
              { status: 400 }
            )
          )
        }
        producerSeq = seqNum
      }

      const bodyArray = yield* request.arrayBuffer.pipe(
        Effect.map((buf) => new Uint8Array(buf))
      )

      if (bodyArray.length === 0) {
        return addCorsHeaders(createResponse(`Empty body`, { status: 400 }))
      }

      return yield* store
        .append(path, bodyArray, {
          contentType,
          seq: seqHeader,
          producerId:
            hasProducerId && producerId !== `` ? producerId : undefined,
          producerEpoch,
          producerSeq,
        })
        .pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (result.producerResult) {
                const pr = result.producerResult

                switch (pr.status) {
                  case `duplicate`:
                    return addCorsHeaders(
                      HttpServerResponse.empty({ status: 204 }).pipe(
                        HttpServerResponse.setHeader(
                          ProtocolHeaders.PRODUCER_EPOCH,
                          String(producerEpoch)
                        ),
                        HttpServerResponse.setHeader(
                          ProtocolHeaders.PRODUCER_SEQ,
                          String(pr.lastSeq)
                        ),
                        HttpServerResponse.setHeader(
                          `x-content-type-options`,
                          `nosniff`
                        ),
                        HttpServerResponse.setHeader(
                          `cross-origin-resource-policy`,
                          `cross-origin`
                        )
                      )
                    )

                  case `stale_epoch`:
                    return addCorsHeaders(
                      createResponse(`Stale producer epoch`, {
                        status: 403,
                        headers: {
                          [ProtocolHeaders.PRODUCER_EPOCH]: String(
                            pr.currentEpoch
                          ),
                        },
                      })
                    )

                  case `invalid_epoch_seq`:
                    return addCorsHeaders(
                      createResponse(`New epoch must start with sequence 0`, {
                        status: 400,
                      })
                    )

                  case `sequence_gap`:
                    return addCorsHeaders(
                      createResponse(`Sequence gap detected`, {
                        status: 409,
                        headers: {
                          [ProtocolHeaders.PRODUCER_EXPECTED_SEQ]: String(
                            pr.expectedSeq
                          ),
                          [ProtocolHeaders.PRODUCER_RECEIVED_SEQ]: String(
                            pr.receivedSeq
                          ),
                        },
                      })
                    )

                  case `accepted`:
                    break
                }
              }

              const streamData = yield* store.get(path)

              // Standard append (no producer) returns 204
              // With producer returns 200
              const hasValidProducer = hasProducerId && producerId !== ``
              const status = hasValidProducer ? 200 : 204

              let response = HttpServerResponse.empty({ status }).pipe(
                HttpServerResponse.setHeader(
                  ProtocolHeaders.STREAM_NEXT_OFFSET,
                  streamData.currentOffset
                ),
                HttpServerResponse.setHeader(
                  `x-content-type-options`,
                  `nosniff`
                ),
                HttpServerResponse.setHeader(
                  `cross-origin-resource-policy`,
                  `cross-origin`
                )
              )

              if (
                hasValidProducer &&
                result.producerResult?.status === `accepted`
              ) {
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
          ),
          Effect.catchTags({
            StreamNotFoundError: () =>
              Effect.succeed(
                addCorsHeaders(
                  createResponse(`Stream not found`, { status: 404 })
                )
              ),
            ContentTypeMismatchError: (err) =>
              Effect.succeed(
                addCorsHeaders(
                  createResponse(
                    `Content-Type mismatch: expected ${err.expected}, got ${err.received}`,
                    { status: 409 }
                  )
                )
              ),
            SequenceConflictError: (err) =>
              Effect.succeed(
                addCorsHeaders(
                  createResponse(
                    `Sequence conflict: ${err.receivedSeq} <= ${err.currentSeq}`,
                    { status: 409 }
                  )
                )
              ),
            InvalidJsonError: () =>
              Effect.succeed(
                addCorsHeaders(createResponse(`Invalid JSON`, { status: 400 }))
              ),
            EmptyArrayError: () =>
              Effect.succeed(
                addCorsHeaders(
                  createResponse(`Empty arrays are not allowed`, {
                    status: 400,
                  })
                )
              ),
          })
        )
    }).pipe(Effect.withSpan(`server.handleAppend`))

    /**
     * Handle DELETE - Delete stream.
     */
    const handleDelete = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = new URL(request.url, `http://localhost`).pathname

      yield* Effect.annotateCurrentSpan({ path, method: `DELETE` })
      yield* Effect.logInfo(`Handling DELETE request`).pipe(
        Effect.annotateLogs({ path })
      )

      const deleted = yield* store.delete(path)

      if (!deleted) {
        return addCorsHeaders(
          createResponse(`Stream not found`, { status: 404 })
        )
      }

      return addCorsHeaders(
        HttpServerResponse.empty({ status: 204 }).pipe(
          HttpServerResponse.setHeader(`x-content-type-options`, `nosniff`),
          HttpServerResponse.setHeader(
            `cross-origin-resource-policy`,
            `cross-origin`
          )
        )
      )
    }).pipe(Effect.withSpan(`server.handleDelete`))

    return HttpRouter.empty.pipe(
      HttpRouter.options(`/*`, handleOptions),
      HttpRouter.put(`/*`, handleCreate),
      HttpRouter.head(`/*`, handleHead),
      HttpRouter.get(`/*`, handleRead),
      HttpRouter.post(`/*`, handleAppend),
      HttpRouter.del(`/*`, handleDelete)
    )
  })

/**
 * Default server configuration.
 */
const defaultConfig: ServerConfigShape = {
  longPollTimeout: Duration.seconds(30),
  cursorIntervalSeconds: DEFAULT_CURSOR_INTERVAL_SECONDS,
  cursorEpoch: DEFAULT_CURSOR_EPOCH,
  producerStateTtl: Duration.days(7),
}

/**
 * Create the server layer.
 */
export const makeServerLayer = (
  port: number = 4437,
  host: string = `127.0.0.1`,
  config: ServerConfigShape = defaultConfig
): Layer.Layer<never, HttpServerError.ServeError, StreamStoreService> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const router = yield* makeRouter(port, host, config)

      const ServerLive = NodeHttpServer.layer(() => createServer(), {
        port,
        host,
      })

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
  host: string = `127.0.0.1`,
  config: ServerConfigShape = defaultConfig
): Effect.Effect<void, HttpServerError.ServeError, StreamStoreService> =>
  Effect.gen(function* () {
    const router = yield* makeRouter(port, host, config)

    yield* Effect.log(
      `Starting Effect Durable Streams server on http://${host}:${port}`
    )

    yield* HttpServer.serve(router).pipe(
      HttpServer.withLogAddress,
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port, host })),
      Layer.launch
    )
  })
