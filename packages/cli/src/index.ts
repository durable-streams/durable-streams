#!/usr/bin/env node

import { resolve as resolvePath } from "node:path"
import { stderr, stdin, stdout } from "node:process"
import { fileURLToPath } from "node:url"
import { DurableStream } from "@durable-streams/client"
import { flattenJsonForAppend, isJsonContentType } from "./jsonUtils.js"
import { parseWriteArgs } from "./parseWriteArgs.js"
import { validateAuth, validateStreamId, validateUrl } from "./validation.js"
import type { ParsedWriteArgs } from "./parseWriteArgs.js"

export type { ParsedWriteArgs }
export type { GlobalOptions }
export { flattenJsonForAppend, isJsonContentType, parseWriteArgs }
export { parseGlobalOptions, buildHeaders, getUsageText }
export { validateUrl, validateAuth, validateStreamId }

const STREAM_URL = process.env.STREAM_URL || `http://localhost:4437`
const STREAM_AUTH = process.env.STREAM_AUTH

interface GlobalOptions {
  url?: string
  auth?: string
}

/**
 * Parse global options (like --auth) from args.
 * Falls back to STREAM_AUTH env var if --auth flag not provided.
 * Returns the parsed options and remaining args.
 */
function parseGlobalOptions(args: Array<string>): {
  options: GlobalOptions
  remainingArgs: Array<string>
  warnings: Array<string>
} {
  const options: GlobalOptions = {}
  const remainingArgs: Array<string> = []
  const warnings: Array<string> = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!

    if (arg === `--url`) {
      const value = args[i + 1]
      if (!value || value.startsWith(`--`)) {
        throw new Error(
          `--url requires a value\n  Example: --url "http://localhost:4437"`
        )
      }
      const urlValidation = validateUrl(value)
      if (!urlValidation.valid) {
        throw new Error(urlValidation.error)
      }
      options.url = value
      i++
    } else if (arg === `--auth`) {
      const value = args[i + 1]
      if (!value || value.startsWith(`--`)) {
        throw new Error(
          `--auth requires a value\n  Example: --auth "Bearer my-token"`
        )
      }
      const authValidation = validateAuth(value)
      if (!authValidation.valid) {
        throw new Error(authValidation.error)
      }
      if (authValidation.error) {
        // It's a warning, not an error
        warnings.push(authValidation.error)
      }
      options.auth = value
      i++
    } else {
      remainingArgs.push(arg)
    }
  }

  // Fall back to STREAM_URL env var if no --url flag provided
  if (!options.url) {
    const urlValidation = validateUrl(STREAM_URL)
    if (!urlValidation.valid) {
      throw new Error(
        `Invalid STREAM_URL environment variable: ${urlValidation.error}`
      )
    }
    options.url = STREAM_URL
  }

  // Fall back to STREAM_AUTH env var if no --auth flag provided
  if (!options.auth && STREAM_AUTH) {
    const authValidation = validateAuth(STREAM_AUTH)
    if (!authValidation.valid) {
      throw new Error(
        `Invalid STREAM_AUTH environment variable: ${authValidation.error}`
      )
    }
    if (authValidation.error) {
      warnings.push(authValidation.error)
    }
    options.auth = STREAM_AUTH
  }

  return { options, remainingArgs, warnings }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildHeaders(options: GlobalOptions): Record<string, string> {
  return options.auth ? { Authorization: options.auth } : {}
}

function getUsageText(): string {
  return `
Usage:
  durable-stream create <stream_id>              Create a new stream
  durable-stream write <stream_id> <content>     Write content to a stream
  cat file.txt | durable-stream write <stream_id>    Write stdin to a stream
  durable-stream read <stream_id>                Follow a stream and write to stdout
  durable-stream delete <stream_id>              Delete a stream

Global Options:
  --url <url>             Stream server URL (overrides STREAM_URL env var)
  --auth <value>          Authorization header value (e.g., "Bearer my-token")
  --help, -h              Show this help message

Write Options:
  --content-type <type>   Content-Type for the message (default: application/octet-stream)
  --json                  Write as JSON (input stored as single message)
  --batch-json            Write as JSON array of messages (each array element stored separately)

Environment Variables:
  STREAM_URL    Base URL of the stream server (default: http://localhost:4437)
  STREAM_AUTH   Authorization header value (overridden by --auth flag)
`
}

function printUsage() {
  console.error(getUsageText())
}

async function createStream(
  baseUrl: string,
  streamId: string,
  headers: Record<string, string>
) {
  const url = `${baseUrl}/v1/stream/${streamId}`

  try {
    await DurableStream.create({
      url,
      headers,
      contentType: `application/octet-stream`,
    })
    console.log(`Stream created successfully: ${streamId}`)
    console.log(`  URL: ${url}`)
  } catch (error) {
    stderr.write(`Failed to create stream "${streamId}"\n`)
    stderr.write(`  ${formatErrorMessage(getErrorMessage(error))}\n`)
    process.exit(1)
  }
}

/**
 * Format error messages from the server/client for better readability.
 */
function formatErrorMessage(message: string): string {
  // Extract HTTP status codes and make them more readable
  const httpMatch = message.match(/HTTP Error (\d+)/)
  const statusCode = httpMatch?.[1]
  if (statusCode) {
    const status = parseInt(statusCode, 10)
    const statusText = getHttpStatusText(status)
    return message.replace(/HTTP Error \d+/, `${statusText} (${status})`)
  }
  return message
}

function getHttpStatusText(status: number): string {
  const statusTexts: Record<number, string> = {
    400: `Bad Request`,
    401: `Unauthorized`,
    403: `Forbidden`,
    404: `Not Found`,
    409: `Conflict`,
    500: `Server Error`,
    502: `Bad Gateway`,
    503: `Service Unavailable`,
  }
  return statusTexts[status] || `HTTP Error`
}

/**
 * Append JSON data to a stream with one-level array flattening.
 * Returns the number of messages written.
 */
async function appendJsonBatch(
  stream: DurableStream,
  parsed: unknown
): Promise<number> {
  const items = [...flattenJsonForAppend(parsed)]
  for (const item of items) {
    await stream.append(item)
  }
  return items.length
}

/**
 * Read all data from stdin into a Buffer.
 */
async function readStdin(): Promise<Buffer> {
  const chunks: Array<Buffer> = []

  stdin.on(`data`, (chunk) => {
    chunks.push(chunk)
  })

  await new Promise<void>((resolve, reject) => {
    stdin.on(`end`, resolve)
    stdin.on(`error`, reject)
  })

  return Buffer.concat(chunks)
}

/**
 * Process escape sequences in content string.
 */
function processEscapeSequences(content: string): string {
  return content
    .replace(/\\n/g, `\n`)
    .replace(/\\t/g, `\t`)
    .replace(/\\r/g, `\r`)
    .replace(/\\\\/g, `\\`)
}

async function writeStream(
  baseUrl: string,
  streamId: string,
  contentType: string,
  batchJson: boolean,
  headers: Record<string, string>,
  content?: string
): Promise<void> {
  const url = `${baseUrl}/v1/stream/${streamId}`
  const isJson = isJsonContentType(contentType)

  // Get the data to write - either from argument or stdin
  let data: string | Buffer
  let source: `argument` | `stdin`

  if (content) {
    data = processEscapeSequences(content)
    source = `argument`
  } else {
    data = await readStdin()
    source = `stdin`
    if (data.length === 0) {
      stderr.write(`No data received from stdin\n`)
      process.exit(1)
    }
  }

  try {
    const stream = new DurableStream({ url, headers, contentType })

    if (isJson) {
      const jsonString = typeof data === `string` ? data : data.toString(`utf8`)
      let parsed: unknown
      try {
        parsed = JSON.parse(jsonString)
      } catch {
        if (source === `argument`) {
          const preview = jsonString.slice(0, 100)
          const ellipsis = jsonString.length > 100 ? `...` : ``
          stderr.write(`Failed to parse JSON content\n`)
          stderr.write(`  Invalid JSON: ${preview}${ellipsis}\n`)
        } else {
          stderr.write(`Failed to parse JSON from stdin\n`)
          stderr.write(`  Invalid JSON input\n`)
        }
        process.exit(1)
      }

      if (batchJson) {
        const count = await appendJsonBatch(stream, parsed)
        console.log(
          `Wrote ${count} message${count !== 1 ? `s` : ``} to stream "${streamId}"`
        )
      } else {
        await stream.append(parsed)
        console.log(`Wrote 1 JSON message to stream "${streamId}"`)
      }
    } else {
      await stream.append(data)
      console.log(`Wrote ${formatBytes(data.length)} to stream "${streamId}"`)
    }
  } catch (error) {
    stderr.write(`Failed to write to stream "${streamId}"\n`)
    stderr.write(`  ${formatErrorMessage(getErrorMessage(error))}\n`)
    process.exit(1)
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 1) return `1 byte`
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function readStream(
  baseUrl: string,
  streamId: string,
  headers: Record<string, string>
) {
  const url = `${baseUrl}/v1/stream/${streamId}`

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
    stderr.write(`Failed to read stream "${streamId}"\n`)
    stderr.write(`  ${formatErrorMessage(getErrorMessage(error))}\n`)
    process.exit(1)
  }
}

async function deleteStream(
  baseUrl: string,
  streamId: string,
  headers: Record<string, string>
) {
  const url = `${baseUrl}/v1/stream/${streamId}`

  try {
    const stream = new DurableStream({ url, headers })
    await stream.delete()
    console.log(`Stream deleted successfully: ${streamId}`)
  } catch (error) {
    stderr.write(`Failed to delete stream "${streamId}"\n`)
    stderr.write(`  ${formatErrorMessage(getErrorMessage(error))}\n`)
    process.exit(1)
  }
}

async function main() {
  const rawArgs = process.argv.slice(2)

  // Handle --help / -h early, before other parsing
  if (rawArgs.includes(`--help`) || rawArgs.includes(`-h`)) {
    printUsage()
    process.exit(0)
  }

  let options: GlobalOptions
  let args: Array<string>
  let warnings: Array<string>

  try {
    const parsed = parseGlobalOptions(rawArgs)
    options = parsed.options
    args = parsed.remainingArgs
    warnings = parsed.warnings
  } catch (error) {
    stderr.write(`Error: ${getErrorMessage(error)}\n`)
    process.exit(1)
  }

  // Print any warnings
  for (const warning of warnings) {
    stderr.write(`${warning}\n`)
  }

  const headers = buildHeaders(options)

  if (args.length < 1) {
    stderr.write(`Error: No command specified\n`)
    printUsage()
    process.exit(1)
  }

  const command = args[0]

  // Helper to validate and get stream ID
  function getStreamId(): string {
    if (args.length < 2) {
      stderr.write(`Error: Missing stream_id\n`)
      stderr.write(`  Usage: durable-stream ${command} <stream_id>\n`)
      process.exit(1)
    }
    const streamId = args[1]!
    const validation = validateStreamId(streamId)
    if (!validation.valid) {
      stderr.write(`Error: ${validation.error}\n`)
      process.exit(1)
    }
    return streamId
  }

  switch (command) {
    case `create`: {
      const streamId = getStreamId()
      await createStream(options.url!, streamId, headers)
      break
    }

    case `write`: {
      const streamId = getStreamId()

      let parsed: ParsedWriteArgs
      try {
        parsed = parseWriteArgs(args.slice(2))
      } catch (error) {
        stderr.write(`Error: ${getErrorMessage(error)}\n`)
        process.exit(1)
      }

      const hasContent = parsed.content || !stdin.isTTY
      if (hasContent) {
        await writeStream(
          options.url!,
          streamId,
          parsed.contentType,
          parsed.batchJson,
          headers,
          parsed.content || undefined
        )
      } else {
        stderr.write(`Error: No content provided\n`)
        stderr.write(`  Provide content as an argument or pipe from stdin:\n`)
        stderr.write(
          `    durable-stream write ${streamId} "your content here"\n`
        )
        stderr.write(`    echo "content" | durable-stream write ${streamId}\n`)
        process.exit(1)
      }
      break
    }

    case `read`: {
      const streamId = getStreamId()
      await readStream(options.url!, streamId, headers)
      break
    }

    case `delete`: {
      const streamId = getStreamId()
      await deleteStream(options.url!, streamId, headers)
      break
    }

    default:
      stderr.write(`Error: Unknown command "${command}"\n`)
      stderr.write(`  Available commands: create, write, read, delete\n`)
      stderr.write(`  Run "durable-stream --help" for usage information\n`)
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
    stderr.write(`Fatal error: ${getErrorMessage(error)}\n`)
    process.exit(1)
  })
}
