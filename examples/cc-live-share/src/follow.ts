/**
 * cods follow: read a shared CC session from a Durable Stream and render it.
 */

import { renderEntry } from "./render.js"

interface FollowOptions {
  streamUrl: string
  fromBeginning?: boolean
}

export async function follow(options: FollowOptions): Promise<void> {
  const { streamUrl, fromBeginning } = options

  console.log(`Following session at ${streamUrl}...`)

  // Determine starting offset
  const startOffset = fromBeginning ? `-1` : `compact`

  // Resolve checkpoint (or get -1 fallback)
  let readUrl: string
  if (startOffset === `compact`) {
    // Try to resolve the compact checkpoint via redirect
    const checkpointRes = await fetch(`${streamUrl}?offset=compact`, {
      redirect: `manual`,
    })

    if (checkpointRes.status === 307) {
      const location = checkpointRes.headers.get(`location`)!
      // Location is a relative path like /cc/xxx?offset=123_456
      // We need to resolve it against the stream URL
      readUrl = new URL(location, streamUrl).toString()
      console.log(`Reading from latest checkpoint...`)
    } else {
      // No redirect — server doesn't support checkpoints or something went wrong
      // Fall back to reading from beginning
      readUrl = `${streamUrl}?offset=-1`
      console.log(`No checkpoint found, reading from beginning...`)
    }
  } else {
    readUrl = `${streamUrl}?offset=-1`
    console.log(`Reading from beginning...`)
  }

  // Catch-up read first
  const catchupRes = await fetch(readUrl)
  if (catchupRes.status === 404) {
    console.error(`Stream not found: ${streamUrl}`)
    process.exit(1)
  }
  if (!catchupRes.ok) {
    console.error(
      `Error reading stream: ${catchupRes.status} ${catchupRes.statusText}`
    )
    process.exit(1)
  }

  // Parse and render the catch-up data
  const nextOffset = catchupRes.headers.get(`stream-next-offset`)
  const isClosed = catchupRes.headers.get(`stream-closed`) === `true`
  const body = await catchupRes.text()

  if (body.trim()) {
    try {
      const entries = JSON.parse(body)
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const output = renderEntry(entry)
          if (output) process.stdout.write(output)
        }
      }
    } catch {
      // Not JSON — print raw
      process.stdout.write(body)
    }
  }

  if (isClosed) {
    console.log(`\n── Session ended ──`)
    process.exit(0)
  }

  if (!nextOffset) {
    console.error(`No Stream-Next-Offset header in response`)
    process.exit(1)
  }

  // Switch to SSE for live tailing
  console.log(`\n[live tailing...]\n`)
  await tailSSE(streamUrl, nextOffset)
}

async function tailSSE(streamUrl: string, startOffset: string): Promise<void> {
  let offset = startOffset

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    try {
      const sseUrl = `${streamUrl}?offset=${encodeURIComponent(offset)}&live=sse`
      const controller = new AbortController()
      const res = await fetch(sseUrl, {
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        console.error(`SSE connection error: ${res.status}`)
        await sleep(1000)
        continue
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ``

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const events = parseSSEBuffer(buffer)
        buffer = events.remaining

        for (const event of events.events) {
          if (event.type === `data`) {
            // Parse JSON array of entries
            try {
              const entries = JSON.parse(event.data)
              if (Array.isArray(entries)) {
                for (const entry of entries) {
                  const output = renderEntry(entry)
                  if (output) process.stdout.write(output)
                }
              }
            } catch {
              // Not parseable — skip
            }
          } else if (event.type === `control`) {
            try {
              const ctrl = JSON.parse(event.data)
              if (ctrl.streamNextOffset) {
                offset = ctrl.streamNextOffset
              }
              if (ctrl.streamClosed) {
                console.log(`\n── Session ended ──`)
                process.exit(0)
              }
            } catch {
              // Skip invalid control events
            }
          }
        }
      }

      // Connection closed by server (normal SSE cycle)
      // Reconnect from last offset
    } catch (err: unknown) {
      if (err instanceof Error && err.name === `AbortError`) {
        return
      }
      console.error(`[reconnecting...]`)
      await sleep(1000)
    }
  }
}

interface SSEEvent {
  type: string
  data: string
}

function parseSSEBuffer(buffer: string): {
  events: Array<SSEEvent>
  remaining: string
} {
  const events: Array<SSEEvent> = []
  const blocks = buffer.split(`\n\n`)

  // Last block might be incomplete
  const remaining = blocks.pop() ?? ``

  for (const block of blocks) {
    if (!block.trim()) continue
    let eventType = `data`
    const dataLines: Array<string> = []

    for (const line of block.split(`\n`)) {
      if (line.startsWith(`event:`)) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith(`data:`)) {
        dataLines.push(line.slice(5))
      }
    }

    if (dataLines.length > 0) {
      events.push({ type: eventType, data: dataLines.join(`\n`) })
    }
  }

  return { events, remaining }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
