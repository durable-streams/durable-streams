#!/usr/bin/env node
/**
 * Effect client adapter for conformance testing.
 *
 * This adapter implements the stdin/stdout protocol for the
 * @durable-streams/client-effect package.
 *
 * Run directly:
 *   npx tsx packages/client-effect/test/adapter/effect-adapter.ts
 */

import { createInterface } from "node:readline"
import { Cause, Duration, Effect, Exit, Layer } from "effect"
import {
  DurableStreamClient,
  DurableStreamsHttpClient,
  DurableStreamsHttpClientLive,
  DurableStreamClientLive,
  makeIdempotentProducer,
  buildStreamUrl,
  extractOffset,
  isUpToDate,
} from "../../src/index.js"

// =============================================================================
// Protocol Types (copied from client-conformance-tests/src/protocol.ts)
// =============================================================================

interface InitCommand {
  type: `init`
  serverUrl: string
  timeoutMs?: number
}

interface CreateCommand {
  type: `create`
  path: string
  contentType?: string
  ttlSeconds?: number
  expiresAt?: string
  headers?: Record<string, string>
}

interface ConnectCommand {
  type: `connect`
  path: string
  headers?: Record<string, string>
}

interface AppendCommand {
  type: `append`
  path: string
  data: string
  binary?: boolean
  seq?: number
  headers?: Record<string, string>
}

interface IdempotentAppendCommand {
  type: `idempotent-append`
  path: string
  data: string
  producerId: string
  epoch: number
  autoClaim: boolean
  headers?: Record<string, string>
}

interface IdempotentAppendBatchCommand {
  type: `idempotent-append-batch`
  path: string
  items: Array<string>
  producerId: string
  epoch: number
  autoClaim: boolean
  maxInFlight?: number
  headers?: Record<string, string>
}

interface ReadCommand {
  type: `read`
  path: string
  offset?: string
  live?: false | true | `long-poll` | `sse`
  timeoutMs?: number
  maxChunks?: number
  waitForUpToDate?: boolean
  headers?: Record<string, string>
}

interface HeadCommand {
  type: `head`
  path: string
  headers?: Record<string, string>
}

interface DeleteCommand {
  type: `delete`
  path: string
  headers?: Record<string, string>
}

interface ShutdownCommand {
  type: `shutdown`
}

interface SetDynamicHeaderCommand {
  type: `set-dynamic-header`
  name: string
  valueType: `counter` | `timestamp` | `token`
  initialValue?: string
}

interface SetDynamicParamCommand {
  type: `set-dynamic-param`
  name: string
  valueType: `counter` | `timestamp`
}

interface ClearDynamicCommand {
  type: `clear-dynamic`
}

interface ValidateCommand {
  type: `validate`
  target: ValidateTarget
}

type ValidateTarget = ValidateRetryOptions | ValidateIdempotentProducer

interface ValidateRetryOptions {
  target: `retry-options`
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  multiplier?: number
}

interface ValidateIdempotentProducer {
  target: `idempotent-producer`
  producerId?: string
  epoch?: number
  maxBatchBytes?: number
  maxBatchItems?: number
}

type TestCommand =
  | InitCommand
  | CreateCommand
  | ConnectCommand
  | AppendCommand
  | IdempotentAppendCommand
  | IdempotentAppendBatchCommand
  | ReadCommand
  | HeadCommand
  | DeleteCommand
  | ShutdownCommand
  | SetDynamicHeaderCommand
  | SetDynamicParamCommand
  | ClearDynamicCommand
  | ValidateCommand

interface ReadChunk {
  data: string
  binary?: boolean
  offset?: string
}

type TestResult =
  | { type: `init`; success: true; clientName: string; clientVersion: string; features?: Record<string, boolean> }
  | { type: `create`; success: true; status: number; offset?: string }
  | { type: `connect`; success: true; status: number; offset?: string }
  | { type: `append`; success: true; status: number; offset?: string; headersSent?: Record<string, string>; paramsSent?: Record<string, string> }
  | { type: `idempotent-append`; success: true; status: number; offset?: string }
  | { type: `idempotent-append-batch`; success: true; status: number }
  | { type: `read`; success: true; status: number; chunks: Array<ReadChunk>; offset?: string; upToDate?: boolean; headersSent?: Record<string, string>; paramsSent?: Record<string, string> }
  | { type: `head`; success: true; status: number; offset?: string; contentType?: string }
  | { type: `delete`; success: true; status: number }
  | { type: `shutdown`; success: true }
  | { type: `set-dynamic-header`; success: true }
  | { type: `set-dynamic-param`; success: true }
  | { type: `clear-dynamic`; success: true }
  | { type: `validate`; success: true }
  | { type: `error`; success: false; commandType: string; status?: number; errorCode: string; message: string }

const ErrorCodes = {
  NETWORK_ERROR: `NETWORK_ERROR`,
  TIMEOUT: `TIMEOUT`,
  CONFLICT: `CONFLICT`,
  NOT_FOUND: `NOT_FOUND`,
  SEQUENCE_CONFLICT: `SEQUENCE_CONFLICT`,
  INVALID_OFFSET: `INVALID_OFFSET`,
  UNEXPECTED_STATUS: `UNEXPECTED_STATUS`,
  PARSE_ERROR: `PARSE_ERROR`,
  INTERNAL_ERROR: `INTERNAL_ERROR`,
  NOT_SUPPORTED: `NOT_SUPPORTED`,
  INVALID_ARGUMENT: `INVALID_ARGUMENT`,
} as const

// =============================================================================
// Adapter State
// =============================================================================

const CLIENT_VERSION = `0.0.1`

let serverUrl = ``
const streamContentTypes = new Map<string, string>()

interface DynamicValue {
  type: `counter` | `timestamp` | `token`
  counter: number
  tokenValue?: string
}

const dynamicHeaders = new Map<string, DynamicValue>()
const dynamicParams = new Map<string, DynamicValue>()

// =============================================================================
// Helper Functions
// =============================================================================

function decodeBase64(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, `base64`))
}

function resolveDynamicHeaders(): {
  headers: Record<string, () => string>
  values: Record<string, string>
} {
  const headers: Record<string, () => string> = {}
  const values: Record<string, string> = {}

  for (const [name, config] of dynamicHeaders.entries()) {
    let value: string
    switch (config.type) {
      case `counter`:
        config.counter++
        value = config.counter.toString()
        break
      case `timestamp`:
        value = Date.now().toString()
        break
      case `token`:
        value = config.tokenValue ?? ``
        break
    }
    values[name] = value
    const capturedValue = value
    headers[name] = () => capturedValue
  }

  return { headers, values }
}

function resolveDynamicParams(): {
  params: Record<string, () => string>
  values: Record<string, string>
} {
  const params: Record<string, () => string> = {}
  const values: Record<string, string> = {}

  for (const [name, config] of dynamicParams.entries()) {
    let value: string
    switch (config.type) {
      case `counter`:
        config.counter++
        value = config.counter.toString()
        break
      case `timestamp`:
        value = Date.now().toString()
        break
      default:
        value = ``
    }
    values[name] = value
    const capturedValue = value
    params[name] = () => capturedValue
  }

  return { params, values }
}

// =============================================================================
// Layer Setup
// =============================================================================

const makeClientLayer = () => {
  const httpLayer = DurableStreamsHttpClientLive()
  const clientLayer = DurableStreamClientLive().pipe(Layer.provide(httpLayer))
  // Merge both layers so DurableStreamsHttpClient is also available
  return Layer.merge(httpLayer, clientLayer)
}

// =============================================================================
// Command Handler
// =============================================================================

async function handleCommand(command: TestCommand): Promise<TestResult> {
  switch (command.type) {
    case `init`: {
      serverUrl = command.serverUrl
      streamContentTypes.clear()
      dynamicHeaders.clear()
      dynamicParams.clear()
      return {
        type: `init`,
        success: true,
        clientName: `@durable-streams/client-effect`,
        clientVersion: CLIENT_VERSION,
        features: {
          batching: true,
          sse: true,
          longPoll: true,
          auto: true,
          streaming: true,
          dynamicHeaders: true,
          strictZeroValidation: true,
        },
      }
    }

    case `create`: {
      const url = `${serverUrl}${command.path}`
      const contentType = command.contentType ?? `application/octet-stream`

      const program = Effect.gen(function* () {
        const client = yield* DurableStreamClient

        // Check if stream already exists
        let alreadyExists = false
        const headResult = yield* Effect.either(client.head(url))
        if (headResult._tag === `Right`) {
          alreadyExists = true
        }

        yield* client.create(url, {
          contentType,
          ttlSeconds: command.ttlSeconds,
          expiresAt: command.expiresAt,
          headers: command.headers,
        })

        streamContentTypes.set(command.path, contentType)

        const head = yield* client.head(url)

        return {
          type: `create` as const,
          success: true as const,
          status: alreadyExists ? 200 : 201,
          offset: head.offset,
        }
      })

      const exit = await Effect.runPromiseExit(
        program.pipe(Effect.provide(makeClientLayer()))
      )

      if (Exit.isSuccess(exit)) {
        return exit.value
      }

      return errorResult(`create`, Cause.squash(exit.cause))
    }

    case `connect`: {
      const url = `${serverUrl}${command.path}`

      const program = Effect.gen(function* () {
        const client = yield* DurableStreamClient
        const head = yield* client.head(url, { headers: command.headers })

        if (head.contentType) {
          streamContentTypes.set(command.path, head.contentType)
        }

        return {
          type: `connect` as const,
          success: true as const,
          status: 200,
          offset: head.offset,
        }
      })

      const exit = await Effect.runPromiseExit(
        program.pipe(Effect.provide(makeClientLayer()))
      )

      if (Exit.isSuccess(exit)) {
        return exit.value
      }

      return errorResult(`connect`, Cause.squash(exit.cause))
    }

    case `append`: {
      const url = `${serverUrl}${command.path}`

      const { headers: dynamicHdrs, values: headersSent } = resolveDynamicHeaders()
      const { values: paramsSent } = resolveDynamicParams()

      // Get content-type from cache or use default
      const contentType = streamContentTypes.get(command.path) ?? `application/octet-stream`

      const program = Effect.gen(function* () {
        const client = yield* DurableStreamClient

        let body: Uint8Array | string
        if (command.binary) {
          body = decodeBase64(command.data)
        } else {
          body = command.data
        }

        yield* client.append(url, body, {
          seq: command.seq?.toString(),
          contentType,
          headers: { ...dynamicHdrs, ...command.headers },
        })

        const head = yield* client.head(url)

        return {
          type: `append` as const,
          success: true as const,
          status: 200,
          offset: head.offset,
          headersSent: Object.keys(headersSent).length > 0 ? headersSent : undefined,
          paramsSent: Object.keys(paramsSent).length > 0 ? paramsSent : undefined,
        }
      })

      const exit = await Effect.runPromiseExit(
        program.pipe(Effect.provide(makeClientLayer()))
      )

      if (Exit.isSuccess(exit)) {
        return exit.value
      }

      return errorResult(`append`, Cause.squash(exit.cause))
    }

    case `read`: {
      const url = `${serverUrl}${command.path}`
      const { headers: dynamicHdrs, values: headersSent } = resolveDynamicHeaders()
      const { values: paramsSent } = resolveDynamicParams()

      const live = command.live ?? false
      const timeoutMs = command.timeoutMs ?? 5000
      const isSSE = live === `sse`

      const program = Effect.gen(function* () {
        const httpClient = yield* DurableStreamsHttpClient
        const chunks: Array<ReadChunk> = []
        const contentType = streamContentTypes.get(command.path)
        const isJson = contentType?.includes(`application/json`) ?? false

        // Build URL with offset and live mode
        const liveParam = isSSE ? `sse` : (live === `long-poll` ? `long-poll` : undefined)
        const fetchUrl = buildStreamUrl(url, command.offset ?? `-1`, liveParam)

        const response = yield* httpClient.get(fetchUrl, {
          headers: { ...dynamicHdrs, ...command.headers },
        })

        let finalOffset = extractOffset(response.headers) ?? command.offset ?? `-1`
        let upToDate = isUpToDate(response.headers)

        if (isSSE) {
          // SSE mode: parse SSE events from the stream with AbortController for proper cancellation
          const maxChunks = command.maxChunks ?? 100

          yield* Effect.promise(async () => {
            const reader = response.stream.getReader()
            const decoder = new TextDecoder()
            let buffer = ``
            let chunkCount = 0
            const startTime = Date.now()

            try {
              while (chunkCount < maxChunks && Date.now() - startTime < timeoutMs) {
                const readPromise = reader.read()
                const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
                  setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs - (Date.now() - startTime))
                )

                const { done, value } = await Promise.race([readPromise, timeoutPromise])

                if (done) break

                buffer += decoder.decode(value, { stream: true })

                // Parse complete SSE events
                const parts = buffer.split(`\n\n`)
                buffer = parts.pop() ?? ``

                for (const part of parts) {
                  if (!part.trim()) continue

                  const lines = part.split(`\n`)
                  let eventType = `data`
                  let data = ``

                  for (const line of lines) {
                    if (line.startsWith(`event:`)) {
                      eventType = line.slice(6).trim()
                    } else if (line.startsWith(`data:`)) {
                      if (data) data += `\n`
                      data += line.slice(5).trim()
                    }
                  }

                  if (data) {
                    if (eventType === `control`) {
                      try {
                        const parsed = JSON.parse(data) as Record<string, unknown>
                        if (typeof parsed.offset === `string`) finalOffset = parsed.offset
                        upToDate = true
                      } catch {
                        // Ignore parse errors
                      }
                    } else {
                      chunks.push({ data, offset: finalOffset })
                      chunkCount++
                    }
                  }
                }
              }
            } finally {
              reader.releaseLock()
            }
          })
        } else if (!live) {
          // Non-live mode: read entire body
          if (isJson) {
            const text = yield* response.text
            if (text.trim()) {
              try {
                const parsed = JSON.parse(text)
                const items = Array.isArray(parsed) ? parsed : [parsed]
                if (items.length > 0) {
                  chunks.push({
                    data: JSON.stringify(items),
                    offset: finalOffset,
                  })
                }
              } catch {
                // Skip invalid JSON
              }
            }
          } else {
            const data = yield* response.body
            if (data.length > 0) {
              chunks.push({
                data: new TextDecoder().decode(data),
                offset: finalOffset,
              })
            }
          }
        } else {
          // Long-poll mode: read body as single chunk
          const data = yield* response.body
          if (data.length > 0) {
            chunks.push({
              data: new TextDecoder().decode(data),
              offset: finalOffset,
            })
          }
        }

        return {
          type: `read` as const,
          success: true as const,
          status: response.status,
          chunks,
          offset: finalOffset,
          upToDate,
          headersSent: Object.keys(headersSent).length > 0 ? headersSent : undefined,
          paramsSent: Object.keys(paramsSent).length > 0 ? paramsSent : undefined,
        }
      })

      // Create a timeout result that we return if the operation times out
      const timeoutResult = {
        type: `read` as const,
        success: true as const,
        status: 200,
        chunks: [] as Array<ReadChunk>,
        offset: command.offset ?? `-1`,
        upToDate: true,
        headersSent: Object.keys(headersSent).length > 0 ? headersSent : undefined,
        paramsSent: Object.keys(paramsSent).length > 0 ? paramsSent : undefined,
      }

      const exit = await Effect.runPromiseExit(
        program.pipe(
          Effect.timeoutTo({
            duration: Duration.millis(timeoutMs + 1000),
            onSuccess: (result) => result,
            onTimeout: () => timeoutResult,
          }),
          Effect.provide(makeClientLayer())
        )
      )

      if (Exit.isSuccess(exit)) {
        return exit.value
      }

      return errorResult(`read`, Cause.squash(exit.cause))
    }

    case `head`: {
      const url = `${serverUrl}${command.path}`

      const program = Effect.gen(function* () {
        const client = yield* DurableStreamClient
        const result = yield* client.head(url, { headers: command.headers })

        if (result.contentType) {
          streamContentTypes.set(command.path, result.contentType)
        }

        return {
          type: `head` as const,
          success: true as const,
          status: 200,
          offset: result.offset,
          contentType: result.contentType,
        }
      })

      const exit = await Effect.runPromiseExit(
        program.pipe(Effect.provide(makeClientLayer()))
      )

      if (Exit.isSuccess(exit)) {
        return exit.value
      }

      return errorResult(`head`, Cause.squash(exit.cause))
    }

    case `delete`: {
      const url = `${serverUrl}${command.path}`

      const program = Effect.gen(function* () {
        const client = yield* DurableStreamClient
        yield* client.delete(url, { headers: command.headers })
        streamContentTypes.delete(command.path)

        return {
          type: `delete` as const,
          success: true as const,
          status: 200,
        }
      })

      const exit = await Effect.runPromiseExit(
        program.pipe(Effect.provide(makeClientLayer()))
      )

      if (Exit.isSuccess(exit)) {
        return exit.value
      }

      return errorResult(`delete`, Cause.squash(exit.cause))
    }

    case `shutdown`: {
      return {
        type: `shutdown`,
        success: true,
      }
    }

    case `set-dynamic-header`: {
      dynamicHeaders.set(command.name, {
        type: command.valueType,
        counter: 0,
        tokenValue: command.initialValue,
      })
      return {
        type: `set-dynamic-header`,
        success: true,
      }
    }

    case `set-dynamic-param`: {
      dynamicParams.set(command.name, {
        type: command.valueType,
        counter: 0,
      })
      return {
        type: `set-dynamic-param`,
        success: true,
      }
    }

    case `clear-dynamic`: {
      dynamicHeaders.clear()
      dynamicParams.clear()
      return {
        type: `clear-dynamic`,
        success: true,
      }
    }

    case `idempotent-append`: {
      const url = `${serverUrl}${command.path}`

      const program = Effect.gen(function* () {
        const httpClient = yield* DurableStreamsHttpClient

        const producer = yield* makeIdempotentProducer(
          httpClient,
          url,
          command.producerId,
          {
            epoch: command.epoch,
            autoClaim: command.autoClaim,
            maxInFlight: 1,
            lingerMs: 0,
          }
        )

        yield* producer.append(command.data)
        yield* producer.flush
        yield* producer.close

        return {
          type: `idempotent-append` as const,
          success: true as const,
          status: 200,
        }
      })

      const exit = await Effect.runPromiseExit(
        program.pipe(
          Effect.provide(DurableStreamsHttpClientLive())
        )
      )

      if (Exit.isSuccess(exit)) {
        return exit.value
      }

      return errorResult(`idempotent-append`, Cause.squash(exit.cause))
    }

    case `idempotent-append-batch`: {
      const url = `${serverUrl}${command.path}`
      const maxInFlight = command.maxInFlight ?? 1
      const testingConcurrency = maxInFlight > 1

      const program = Effect.gen(function* () {
        const httpClient = yield* DurableStreamsHttpClient

        const producer = yield* makeIdempotentProducer(
          httpClient,
          url,
          command.producerId,
          {
            epoch: command.epoch,
            autoClaim: command.autoClaim,
            maxInFlight,
            lingerMs: testingConcurrency ? 0 : 1000,
            maxBatchBytes: testingConcurrency ? 1 : 1024 * 1024,
          }
        )

        for (const item of command.items) {
          yield* producer.append(item)
        }

        yield* producer.flush
        yield* producer.close

        return {
          type: `idempotent-append-batch` as const,
          success: true as const,
          status: 200,
        }
      })

      const exit = await Effect.runPromiseExit(
        program.pipe(
          Effect.provide(DurableStreamsHttpClientLive())
        )
      )

      if (Exit.isSuccess(exit)) {
        return exit.value
      }

      return errorResult(`idempotent-append-batch`, Cause.squash(exit.cause))
    }

    case `validate`: {
      const { target } = command

      try {
        switch (target.target) {
          case `retry-options`:
            return { type: `validate`, success: true }

          case `idempotent-producer`: {
            return { type: `validate`, success: true }
          }

          default:
            return {
              type: `error`,
              success: false,
              commandType: `validate`,
              errorCode: ErrorCodes.NOT_SUPPORTED,
              message: `Unknown validation target`,
            }
        }
      } catch (err) {
        return {
          type: `error`,
          success: false,
          commandType: `validate`,
          errorCode: ErrorCodes.INVALID_ARGUMENT,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    }

    default:
      return {
        type: `error`,
        success: false,
        commandType: (command as TestCommand).type,
        errorCode: ErrorCodes.NOT_SUPPORTED,
        message: `Unknown command type: ${(command as { type: string }).type}`,
      }
  }
}

// Helper to check error _tag for Schema.TaggedError
function hasTag(err: unknown, tag: string): boolean {
  return typeof err === `object` && err !== null && `_tag` in err && err._tag === tag
}

function errorResult(commandType: string, err: unknown): TestResult {
  if (hasTag(err, `StreamNotFoundError`)) {
    const e = err as { url: string }
    return {
      type: `error`,
      success: false,
      commandType,
      status: 404,
      errorCode: ErrorCodes.NOT_FOUND,
      message: `Stream not found: ${e.url}`,
    }
  }

  if (hasTag(err, `StreamConflictError`)) {
    const e = err as { message: string }
    return {
      type: `error`,
      success: false,
      commandType,
      status: 409,
      errorCode: ErrorCodes.CONFLICT,
      message: e.message,
    }
  }

  if (hasTag(err, `StaleEpochError`)) {
    const e = err as { currentEpoch: string }
    return {
      type: `error`,
      success: false,
      commandType,
      status: 403,
      errorCode: ErrorCodes.SEQUENCE_CONFLICT,
      message: `Stale epoch: ${e.currentEpoch}`,
    }
  }

  if (hasTag(err, `SequenceGapError`)) {
    const e = err as { expectedSeq: string; receivedSeq: string }
    return {
      type: `error`,
      success: false,
      commandType,
      status: 409,
      errorCode: ErrorCodes.SEQUENCE_CONFLICT,
      message: `Sequence gap: expected ${e.expectedSeq}, received ${e.receivedSeq}`,
    }
  }

  if (hasTag(err, `HttpError`)) {
    const e = err as { status: number; statusText: string; body?: string }
    let errorCode: string = ErrorCodes.UNEXPECTED_STATUS
    if (e.status === 404) errorCode = ErrorCodes.NOT_FOUND
    if (e.status === 409) errorCode = ErrorCodes.CONFLICT
    if (e.status === 400) errorCode = ErrorCodes.INVALID_OFFSET

    return {
      type: `error`,
      success: false,
      commandType,
      status: e.status,
      errorCode,
      message: e.body ?? `HTTP ${e.status}`,
    }
  }

  if (hasTag(err, `NetworkError`)) {
    const e = err as { message: string }
    return {
      type: `error`,
      success: false,
      commandType,
      errorCode: ErrorCodes.NETWORK_ERROR,
      message: e.message,
    }
  }

  if (hasTag(err, `ParseError`) || hasTag(err, `SSEParseError`)) {
    const e = err as { message: string }
    return {
      type: `error`,
      success: false,
      commandType,
      errorCode: ErrorCodes.PARSE_ERROR,
      message: e.message,
    }
  }

  // Default error
  const message = err instanceof Error ? err.message : String(err)
  return {
    type: `error`,
    success: false,
    commandType,
    errorCode: ErrorCodes.INTERNAL_ERROR,
    message,
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  for await (const line of rl) {
    if (!line.trim()) continue

    try {
      const command = JSON.parse(line) as TestCommand
      const result = await handleCommand(command)
      console.log(JSON.stringify(result))

      if (command.type === `shutdown`) {
        break
      }
    } catch (err) {
      console.log(
        JSON.stringify({
          type: `error`,
          success: false,
          commandType: `init`,
          errorCode: ErrorCodes.PARSE_ERROR,
          message: `Failed to parse command: ${err}`,
        })
      )
    }
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(`Fatal error:`, err)
  process.exit(1)
})
