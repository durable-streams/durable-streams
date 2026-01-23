/**
 * Vercel AI SDK Adapter
 *
 * Transforms Vercel AI SDK streaming events into durable session writes.
 * Works with useChat and the AI SDK stream protocol.
 *
 * Event mapping:
 * - text-start/delta/end → delta inserts with partType "text"
 * - tool-input-start/available → delta inserts with partType "tool-call"
 * - tool-output-available → delta inserts with partType "tool-result"
 * - reasoning-start/delta/end → delta inserts with partType "reasoning"
 */

import type { AISession } from "../session.js"
import type { Message, Delta } from "../schema.js"

// =============================================================================
// Vercel AI SDK Types (minimal subset we need)
// =============================================================================

/**
 * Vercel AI SDK stream event types
 * Based on https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 */
export type VercelStreamEvent =
  | { type: "message-start"; id: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | {
      type: "tool-input-delta"
      toolCallId: string
      toolName: string
      delta: string
    }
  | {
      type: "tool-input-available"
      toolCallId: string
      toolName: string
      input: unknown
    }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "file"; id: string; url: string; name?: string; mimeType?: string }
  | { type: "source-url"; id: string; url: string; title?: string }
  | { type: "finish" }
  | { type: "error"; errorText: string }

// =============================================================================
// Adapter State
// =============================================================================

interface PartState {
  partIndex: number
  partType: Delta["partType"]
  seq: number
  toolCallId?: string
  toolName?: string
}

interface AdapterState {
  messageId: string
  parts: Map<string, PartState> // keyed by part id (text id, toolCallId, etc.)
  nextPartIndex: number
}

// =============================================================================
// Adapter Implementation
// =============================================================================

export interface VercelAdapterOptions {
  /** The AI session to write events to */
  session: AISession
  /** Agent ID for attribution */
  agentId: string
}

export interface VercelAdapter {
  /**
   * Start a new assistant message
   * Call this before processing stream events
   */
  startMessage(): Promise<Message>

  /**
   * Process a single Vercel AI SDK stream event
   * Transforms it into the appropriate durable session writes
   */
  processEvent(event: VercelStreamEvent): Promise<void>

  /**
   * Get the current message ID
   */
  getMessageId(): string | null
}

export function createVercelAdapter(
  options: VercelAdapterOptions
): VercelAdapter {
  const { session, agentId } = options

  let state: AdapterState | null = null

  function getOrCreatePart(
    partId: string,
    partType: Delta["partType"],
    toolCallId?: string,
    toolName?: string
  ): PartState {
    if (!state) {
      throw new Error("No active message. Call startMessage() first.")
    }

    let part = state.parts.get(partId)
    if (!part) {
      part = {
        partIndex: state.nextPartIndex++,
        partType,
        seq: 0,
        toolCallId,
        toolName,
      }
      state.parts.set(partId, part)
    }
    return part
  }

  return {
    async startMessage(): Promise<Message> {
      const message = await session.createMessage({
        role: "assistant",
        agentId,
      })

      state = {
        messageId: message.id,
        parts: new Map(),
        nextPartIndex: 0,
      }

      return message
    },

    async processEvent(event: VercelStreamEvent): Promise<void> {
      if (!state) {
        throw new Error("No active message. Call startMessage() first.")
      }

      const { messageId } = state

      switch (event.type) {
        case "message-start": {
          // Message already started, nothing to do
          break
        }

        case "text-start": {
          // Initialize text part
          getOrCreatePart(event.id, "text")
          break
        }

        case "text-delta": {
          const part = getOrCreatePart(event.id, "text")
          await session.appendDelta({
            messageId,
            partIndex: part.partIndex,
            partType: "text",
            seq: part.seq++,
            text: event.delta,
          })
          break
        }

        case "text-end": {
          const part = state.parts.get(event.id)
          if (part) {
            await session.appendDelta({
              messageId,
              partIndex: part.partIndex,
              partType: "text",
              seq: part.seq++,
              done: true,
            })
          }
          break
        }

        case "tool-input-start": {
          // Initialize tool call part
          getOrCreatePart(
            event.toolCallId,
            "tool-call",
            event.toolCallId,
            event.toolName
          )
          // Write initial delta with tool metadata
          const part = state.parts.get(event.toolCallId)!
          await session.appendDelta({
            messageId,
            partIndex: part.partIndex,
            partType: "tool-call",
            seq: part.seq++,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          })
          break
        }

        case "tool-input-delta": {
          const part = getOrCreatePart(
            event.toolCallId,
            "tool-call",
            event.toolCallId,
            event.toolName
          )
          await session.appendDelta({
            messageId,
            partIndex: part.partIndex,
            partType: "tool-call",
            seq: part.seq++,
            text: event.delta, // Tool args streamed as text
          })
          break
        }

        case "tool-input-available": {
          const part = state.parts.get(event.toolCallId)
          if (part) {
            await session.appendDelta({
              messageId,
              partIndex: part.partIndex,
              partType: "tool-call",
              seq: part.seq++,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              done: true,
            })
          }
          break
        }

        case "tool-output-available": {
          // Tool result goes into a new part
          const resultPartId = `${event.toolCallId}_result`
          const part = getOrCreatePart(resultPartId, "tool-result")
          await session.appendDelta({
            messageId,
            partIndex: part.partIndex,
            partType: "tool-result",
            seq: part.seq++,
            toolCallId: event.toolCallId,
            toolOutput: event.output,
            done: true,
          })
          break
        }

        case "reasoning-start": {
          getOrCreatePart(event.id, "reasoning")
          break
        }

        case "reasoning-delta": {
          const part = getOrCreatePart(event.id, "reasoning")
          await session.appendDelta({
            messageId,
            partIndex: part.partIndex,
            partType: "reasoning",
            seq: part.seq++,
            text: event.delta,
          })
          break
        }

        case "reasoning-end": {
          const part = state.parts.get(event.id)
          if (part) {
            await session.appendDelta({
              messageId,
              partIndex: part.partIndex,
              partType: "reasoning",
              seq: part.seq++,
              done: true,
            })
          }
          break
        }

        case "file": {
          const part = getOrCreatePart(event.id, "file")
          await session.appendDelta({
            messageId,
            partIndex: part.partIndex,
            partType: "file",
            seq: part.seq++,
            fileUrl: event.url,
            fileName: event.name,
            mimeType: event.mimeType,
            done: true,
          })
          break
        }

        case "source-url": {
          const part = getOrCreatePart(event.id, "source")
          await session.appendDelta({
            messageId,
            partIndex: part.partIndex,
            partType: "source",
            seq: part.seq++,
            sourceUrl: event.url,
            sourceTitle: event.title,
            done: true,
          })
          break
        }

        case "finish": {
          // Stream complete, nothing special to do
          // State remains for potential inspection
          break
        }

        case "error": {
          // Could add error handling - for now just log
          console.error("[VercelAdapter] Stream error:", event.errorText)
          break
        }
      }
    },

    getMessageId(): string | null {
      return state?.messageId ?? null
    },
  }
}

// =============================================================================
// Stream Processing Utilities
// =============================================================================

/**
 * Parse a Vercel AI SDK SSE line into an event object
 */
export function parseVercelSSELine(line: string): VercelStreamEvent | null {
  if (!line.startsWith("data: ")) {
    return null
  }

  const data = line.slice(6) // Remove "data: " prefix

  if (data === "[DONE]") {
    return { type: "finish" }
  }

  try {
    return JSON.parse(data) as VercelStreamEvent
  } catch {
    return null
  }
}

/**
 * Process a Vercel AI SDK SSE stream and write to durable session
 */
export async function processVercelStream(
  stream: ReadableStream<Uint8Array>,
  adapter: VercelAdapter
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    let done = false
    while (!done) {
      const result = await reader.read()
      done = result.done
      if (done) break
      const value = result.value

      buffer += decoder.decode(value, { stream: true })

      // Process complete lines
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? "" // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        const event = parseVercelSSELine(trimmed)
        if (event) {
          await adapter.processEvent(event)
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const event = parseVercelSSELine(buffer.trim())
      if (event) {
        await adapter.processEvent(event)
      }
    }
  } finally {
    reader.releaseLock()
  }
}
