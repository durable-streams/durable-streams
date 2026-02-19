import type { DurableStream } from "@durable-streams/client"
import type { Context } from "@opentelemetry/api"

export interface AgentAdapter {
  processMessage: (message: string) => Promise<void>
  steer: (message: string) => void
  isRunning: () => boolean
  dispose: () => void
}

export interface AgentAdapterOptions {
  handle: DurableStream
  streamPath: string
  epoch: number
  parentCtx: Context
  /** Conversation history from previous wake cycles (pi-agent-core message format). */
  messages: Array<Record<string, unknown>>
}

export type CreateAgentAdapter = (options: AgentAdapterOptions) => AgentAdapter
