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

async function handleCommand(command: TestCommand): Promise<TestResult> {
  switch (command.type) {
    case `init`: {
      serverUrl = command.serverUrl
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
        const ds = await DurableStream.create({
          url,
          contentType: command.contentType,
          ttl: command.ttlSeconds,
          expiresAt: command.expiresAt,
          headers: command.headers,
        })

        const head = await ds.head()

        return {
          type: `create`,
          success: true,
          status: 201, // We don't get the actual status from the API
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
        const ds = new DurableStream({ url, headers: command.headers })

        let body: Uint8Array | string
        if (command.binary) {
          body = decodeBase64(command.data)
        } else {
          body = command.data
        }

        await ds.append(body, { seq: command.seq })
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

        const response = await stream({
          url,
          offset: command.offset,
          live,
          headers: command.headers,
        })

        const chunks: Array<ReadChunk> = []
        let finalOffset = command.offset
        let upToDate = false

        // Collect chunks
        const maxChunks = command.maxChunks ?? 100
        let chunkCount = 0

        if (command.waitForUpToDate) {
          // Wait for up-to-date signal
          for await (const chunk of response.subscribeBytes()) {
            chunks.push({
              data: new TextDecoder().decode(chunk.data),
              offset: chunk.offset,
            })
            finalOffset = chunk.offset
            upToDate = chunk.upToDate
            chunkCount++

            if (upToDate || chunkCount >= maxChunks) {
              break
            }
          }
        } else {
          // Just read available data
          for await (const chunk of response.subscribeBytes()) {
            chunks.push({
              data: new TextDecoder().decode(chunk.data),
              offset: chunk.offset,
            })
            finalOffset = chunk.offset
            upToDate = chunk.upToDate
            chunkCount++

            if (chunkCount >= maxChunks) {
              break
            }

            // For non-live mode, stop when up-to-date
            if (!command.live && upToDate) {
              break
            }
          }
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

        return {
          type: `head`,
          success: true,
          status: 200,
          offset: result.offset,
          contentType: result.contentType,
          ttlSeconds: result.ttl,
          expiresAt: result.expiresAt,
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

    // Map error codes
    if (err.code === `stream_not_found`) {
      errorCode = ErrorCodes.NOT_FOUND
      status = 404
    } else if (err.code === `conflict`) {
      errorCode = ErrorCodes.CONFLICT
      status = 409
    } else if (err.code === `sequence_conflict`) {
      errorCode = ErrorCodes.SEQUENCE_CONFLICT
      status = 409
    } else if (err.code === `invalid_offset`) {
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
    const errorCode: ErrorCode =
      err.status === 404
        ? ErrorCodes.NOT_FOUND
        : err.status === 409
          ? ErrorCodes.CONFLICT
          : ErrorCodes.UNEXPECTED_STATUS

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
