import { Agent } from "@mariozechner/pi-agent-core"
import { getModel } from "@mariozechner/pi-ai"
import { webSearchTool } from "../tools/web-search"
import { fetchUrlTool } from "../tools/fetch-url"
import { taskStateSchema } from "../../lib/schema"
import type { AgentEvent } from "@mariozechner/pi-agent-core"
import type { AgentAdapter, AgentAdapterOptions } from "./types"

export function createPiAgentAdapter(
  options: AgentAdapterOptions
): AgentAdapter {
  const { handle, streamPath, epoch } = options
  const shortName = streamPath.split(`/`).pop()!

  let messageIndex = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let running = false
  let disposed = false

  const model = getModel(`anthropic`, `claude-sonnet-4-5-20250929`)

  const agent = new Agent({
    initialState: {
      systemPrompt: `You are a helpful assistant with web search and URL fetching capabilities. Use web_search to find current information, then fetch_url to read full pages when you need more detail. Be concise and informative. The current year is 2026`,
      model,
      tools: [webSearchTool, fetchUrlTool] as any,
      messages: [],
    },
  })

  function eventId(suffix: string): string {
    return `${shortName}-${suffix}-${epoch}-${messageIndex}-${Date.now()}`
  }

  async function writeEvent(event: Record<string, unknown>): Promise<void> {
    if (disposed) return
    await handle.append(
      JSON.stringify(taskStateSchema.events.insert({ value: event as any }))
    )
  }

  function processAgentEvents(
    resolveWhenDone: () => void,
    rejectOnError: (err: Error) => void
  ): () => void {
    const eventQueue: Array<AgentEvent> = []
    let processing = false
    let done = false

    const processQueue = async () => {
      if (processing || eventQueue.length === 0) return
      processing = true

      while (eventQueue.length > 0) {
        const event = eventQueue.shift()!

        try {
          switch (event.type) {
            case `message_update`: {
              const assistantEvent = (event as any).assistantMessageEvent
              if (assistantEvent?.type === `text_delta`) {
                await writeEvent({
                  id: eventId(`text`),
                  type: `llm_text`,
                  text: assistantEvent.delta,
                  messageIndex,
                  timestamp: Date.now(),
                })
              }
              break
            }

            case `tool_execution_start`:
              await writeEvent({
                id: eventId(`tool-start-${event.toolCallId}`),
                type: `tool_call`,
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                args: event.args,
                messageIndex,
                timestamp: Date.now(),
              })
              break

            case `tool_execution_end`:
              await writeEvent({
                id: eventId(`tool-end-${event.toolCallId}`),
                type: `tool_result`,
                toolCallId: event.toolCallId,
                result:
                  typeof event.result === `string`
                    ? event.result
                    : JSON.stringify(event.result),
                isError: (event as any).isError ?? false,
                messageIndex,
                timestamp: Date.now(),
              })
              break

            case `message_end`: {
              const msg = (event as any).message
              if (msg?.usage) {
                totalInputTokens += msg.usage.input || 0
                totalOutputTokens += msg.usage.output || 0
              }
              break
            }

            case `agent_end`:
              await writeEvent({
                id: eventId(`done`),
                type: `agent_done`,
                result: `Response complete`,
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                timestamp: Date.now(),
              })
              messageIndex++
              done = true
              break
          }
        } catch (err) {
          rejectOnError(err as Error)
          return
        }
      }

      processing = false
      if (done) {
        running = false
        resolveWhenDone()
      }
    }

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      eventQueue.push(event)
      processQueue()
    })

    return unsubscribe
  }

  return {
    async processMessage(message: string): Promise<void> {
      running = true

      await writeEvent({
        id: eventId(`started`),
        type: `agent_started`,
        epoch,
        timestamp: Date.now(),
      })

      return new Promise<void>((resolve, reject) => {
        const unsubscribe = processAgentEvents(
          () => {
            unsubscribe()
            resolve()
          },
          (err) => {
            unsubscribe()
            reject(err)
          }
        )

        // prompt() preserves conversation history and starts a new loop.
        // followUp() only works mid-execution (queues to a dead loop otherwise).
        const action = agent.prompt(message)

        // agent.prompt returns void in pi-agent-core;
        // the agent_end event signals completion via the subscription
        Promise.resolve(action).catch(async (err) => {
          running = false
          await writeEvent({
            id: eventId(`error`),
            type: `agent_error`,
            error: err instanceof Error ? err.message : `Unknown error`,
            timestamp: Date.now(),
          })
          unsubscribe()
          reject(err)
        })
      })
    },

    steer(message: string): void {
      agent.steer({
        role: `user`,
        content: [{ type: `text`, text: message }],
        timestamp: Date.now(),
      })
    },

    isRunning(): boolean {
      return running
    },

    dispose(): void {
      disposed = true
    },
  }
}
