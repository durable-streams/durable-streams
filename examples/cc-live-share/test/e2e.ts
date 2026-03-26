#!/usr/bin/env npx tsx

/**
 * End-to-end test: start server, share a CC session, follow it.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"
import { renderEntry } from "../src/render.js"
import {
  findLastCompactionBoundary,
  readLinesFromOffset,
} from "../src/session.js"

// Use the real CC session file with compaction
const REAL_SESSION_PATH = path.join(
  os.homedir(),
  `.claude/projects/-Users-kevin-Desktop/b5608c6e-152c-4e3f-a4b6-fc3164c4980f.jsonl`
)

async function main() {
  // Check if the real session file exists
  if (!fs.existsSync(REAL_SESSION_PATH)) {
    console.error(`Real session file not found: ${REAL_SESSION_PATH}`)
    console.error(`This test requires a real CC session file with compaction.`)
    process.exit(1)
  }

  console.log(`=== Starting test server ===`)
  const server = new DurableStreamTestServer({
    port: 0,
    checkpointRules: [
      {
        name: `compact`,
        conditions: [
          { path: `.type`, value: `system` },
          { path: `.subtype`, value: `compact_boundary` },
        ],
      },
    ],
  })
  await server.start()
  const baseUrl = server.url
  console.log(`Server running at ${baseUrl}`)

  try {
    // === SHARE PHASE ===
    console.log(`\n=== Share phase: reading JSONL and appending to stream ===`)

    const sessionId = `b5608c6e-152c-4e3f-a4b6-fc3164c4980f`
    const streamUrl = `${baseUrl}/cc/${sessionId}`

    // Create stream
    await DurableStream.create({
      url: streamUrl,
      contentType: `application/json`,
    })
    console.log(`Created stream at ${streamUrl}`)

    // Find compaction boundary
    const startOffset = findLastCompactionBoundary(REAL_SESSION_PATH)
    console.log(`Compaction boundary at byte offset: ${startOffset}`)

    // Read lines from boundary
    const { lines } = readLinesFromOffset(REAL_SESSION_PATH, startOffset)
    console.log(`Read ${lines.length} lines from compaction boundary`)

    // Append to stream
    const stream = new DurableStream({
      url: streamUrl,
      contentType: `application/json`,
    })
    for (const line of lines) {
      await stream.append(line)
    }
    console.log(`Appended ${lines.length} entries to stream`)

    // === CHECKPOINT VERIFICATION ===
    console.log(`\n=== Verify checkpoint ===`)
    const checkpointRes = await fetch(`${streamUrl}?offset=compact`, {
      redirect: `manual`,
    })
    console.log(`Checkpoint resolution: ${checkpointRes.status}`)
    if (checkpointRes.status === 307) {
      console.log(`  Location: ${checkpointRes.headers.get(`location`)}`)
      console.log(
        `  Cache-Control: ${checkpointRes.headers.get(`cache-control`)}`
      )
    }

    // === FOLLOW PHASE ===
    console.log(`\n=== Follow phase: reading from checkpoint ===`)

    // Follow the redirect and read
    const followRes = await fetch(`${streamUrl}?offset=compact`, {
      redirect: `follow`,
    })
    console.log(`Follow response: ${followRes.status}`)

    const body = await followRes.text()
    let entries: Array<Record<string, unknown>> = []
    try {
      entries = JSON.parse(body)
    } catch {
      console.error(`Failed to parse response body as JSON`)
      console.error(body.slice(0, 500))
      process.exit(1)
    }

    console.log(`Received ${entries.length} entries after checkpoint`)

    // === RENDER PHASE ===
    console.log(`\n=== Render phase: rendering entries ===`)

    let rendered = 0
    let skipped = 0
    for (const entry of entries) {
      const output = renderEntry(entry)
      if (output) {
        process.stdout.write(output)
        rendered++
      } else {
        skipped++
      }
    }

    console.log(`\n=== Summary ===`)
    console.log(`Total entries in stream: ${lines.length}`)
    console.log(`Entries after checkpoint: ${entries.length}`)
    console.log(`Rendered: ${rendered}, Skipped: ${skipped}`)

    // === READ FROM BEGINNING ===
    console.log(`\n=== Read from beginning (no checkpoint) ===`)
    const beginRes = await fetch(`${streamUrl}?offset=-1`)
    const beginBody = await beginRes.text()
    const beginEntries = JSON.parse(beginBody)
    console.log(`Total entries from beginning: ${beginEntries.length}`)
    console.log(`(should equal ${lines.length})`)

    // === VERIFY FALLBACK FOR UNKNOWN CHECKPOINT ===
    console.log(`\n=== Unknown checkpoint fallback ===`)
    const unknownRes = await fetch(`${streamUrl}?offset=nonexistent`, {
      redirect: `manual`,
    })
    console.log(
      `Unknown checkpoint: ${unknownRes.status} → ${unknownRes.headers.get(`location`)}`
    )

    console.log(`\n=== All tests passed! ===`)
  } finally {
    await server.stop()
  }
}

main().catch((err) => {
  console.error(`Test failed:`, err)
  process.exit(1)
})
