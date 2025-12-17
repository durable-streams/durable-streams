import type { WikipediaRawEvent } from "./types.js"

const WIKIPEDIA_SSE_URL = `https://stream.wikimedia.org/v2/stream/recentchange`

export class WikipediaStreamClient {
  private abortController: AbortController | null = null
  private onEvent: (event: WikipediaRawEvent) => void
  private onError?: (error: Error) => void
  private reconnectAttempts = 0
  private maxReconnectDelay = 30000 // 30 seconds
  private isManuallyDisconnected = false

  constructor(callbacks: {
    onEvent: (event: WikipediaRawEvent) => void
    onError?: (error: Error) => void
  }) {
    this.onEvent = callbacks.onEvent
    this.onError = callbacks.onError
  }

  async connect(): Promise<void> {
    this.isManuallyDisconnected = false

    console.log(`[WikipediaClient] Connecting to Wikipedia EventStreams...`)
    console.log(`[WikipediaClient] URL:`, WIKIPEDIA_SSE_URL)

    this.abortController = new AbortController()
    let healthInterval: NodeJS.Timeout | undefined

    try {
      const response = await fetch(WIKIPEDIA_SSE_URL, {
        headers: {
          Accept: `text/event-stream`,
        },
        signal: this.abortController.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      if (!response.body) {
        throw new Error(`Response body is null`)
      }

      console.log(`[WikipediaClient] Connected to Wikipedia EventStreams`)
      this.reconnectAttempts = 0

      // Process the stream
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ``
      let eventCount = 0
      let lastEventTime = Date.now()

      // Log stream health periodically
      healthInterval = setInterval(() => {
        const timeSinceLastEvent = Date.now() - lastEventTime
        console.log(
          `[WikipediaClient] Health: ${eventCount} events total, last event: ${(timeSinceLastEvent / 1000).toFixed(1)}s ago`
        )
      }, 15000)

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (!this.isManuallyDisconnected) {
        const { done, value } = await reader.read()

        if (done) {
          console.log(`[WikipediaClient] Stream ended`)
          clearInterval(healthInterval)
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(`\n`)
        buffer = lines.pop() || ``

        let eventType = `message`
        let eventData = ``

        for (const line of lines) {
          if (line.startsWith(`event:`)) {
            eventType = line.slice(6).trim()
          } else if (line.startsWith(`data:`)) {
            eventData = line.slice(5).trim()
          } else if (line === ``) {
            // Empty line signals end of event
            if (eventData && eventType === `message`) {
              try {
                const data: WikipediaRawEvent = JSON.parse(eventData)
                eventCount++
                lastEventTime = Date.now()
                this.onEvent(data)
              } catch (err) {
                const error =
                  err instanceof Error
                    ? err
                    : new Error(`Failed to parse event`)
                console.error(
                  `[WikipediaClient] Failed to parse event:`,
                  error.message
                )
                this.onError?.(error)
              }
            }
            eventData = ``
            eventType = `message`
          }
        }
      }
      // Clean up health interval on normal exit
      clearInterval(healthInterval)
    } catch (err) {
      // Clean up health interval on error
      if (healthInterval) {
        clearInterval(healthInterval)
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.isManuallyDisconnected) {
        return
      }

      const error =
        err instanceof Error ? err : new Error(`SSE connection error`)
      console.error(`[WikipediaClient] Connection error:`, error.message)
      this.onError?.(error)

      // Reconnect with exponential backoff
      this.reconnectWithBackoff()
    }
  }

  private reconnectWithBackoff(): void {
    this.reconnectAttempts++

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    )

    console.log(
      `[WikipediaClient] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`
    )

    setTimeout(() => {
      if (!this.isManuallyDisconnected) {
        this.connect()
      }
    }, delay)
  }

  disconnect(): void {
    this.isManuallyDisconnected = true
    if (this.abortController) {
      console.log(`[WikipediaClient] Disconnecting from Wikipedia EventStreams`)
      this.abortController.abort()
      this.abortController = null
    }
  }

  isConnected(): boolean {
    return this.abortController !== null && !this.abortController.signal.aborted
  }
}
