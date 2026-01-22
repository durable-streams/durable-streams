/**
 * SSE parsing utilities for the durable proxy client.
 */

/**
 * Unwrap the proxy's SSE layer from a stream.
 *
 * The proxy wraps upstream responses in its own SSE format:
 * - `event: control` - contains stream metadata like offset
 * - `event: data` - contains the actual upstream data
 *
 * @param body - The proxy response body
 * @param onControl - Optional callback for control messages (e.g., to track offset)
 * @returns A ReadableStream with just the upstream content
 */
export function unwrapProxySSE(
  body: ReadableStream<Uint8Array>,
  onControl?: (data: { streamNextOffset?: string }) => void
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ``

  const processEvents = (
    events: Array<string>,
    controller: ReadableStreamDefaultController<Uint8Array>
  ) => {
    for (const event of events) {
      if (!event.trim()) continue

      const lines = event.split(`\n`)
      let eventType = ``
      const dataLines: Array<string> = []

      for (const line of lines) {
        if (line.startsWith(`event:`)) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith(`data:`)) {
          dataLines.push(line.slice(5))
        }
      }

      if (eventType === `control`) {
        // Extract offset from control messages
        if (onControl) {
          try {
            const controlData = JSON.parse(dataLines.join(`\n`).trim())
            onControl(controlData)
          } catch {
            // Ignore malformed control messages
          }
        }
      } else if (eventType === `data`) {
        // Unwrap and emit the upstream data
        // The data lines contain the original upstream content (possibly SSE)
        // Trim leading space from each line (SSE format: "data: content")
        const upstreamContent = dataLines
          .map((line) => (line.startsWith(` `) ? line.slice(1) : line))
          .join(`\n`)
        if (upstreamContent) {
          // Add newlines to maintain proper SSE format
          controller.enqueue(encoder.encode(upstreamContent + `\n`))
        }
      }
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader()

      try {
        for (;;) {
          const { done, value } = await reader.read()

          if (done) {
            // Process any remaining buffer content before closing
            if (buffer.trim()) {
              const remainingEvents = buffer.split(`\n\n`)
              processEvents(remainingEvents, controller)
            }
            controller.close()
            break
          }

          // Parse SSE events from the proxy wrapper
          buffer += decoder.decode(value, { stream: true })

          // Split into complete SSE events (separated by double newline)
          const events = buffer.split(`\n\n`)
          // Keep the last incomplete event in the buffer
          buffer = events.pop() ?? ``

          processEvents(events, controller)
        }
      } catch (error) {
        controller.error(error)
      }
    },
  })
}
