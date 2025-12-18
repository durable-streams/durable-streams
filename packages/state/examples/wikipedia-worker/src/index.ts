import { DurableStream } from "@durable-streams/client"
import { WikipediaStreamClient } from "./wikipedia-client.js"
import { transformWikipediaEvent } from "./event-transformer.js"

const SERVER_URL = process.env.DURABLE_STREAMS_URL || `http://localhost:4437`
const STREAM_PATH = process.env.STREAM_PATH || `/wikipedia-events`

let eventCount = 0
let errorCount = 0
const startTime = Date.now()

/**
 * Main worker function
 * Connects to Wikipedia EventStreams and writes events to a durable stream
 */
async function main() {
  console.log(`=`.repeat(60))
  console.log(`Wikipedia EventStreams Worker`)
  console.log(`=`.repeat(60))
  console.log(`Server URL: ${SERVER_URL}`)
  console.log(`Stream Path: ${STREAM_PATH}`)
  console.log(`=`.repeat(60))

  const streamUrl = `${SERVER_URL}/v1/stream${STREAM_PATH}`

  // Create or get the durable stream
  console.log(`\n[Worker] Initializing stream at ${streamUrl}...`)

  let stream: DurableStream

  try {
    // Try to connect to existing stream
    stream = new DurableStream({
      url: streamUrl,
    })
    await stream.head()
    console.log(`[Worker] Connected to existing stream`)
  } catch {
    // Stream doesn't exist, create it
    console.log(`[Worker] Stream not found, creating new stream...`)
    await DurableStream.create({
      url: streamUrl,
      contentType: `application/json`,
    })
    stream = new DurableStream({
      url: streamUrl,
    })
    console.log(`[Worker] Stream created successfully`)
  }

  // Start Wikipedia client
  const client = new WikipediaStreamClient({
    onEvent: async (rawEvent) => {
      try {
        // Skip events without required id field
        if (rawEvent.id == null) {
          return
        }

        // Transform to state protocol format
        const stateEvent = transformWikipediaEvent(rawEvent)

        // Append to durable stream with timeout to detect hangs
        const appendPromise = stream.append(stateEvent)
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Append timeout after 5s`)), 5000)
        )

        await Promise.race([appendPromise, timeoutPromise])

        eventCount++

        // Log progress every 100 events
        if (eventCount % 100 === 0) {
          const elapsed = (Date.now() - startTime) / 1000
          const rate = (eventCount / elapsed).toFixed(2)
          console.log(
            `[Worker] Processed ${eventCount} events (${rate} events/sec, ${errorCount} errors)`
          )
        }
      } catch (err) {
        errorCount++
        const error = err instanceof Error ? err : new Error(`Unknown error`)
        console.error(`[Worker] Failed to append event:`, error.message)
        console.error(
          `[Worker] Event that failed:`,
          rawEvent.title || rawEvent.id
        )

        // Log more details for every 10th error
        if (errorCount % 10 === 0) {
          console.error(`[Worker] Error details:`, error)
          console.error(`[Worker] Stream append might be stuck or failing`)
        }
      }
    },
    onError: (error) => {
      console.error(`[Worker] Wikipedia client error:`, error.message)
    },
  })

  await client.connect()
  console.log(`[Worker] Streaming Wikipedia events...\n`)

  // Log heartbeat to verify worker is still running
  setInterval(() => {
    console.log(
      `[Worker] Heartbeat - still running, connected:`,
      client.isConnected()
    )
  }, 10000)

  // Log stats every 60 seconds
  setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000
    const rate = (eventCount / elapsed).toFixed(2)
    console.log(
      `[Worker] Stats: ${eventCount} events, ${rate} events/sec, ${errorCount} errors, ${elapsed.toFixed(0)}s uptime`
    )
  }, 60000)

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\n[Worker] Shutting down...`)
    client.disconnect()
    const elapsed = (Date.now() - startTime) / 1000
    const rate = (eventCount / elapsed).toFixed(2)
    console.log(
      `[Worker] Final stats: ${eventCount} events processed in ${elapsed.toFixed(0)}s (${rate} events/sec)`
    )
    process.exit(0)
  }

  process.on(`SIGINT`, shutdown)
  process.on(`SIGTERM`, shutdown)
}

main().catch((err) => {
  console.error(`[Worker] Fatal error:`, err)
  process.exit(1)
})
