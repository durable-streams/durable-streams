/**
 * Workload generator for testing Yjs snapshot compaction.
 *
 * Connects to a Yjs document and continuously inserts content
 * to generate enough data to trigger compaction.
 *
 * Usage:
 *   npx tsx workload.ts [roomId]
 *
 * If no roomId is provided, creates a new room.
 * Set VITE_YJS_URL, VITE_YJS_TOKEN, VITE_DS_URL, VITE_DS_TOKEN
 * in .env or as environment variables.
 */

import * as Y from "yjs"
import { config } from "dotenv"
import { YjsProvider } from "@durable-streams/y-durable-streams"
import { DurableStream } from "@durable-streams/client"

config()

const YJS_URL = process.env.VITE_YJS_URL ?? `https://localhost:4443/v1/yjs`
const YJS_TOKEN = process.env.VITE_YJS_TOKEN
const DS_URL = process.env.VITE_DS_URL ?? `https://localhost:4443/v1/stream`
const DS_TOKEN = process.env.VITE_DS_TOKEN

const yjsHeaders: Record<string, string> = YJS_TOKEN
  ? { Authorization: `Bearer ${YJS_TOKEN}` }
  : {}
const dsHeaders: Record<string, string> = DS_TOKEN
  ? { Authorization: `Bearer ${DS_TOKEN}` }
  : {}

// Trust self-signed certs for local dev
process.env.NODE_TLS_REJECT_UNAUTHORIZED = `0`

const INTERVAL_MS = 100 // insert every 100ms
const CHUNK_SIZE = 1024 // ~1KB per insert

function randomText(length: number): string {
  const chars = `abcdefghijklmnopqrstuvwxyz0123456789 `
  let result = ``
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

async function main() {
  const roomId = process.argv[2] ?? crypto.randomUUID()
  const baseUrl = `${YJS_URL}/rooms`
  const docUrl = `${baseUrl}/docs/${roomId}`

  console.log(`Room ID: ${roomId}`)
  console.log(`Yjs URL: ${docUrl}`)
  console.log(`DS URL:  ${DS_URL}`)
  console.log()

  // Create the document via PUT
  console.log(`Creating document...`)
  const createRes = await fetch(docUrl, {
    method: `PUT`,
    headers: yjsHeaders,
  })
  if (createRes.ok || createRes.status === 409) {
    console.log(`Document ready (${createRes.status})`)
  } else {
    console.error(`Failed to create document: ${createRes.status}`)
    process.exit(1)
  }

  // Also ensure registry stream exists
  const registryUrl = `${DS_URL}/__yjs_rooms`
  const registryStream = new DurableStream({
    url: registryUrl,
    headers: dsHeaders,
    contentType: `application/json`,
  })
  const headResult = await registryStream.head()
  if (!headResult.exists) {
    await DurableStream.create({
      url: registryUrl,
      headers: dsHeaders,
      contentType: `application/json`,
    })
    console.log(`Registry stream created`)
  }

  // Connect YjsProvider
  const doc = new Y.Doc()
  const provider = new YjsProvider({
    doc,
    baseUrl,
    docId: roomId,
    headers: yjsHeaders,
    connect: false,
  })

  await new Promise<void>((resolve) => {
    provider.on(`synced`, (synced) => {
      if (synced) {
        console.log(`Synced!`)
        resolve()
      }
    })
    provider.connect()
  })

  // Start generating content
  const text = doc.getText(`content`)
  let insertCount = 0
  let totalBytes = 0

  console.log(
    `\nGenerating workload (~${CHUNK_SIZE}B every ${INTERVAL_MS}ms)...`
  )
  console.log(`Press Ctrl+C to stop\n`)

  const interval = setInterval(() => {
    const chunk = randomText(CHUNK_SIZE)
    text.insert(text.length, chunk)
    insertCount++
    totalBytes += chunk.length

    if (insertCount % 10 === 0) {
      const kb = (totalBytes / 1024).toFixed(1)
      const mb = (totalBytes / (1024 * 1024)).toFixed(2)
      console.log(`Inserts: ${insertCount}, Total: ${kb}KB (${mb}MB)`)
    }
  }, INTERVAL_MS)

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\nStopping...`)
    clearInterval(interval)
    provider.destroy()
    doc.destroy()
    const mb = (totalBytes / (1024 * 1024)).toFixed(2)
    console.log(`Done. ${insertCount} inserts, ${mb}MB total`)
    process.exit(0)
  }

  process.on(`SIGINT`, shutdown)
  process.on(`SIGTERM`, shutdown)
}

main().catch((err) => {
  console.error(`Error:`, err)
  process.exit(1)
})
