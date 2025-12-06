#!/usr/bin/env node

import { stderr, stdin, stdout } from "node:process"
import { DurableStream } from "@durable-streams/writer"

const STREAM_URL = process.env.STREAM_URL || `http://localhost:8787`

function printUsage() {
  console.error(`
Usage:
  durable-stream create <stream_id>              Create a new stream
  durable-stream write <stream_id> <content>     Write content to a stream
  cat file.txt | durable-stream write <stream_id>    Write stdin to a stream
  durable-stream read <stream_id>                Follow a stream and write to stdout
  durable-stream delete <stream_id>              Delete a stream

Environment Variables:
  STREAM_URL    Base URL of the stream server (default: http://localhost:8787)
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

async function writeStream(streamId: string, content?: string) {
  const url = `${STREAM_URL}/v1/stream/${streamId}`

  try {
    const stream = new DurableStream({ url })

    if (content) {
      // Write provided content, interpreting escape sequences
      const processedContent = content
        .replace(/\\n/g, `\n`)
        .replace(/\\t/g, `\t`)
        .replace(/\\r/g, `\r`)
        .replace(/\\\\/g, `\\`)
      await stream.append(processedContent)
      console.log(`Wrote ${processedContent.length} bytes to ${streamId}`)
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
      await stream.append(data)
      console.log(`Wrote ${data.length} bytes to ${streamId}`)
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
    // Default behavior: catch-up first, then auto-select live mode
    for await (const chunk of stream.read()) {
      if (chunk.data.length > 0) {
        stdout.write(chunk.data)
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
      const content = args.slice(2).join(` `)

      // Check if stdin is being piped
      if (!stdin.isTTY) {
        // Reading from stdin
        await writeStream(streamId)
      } else if (content) {
        // Content provided as argument
        await writeStream(streamId, content)
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

main().catch((error) => {
  stderr.write(`Fatal error: ${error.message}\n`)
  process.exit(1)
})
