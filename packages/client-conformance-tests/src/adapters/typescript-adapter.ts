#!/usr/bin/env node
/**
 * TypeScript client adapter for conformance testing.
 *
 * This adapter implements the stdin/stdout protocol for the
 * @durable-streams/client package.
 *
 * Run directly:
 *   npx tsx packages/client-conformance-tests/src/adapters/typescript-adapter.ts
 */

import { createInterface } from "node:readline"
import {
  DurableStream,
  DurableStreamError,
  FetchError,
  stream,
} from "@durable-streams/client"
import {
  ErrorCodes,
  decodeBase64,
  parseCommand,
  serializeResult,
} from "../protocol.js"
import type {
  ErrorCode,
  ReadChunk,
  TestCommand,
  TestResult,
} from "../protocol.js"

// Package version - read from package.json would be ideal
const CLIENT_VERSION = `0.0.1`

let serverUrl = ``

// Track content-type per stream path for append operations
const streamContentTypes = new Map<string, string>()

async function handleCommand(command: TestCommand): Promise<TestResult> {
  switch (command.type) {
    case `init`: {
      serverUrl = command.serverUrl
      // Clear caches on init
      streamContentTypes.clear()
      return {
        type: `init`,
        success: true,
        clientName: `@durable-streams/client`,
        clientVersion: CLIENT_VERSION,
        features: {
          batching: true,
          sse: true,
          longPoll: true,
          streaming: true,
        },
      }
    }

    case `create`: {
      try {
        const url = `${serverUrl}${command.path}`
        const contentType = command.contentType ?? `application/octet-stream`

        // Check if stream already exists by trying to connect first
        let alreadyExists = false
        try {
          await DurableStream.head({ url })
          alreadyExists = true
        } catch {
          // Stream doesn't exist, which is expected for new creates
        }

        const ds = await DurableStream.create({
          url,
          contentType,
          ttlSeconds: command.ttlSeconds,
          expiresAt: command.expiresAt,
          headers: command.headers,
        })

        // Cache the content-type
        streamContentTypes.set(command.path, contentType)

        const head = await ds.head()

        return {
          type: `create`,
          success: true,
          status: alreadyExists ? 200 : 201, // 201 for new, 200 for idempotent
          offset: head.offset,
        }
      } catch (err) {
        return errorResult(`create`, err)
      }
    }

    case `connect`: {
      try {
        const url = `${serverUrl}${command.path}`
        const ds = await DurableStream.connect({
          url,
          headers: command.headers,
        })

        const head = await ds.head()

        // Cache the content-type for this stream
        if (head.contentType) {
          streamContentTypes.set(command.path, head.contentType)
        }

        return {
          type: `connect`,
          success: true,
          status: 200,
          offset: head.offset,
        }
      } catch (err) {
        return errorResult(`connect`, err)
      }
    }

    case `append`: {
      try {
        const url = `${serverUrl}${command.path}`

        // Get content-type from cache or use default
        const contentType =
          streamContentTypes.get(command.path) ?? `application/octet-stream`

        const ds = new DurableStream({
          url,
          headers: command.headers,
          contentType,
        })

        let body: Uint8Array | string
        if (command.binary) {
          body = decodeBase64(command.data)
        } else {
          body = command.data
        }

        await ds.append(body, { seq: command.seq?.toString() })
        const head = await ds.head()

        return {
          type: `append`,
          success: true,
          status: 200,
          offset: head.offset,
        }
      } catch (err) {
        return errorResult(`append`, err)
      }
    }

    case `read`: {
      try {
        const url = `${serverUrl}${command.path}`

        // Determine live mode
        let live: `long-poll` | `sse` | false
        if (command.live === `long-poll`) {
          live = `long-poll`
        } else if (command.live === `sse`) {
          live = `sse`
        } else {
          live = false
        }

        // Create abort controller for timeout handling
        const abortController = new AbortController()
        const timeoutMs = command.timeoutMs ?? 5000

        // Set up timeout BEFORE calling stream() - important for long-poll
        // where the first request may block waiting for data
        const timeoutId = setTimeout(() => {
          abortController.abort()
        }, timeoutMs)

        let response: Awaited<ReturnType<typeof stream>>
        try {
          response = await stream({
            url,
            offset: command.offset,
            live,
            headers: command.headers,
            signal: abortController.signal,
          })
        } catch (err) {
          clearTimeout(timeoutId)
          // If we timed out waiting for the initial response, return gracefully
          if (abortController.signal.aborted) {
            return {
              type: `read`,
              success: true,
              status: 200,
              chunks: [],
              offset: command.offset ?? `-1`,
              upToDate: true, // Timed out = caught up (no new data)
            }
          }
          throw err
        }

        // Initial stream() succeeded, clear the outer timeout
        clearTimeout(timeoutId)

        const chunks: Array<ReadChunk> = []
        let finalOffset = command.offset ?? response.offset
        let upToDate = response.upToDate

        // Collect chunks using body() for non-live mode or bodyStream() for live
        const maxChunks = command.maxChunks ?? 100

        if (!live) {
          // For non-live mode, use body() to get all data
          try {
            const data = await response.body()
            if (data.length > 0) {
              chunks.push({
                data: new TextDecoder().decode(data),
                offset: response.offset,
              })
            }
            finalOffset = response.offset
            upToDate = response.upToDate
          } catch {
            // If body fails, stream might be empty
          }
        } else {
          // For live mode, use subscribeBytes which provides per-chunk metadata
          const decoder = new TextDecoder()
          const startTime = Date.now()
          let chunkCount = 0
          let done = false

          // Create a promise that resolves when we're done collecting chunks
          await new Promise<void>((resolve) => {
            // Set up subscription timeout
            const subscriptionTimeoutId = setTimeout(() => {
              done = true
              // Abort the underlying fetch to stop the long-poll request
              abortController.abort()
              // Capture final state from response when timing out
              // Important for empty streams that never call subscribeBytes
              // For timeouts with no data, mark as upToDate since we've caught up
              upToDate = response.upToDate || true
              finalOffset = response.offset
              resolve()
            }, timeoutMs)

            const unsubscribe = response.subscribeBytes(async (chunk) => {
              // Check if we should stop
              if (done || chunkCount >= maxChunks) {
                return
              }

              // Check timeout
              if (Date.now() - startTime > timeoutMs) {
                done = true
                resolve()
                return
              }

              const hasData = chunk.data.length > 0
              if (hasData) {
                chunks.push({
                  data: decoder.decode(chunk.data),
                  offset: chunk.offset,
                })
                chunkCount++
              }

              finalOffset = chunk.offset
              upToDate = chunk.upToDate

              // For waitForUpToDate, stop when we've reached up-to-date
              if (command.waitForUpToDate && chunk.upToDate) {
                done = true
                clearTimeout(subscriptionTimeoutId)
                resolve()
                return
              }

              // Stop if we've collected enough chunks
              if (chunkCount >= maxChunks) {
                done = true
                clearTimeout(subscriptionTimeoutId)
                resolve()
              }

              // Keep async for backpressure support even though not using await
              await Promise.resolve()
            })

            // Clean up subscription when done
            // Also capture final upToDate state for empty streams
            response.closed
              .then(() => {
                if (!done) {
                  done = true
                  clearTimeout(subscriptionTimeoutId)
                  // For empty streams, capture the final upToDate from response
                  upToDate = response.upToDate
                  finalOffset = response.offset
                  resolve()
                }
              })
              .catch(() => {
                if (!done) {
                  done = true
                  clearTimeout(subscriptionTimeoutId)
                  resolve()
                }
              })

            // Also handle the case where subscribeBytes is called
            // We need to store unsubscribe but only call it on cleanup
            void unsubscribe // Keep reference for potential future use
          })
        }

        // Cancel the response to clean up
        response.cancel()

        return {
          type: `read`,
          success: true,
          status: 200,
          chunks,
          offset: finalOffset,
          upToDate,
        }
      } catch (err) {
        return errorResult(`read`, err)
      }
    }

    case `head`: {
      try {
        const url = `${serverUrl}${command.path}`
        const result = await DurableStream.head({
          url,
          headers: command.headers,
        })

        // Cache content-type
        if (result.contentType) {
          streamContentTypes.set(command.path, result.contentType)
        }

        return {
          type: `head`,
          success: true,
          status: 200,
          offset: result.offset,
          contentType: result.contentType,
          // Note: HeadResult from client doesn't expose TTL info currently
        }
      } catch (err) {
        return errorResult(`head`, err)
      }
    }

    case `delete`: {
      try {
        const url = `${serverUrl}${command.path}`
        await DurableStream.delete({
          url,
          headers: command.headers,
        })

        // Remove from cache
        streamContentTypes.delete(command.path)

        return {
          type: `delete`,
          success: true,
          status: 200,
        }
      } catch (err) {
        return errorResult(`delete`, err)
      }
    }

    case `shutdown`: {
      return {
        type: `shutdown`,
        success: true,
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

function errorResult(
  commandType: TestCommand[`type`],
  err: unknown
): TestResult {
  if (err instanceof DurableStreamError) {
    let errorCode: ErrorCode = ErrorCodes.INTERNAL_ERROR
    let status: number | undefined

    // Map error codes - use actual DurableStreamErrorCode values
    if (err.code === `NOT_FOUND`) {
      errorCode = ErrorCodes.NOT_FOUND
      status = 404
    } else if (err.code === `CONFLICT_EXISTS`) {
      errorCode = ErrorCodes.CONFLICT
      status = 409
    } else if (err.code === `CONFLICT_SEQ`) {
      errorCode = ErrorCodes.SEQUENCE_CONFLICT
      status = 409
    } else if (err.code === `BAD_REQUEST`) {
      errorCode = ErrorCodes.INVALID_OFFSET
      status = 400
    }

    return {
      type: `error`,
      success: false,
      commandType,
      status,
      errorCode,
      message: err.message,
    }
  }

  if (err instanceof FetchError) {
    let errorCode: ErrorCode
    const msg = err.message.toLowerCase()

    if (err.status === 404) {
      errorCode = ErrorCodes.NOT_FOUND
    } else if (err.status === 409) {
      // Check for sequence conflict vs general conflict
      if (msg.includes(`sequence`)) {
        errorCode = ErrorCodes.SEQUENCE_CONFLICT
      } else {
        errorCode = ErrorCodes.CONFLICT
      }
    } else if (err.status === 400) {
      // Check if this is an invalid offset error
      if (msg.includes(`offset`) || msg.includes(`invalid`)) {
        errorCode = ErrorCodes.INVALID_OFFSET
      } else {
        errorCode = ErrorCodes.UNEXPECTED_STATUS
      }
    } else {
      errorCode = ErrorCodes.UNEXPECTED_STATUS
    }

    return {
      type: `error`,
      success: false,
      commandType,
      status: err.status,
      errorCode,
      message: err.message,
    }
  }

  if (err instanceof Error) {
    if (err.message.includes(`ECONNREFUSED`) || err.message.includes(`fetch`)) {
      return {
        type: `error`,
        success: false,
        commandType,
        errorCode: ErrorCodes.NETWORK_ERROR,
        message: err.message,
      }
    }

    return {
      type: `error`,
      success: false,
      commandType,
      errorCode: ErrorCodes.INTERNAL_ERROR,
      message: err.message,
    }
  }

  return {
    type: `error`,
    success: false,
    commandType,
    errorCode: ErrorCodes.INTERNAL_ERROR,
    message: String(err),
  }
}

async function main(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  for await (const line of rl) {
    if (!line.trim()) continue

    try {
      const command = parseCommand(line)
      const result = await handleCommand(command)
      console.log(serializeResult(result))

      // Exit after shutdown command
      if (command.type === `shutdown`) {
        break
      }
    } catch (err) {
      console.log(
        serializeResult({
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
