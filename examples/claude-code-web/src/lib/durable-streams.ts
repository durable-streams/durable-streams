import { DurableStream } from "@durable-streams/client"
import { getSessionStreams } from "./types"

// Durable Streams client wrapper for terminal I/O

export interface StreamClient {
  input: DurableStream
  output: DurableStream
}

// Create stream clients for a session
export function createStreamClient(
  sessionId: string,
  baseUrl: string
): StreamClient {
  const streams = getSessionStreams(sessionId)

  const input = new DurableStream({
    url: `${baseUrl}/v1/stream/${streams.input}`,
  })

  const output = new DurableStream({
    url: `${baseUrl}/v1/stream/${streams.output}`,
  })

  return { input, output }
}

// Ensure streams exist for a session (called on session creation)
export async function ensureSessionStreams(
  sessionId: string,
  baseUrl: string
): Promise<void> {
  const streams = getSessionStreams(sessionId)

  // Create input stream (user keystrokes)
  await fetch(`${baseUrl}/v1/stream/${streams.input}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
    },
  })

  // Create output stream (PTY output)
  await fetch(`${baseUrl}/v1/stream/${streams.output}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
    },
  })
}

// Append data to input stream
export async function appendToInputStream(
  sessionId: string,
  baseUrl: string,
  data: Uint8Array
): Promise<void> {
  const streams = getSessionStreams(sessionId)
  await fetch(`${baseUrl}/v1/stream/${streams.input}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: data,
  })
}

// Append data to output stream (called from sandbox bridge)
export async function appendToOutputStream(
  sessionId: string,
  baseUrl: string,
  data: Uint8Array
): Promise<void> {
  const streams = getSessionStreams(sessionId)
  await fetch(`${baseUrl}/v1/stream/${streams.output}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: data,
  })
}

// Create a reader for the output stream with SSE for live updates
export function createOutputReader(
  sessionId: string,
  baseUrl: string,
  offset?: string
): ReadableStream<Uint8Array> {
  const streams = getSessionStreams(sessionId)
  const url = new URL(`${baseUrl}/v1/stream/${streams.output}`)
  if (offset) {
    url.searchParams.set("offset", offset)
  }
  url.searchParams.set("live", "sse")

  // Return a readable stream that consumes SSE events
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "text/event-stream",
        },
      })

      if (!response.ok) {
        controller.error(new Error(`Failed to connect: ${response.status}`))
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        controller.error(new Error("No response body"))
        return
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

// Create a reader for the input stream (used by sandbox bridge)
export function createInputReader(
  sessionId: string,
  baseUrl: string,
  offset?: string
): ReadableStream<Uint8Array> {
  const streams = getSessionStreams(sessionId)
  const url = new URL(`${baseUrl}/v1/stream/${streams.input}`)
  if (offset) {
    url.searchParams.set("offset", offset)
  }
  url.searchParams.set("live", "sse")

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "text/event-stream",
        },
      })

      if (!response.ok) {
        controller.error(new Error(`Failed to connect: ${response.status}`))
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        controller.error(new Error("No response body"))
        return
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}
