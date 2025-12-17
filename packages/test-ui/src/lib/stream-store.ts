import type { DurableStream } from "@durable-streams/client"

interface StreamSubscription {
  messages: Array<{ offset: string; data: string }>
  listeners: Set<() => void>
  abortController: AbortController | null
  stream: DurableStream
}

class StreamStore {
  private subscriptions = new Map<string, StreamSubscription>()
  private emptyMessages: Array<{ offset: string; data: string }> = []

  subscribe(
    streamPath: string,
    stream: DurableStream,
    listener: () => void
  ): () => void {
    // Get or create subscription
    let subscription = this.subscriptions.get(streamPath)

    if (!subscription) {
      subscription = {
        messages: [],
        listeners: new Set(),
        abortController: null,
        stream,
      }
      this.subscriptions.set(streamPath, subscription)
    }

    // Add listener
    subscription.listeners.add(listener)

    // Start following if not already
    if (!subscription.abortController) {
      const abortController = new AbortController()
      subscription.abortController = abortController
      void this.followStream(streamPath, subscription)
    }

    // Return unsubscribe function
    return () => {
      const sub = this.subscriptions.get(streamPath)
      if (!sub) return

      sub.listeners.delete(listener)

      // Keep subscription active even with no listeners
      // This ensures we never miss messages and navigating back is instant
    }
  }

  getMessages(streamPath: string): Array<{ offset: string; data: string }> {
    const subscription = this.subscriptions.get(streamPath)
    return subscription ? subscription.messages : this.emptyMessages
  }

  private async followStream(
    streamPath: string,
    subscription: StreamSubscription
  ): Promise<void> {
    try {
      // Start from last offset if we have messages, otherwise from beginning
      const startOffset =
        subscription.messages.length > 0
          ? subscription.messages[subscription.messages.length - 1].offset
          : `-1`

      const response = await subscription.stream.stream({
        offset: startOffset,
        live: `long-poll`,
        signal: subscription.abortController!.signal,
      })

      response.subscribeText(async (chunk) => {
        if (chunk.text !== ``) {
          // Create new array reference so React detects the change
          subscription.messages = [
            ...subscription.messages,
            { offset: chunk.offset, data: chunk.text },
          ]
          // Notify all listeners
          subscription.listeners.forEach((listener) => listener())
        }
      })
    } catch (err: any) {
      // Ignore abort errors - expected when navigating away or during cleanup
      const isAbortError =
        err.name === `AbortError` ||
        err.message?.includes(`aborted`) ||
        err.message?.includes(`abort`)

      if (!isAbortError) {
        console.error(`Failed to follow stream ${streamPath}:`, err.message)
      }
    }
  }
}

export const streamStore = new StreamStore()
