#!/usr/bin/env node

import { resolve as resolvePath } from "node:path"
import { stderr, stdin, stdout } from "node:process"
import { fileURLToPath } from "node:url"
import { DurableStream } from "@durable-streams/client"
import { flattenJsonForAppend, isJsonContentType } from "./jsonUtils.js"
import { parseWriteArgs } from "./parseWriteArgs.js"
import type { ParsedWriteArgs } from "./parseWriteArgs.js"

export type { ParsedWriteArgs }
export { flattenJsonForAppend, isJsonContentType, parseWriteArgs }

const STREAM_URL = process.env.STREAM_URL || `http://localhost:4437`

function printUsage() {
  console.error(`
Usage:
  durable-stream create <stream_id>              Create a new stream
  durable-stream write <stream_id> <content>     Write content to a stream
  cat file.txt | durable-stream write <stream_id>    Write stdin to a stream
  durable-stream read <stream_id>                Follow a stream and write to stdout
  durable-stream delete <stream_id>              Delete a stream

Write Options:
  --content-type <type>   Content-Type for the message (default: application/octet-stream)
  --json                  Write as JSON (input stored as single message)
  --batch-json            Write as JSON array of messages (each array element stored separately)

Environment Variables:
  STREAM_URL    Base URL of the stream server (default: http://localhost:4437)
`)
}

async function createStream(streamId: string) {
  const url = `${STREAM_URL}/v1/stream/${streamId}`

  try {
    await DurableStream.create({
      url,
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
  content?: string
) {
  const url = `${STREAM_URL}/v1/stream/${streamId}`
  const isJson = isJsonContentType(contentType)

  try {
    const stream = new DurableStream({ url, contentType })

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

async function readStream(streamId: string) {
  const url = `${STREAM_URL}/v1/stream/${streamId}`

  try {
    const stream = new DurableStream({ url })

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

async function deleteStream(streamId: string) {
  const url = `${STREAM_URL}/v1/stream/${streamId}`

  try {
    const stream = new DurableStream({ url })
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
  const args = process.argv.slice(2)

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
      await createStream(args[1]!)
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
        await writeStream(streamId, parsed.contentType, parsed.batchJson)
      } else if (parsed.content) {
        // Content provided as argument
        await writeStream(
          streamId,
          parsed.contentType,
          parsed.batchJson,
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
      await readStream(args[1]!)
      break
    }

    case `delete`: {
      if (args.length < 2) {
        stderr.write(`Error: stream_id required\n`)
        printUsage()
        process.exit(1)
      }
      await deleteStream(args[1]!)
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
