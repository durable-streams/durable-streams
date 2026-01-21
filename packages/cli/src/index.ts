#!/usr/bin/env node

import { resolve as resolvePath } from "node:path"
import { stderr, stdin, stdout } from "node:process"
import { fileURLToPath } from "node:url"
import { DurableStream } from "@durable-streams/client"
import { flattenJsonForAppend, isJsonContentType } from "./jsonUtils.js"
import { parseWriteArgs } from "./parseWriteArgs.js"
import type { ParsedWriteArgs } from "./parseWriteArgs.js"

export type { ParsedWriteArgs }
export type { GlobalOptions }
export { flattenJsonForAppend, isJsonContentType, parseWriteArgs }
export { parseGlobalOptions }

const STREAM_URL = process.env.STREAM_URL || `http://localhost:4437`
const STREAM_AUTH = process.env.STREAM_AUTH

interface GlobalOptions {
  auth?: string
}

/**
 * Parse global options (like --auth) from args.
 * Returns the parsed options and remaining args.
 */
function parseGlobalOptions(args: Array<string>): {
  options: GlobalOptions
  remainingArgs: Array<string>
} {
  const options: GlobalOptions = {}
  const remainingArgs: Array<string> = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!

    if (arg === `--auth`) {
      const value = args[i + 1]
      if (!value || value.startsWith(`--`)) {
        throw new Error(`--auth requires a value (e.g., --auth "Bearer token")`)
      }
      options.auth = value
      i++ // Skip the value
    } else {
      remainingArgs.push(arg)
    }
  }

  // Fall back to env var if no flag provided
  if (!options.auth && STREAM_AUTH) {
    options.auth = STREAM_AUTH
  }

  return { options, remainingArgs }
}

/**
 * Build headers object from global options.
 */
function buildHeaders(options: GlobalOptions): Record<string, string> {
  const headers: Record<string, string> = {}
  if (options.auth) {
    headers[`Authorization`] = options.auth
  }
  return headers
}

function printUsage() {
  console.error(`
Usage:
  durable-stream create <stream_id>              Create a new stream
  durable-stream write <stream_id> <content>     Write content to a stream
  cat file.txt | durable-stream write <stream_id>    Write stdin to a stream
  durable-stream read <stream_id>                Follow a stream and write to stdout
  durable-stream delete <stream_id>              Delete a stream

Global Options:
  --auth <value>          Authorization header value (e.g., "Bearer my-token")

Write Options:
  --content-type <type>   Content-Type for the message (default: application/octet-stream)
  --json                  Write as JSON (input stored as single message)
  --batch-json            Write as JSON array of messages (each array element stored separately)

Environment Variables:
  STREAM_URL    Base URL of the stream server (default: http://localhost:4437)
  STREAM_AUTH   Authorization header value (overridden by --auth flag)
`)
}

async function createStream(streamId: string, headers: Record<string, string>) {
  const url = `${STREAM_URL}/v1/stream/${streamId}`

  try {
    await DurableStream.create({
      url,
      headers,
      contentType: `application/octet-stream`,
    })
    console.log(`Created stream: ${streamId}`)
  } catch (error) {
    if (error instanceof Error) {
      stderr.write(`Error creating stream: ${error.message}\n`)
    }
    process.exit(1)
  }
}

/**
 * Append JSON data to a stream with one-level array flattening.
 */
async function appendJson(
  stream: DurableStream,
  parsed: unknown
): Promise<number> {
  let count = 0
  for (const item of flattenJsonForAppend(parsed)) {
    await stream.append(item)
    count++
  }
  return count
}

async function writeStream(
  streamId: string,
  contentType: string,
  batchJson: boolean,
  headers: Record<string, string>,
  content?: string
) {
  const url = `${STREAM_URL}/v1/stream/${streamId}`
  const isJson = isJsonContentType(contentType)

  try {
    const stream = new DurableStream({ url, headers, contentType })

    if (content) {
      // Write provided content, interpreting escape sequences
      const processedContent = content
        .replace(/\\n/g, `\n`)
        .replace(/\\t/g, `\t`)
        .replace(/\\r/g, `\r`)
        .replace(/\\\\/g, `\\`)

      if (isJson) {
        const parsed = JSON.parse(processedContent)
        if (batchJson) {
          const count = await appendJson(stream, parsed)
          console.log(`Wrote ${count} message(s) to ${streamId}`)
        } else {
          await stream.append(parsed)
          console.log(`Wrote 1 message to ${streamId}`)
        }
      } else {
        await stream.append(processedContent)
        console.log(`Wrote ${processedContent.length} bytes to ${streamId}`)
      }
    } else {
      // Read from stdin
      const chunks: Array<Buffer> = []

      stdin.on(`data`, (chunk) => {
        chunks.push(chunk)
      })

      await new Promise<void>((resolve, reject) => {
        stdin.on(`end`, resolve)
        stdin.on(`error`, reject)
      })

      const data = Buffer.concat(chunks)

      if (isJson) {
        const parsed = JSON.parse(data.toString(`utf8`))
        if (batchJson) {
          const count = await appendJson(stream, parsed)
          console.log(`Wrote ${count} message(s) to ${streamId}`)
        } else {
          await stream.append(parsed)
          console.log(`Wrote 1 message to ${streamId}`)
        }
      } else {
        await stream.append(data)
        console.log(`Wrote ${data.length} bytes to ${streamId}`)
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      stderr.write(`Error writing to stream: ${error.message}\n`)
    }
    process.exit(1)
  }
}

async function readStream(streamId: string, headers: Record<string, string>) {
  const url = `${STREAM_URL}/v1/stream/${streamId}`

  try {
    const stream = new DurableStream({ url, headers })

    // Read from the stream and write to stdout
    // Using live: "auto" for catch-up first, then auto-select live mode
    const res = await stream.stream({ live: `auto` })

    // Stream bytes to stdout
    for await (const chunk of res.bodyStream()) {
      if (chunk.length > 0) {
        stdout.write(chunk)
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      stderr.write(`Error reading stream: ${error.message}\n`)
    }
    process.exit(1)
  }
}

async function deleteStream(streamId: string, headers: Record<string, string>) {
  const url = `${STREAM_URL}/v1/stream/${streamId}`

  try {
    const stream = new DurableStream({ url, headers })
    await stream.delete()
    console.log(`Deleted stream: ${streamId}`)
  } catch (error) {
    if (error instanceof Error) {
      stderr.write(`Error deleting stream: ${error.message}\n`)
    }
    process.exit(1)
  }
}

async function main() {
  const rawArgs = process.argv.slice(2)

  let globalOptions: GlobalOptions
  let args: Array<string>

  try {
    const parsed = parseGlobalOptions(rawArgs)
    globalOptions = parsed.options
    args = parsed.remainingArgs
  } catch (error) {
    if (error instanceof Error) {
      stderr.write(`Error: ${error.message}\n`)
    }
    process.exit(1)
  }

  const headers = buildHeaders(globalOptions)

  if (args.length < 1) {
    printUsage()
    process.exit(1)
  }

  const command = args[0]

  switch (command) {
    case `create`: {
      if (args.length < 2) {
        stderr.write(`Error: stream_id required\n`)
        printUsage()
        process.exit(1)
      }
      await createStream(args[1]!, headers)
      break
    }

    case `write`: {
      if (args.length < 2) {
        stderr.write(`Error: stream_id required\n`)
        printUsage()
        process.exit(1)
      }
      const streamId = args[1]!

      let parsed: ParsedWriteArgs
      try {
        parsed = parseWriteArgs(args.slice(2))
      } catch (error) {
        if (error instanceof Error) {
          stderr.write(`Error: ${error.message}\n`)
        }
        process.exit(1)
      }

      // Check if stdin is being piped
      if (!stdin.isTTY) {
        // Reading from stdin
        await writeStream(
          streamId,
          parsed.contentType,
          parsed.batchJson,
          headers
        )
      } else if (parsed.content) {
        // Content provided as argument
        await writeStream(
          streamId,
          parsed.contentType,
          parsed.batchJson,
          headers,
          parsed.content
        )
      } else {
        stderr.write(
          `Error: content required (provide as argument or pipe to stdin)\n`
        )
        printUsage()
        process.exit(1)
      }
      break
    }

    case `read`: {
      if (args.length < 2) {
        stderr.write(`Error: stream_id required\n`)
        printUsage()
        process.exit(1)
      }
      await readStream(args[1]!, headers)
      break
    }

    case `delete`: {
      if (args.length < 2) {
        stderr.write(`Error: stream_id required\n`)
        printUsage()
        process.exit(1)
      }
      await deleteStream(args[1]!, headers)
      break
    }

    default:
      stderr.write(`Error: unknown command '${command}'\n`)
      printUsage()
      process.exit(1)
  }
}

// Only run when executed directly, not when imported as a module
function isMainModule(): boolean {
  if (!process.argv[1]) return false
  const scriptPath = resolvePath(process.argv[1])
  const modulePath = fileURLToPath(import.meta.url)
  return scriptPath === modulePath
}

if (isMainModule()) {
  main().catch((error) => {
    stderr.write(`Fatal error: ${error.message}\n`)
    process.exit(1)
  })
}
