/**
 * PromptObject: A self-contained computing environment that receives
 * and interprets messages, can modify itself, and create other objects.
 *
 * "What if an 'agent' is more than just thing that does tasks, but a
 * self-contained computing environment that can receive messages and
 * interpret them however it wants?" - Scott Werner
 */

import { DurableStream, stream } from "@durable-streams/client"
import { capabilitiesToTools } from "./llm-provider.js"
import type {
  Capability,
  CapabilityInfo,
  ConversationMessage,
  ExecutionContext,
  LLMProvider,
  Message,
  PromptObjectHandle,
  RuntimeHandle,
} from "./types.js"

/**
 * Generate a unique ID
 */
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Core PromptObject implementation
 */
export class PromptObject implements PromptObjectHandle {
  readonly id: string
  readonly name: string
  private _systemPrompt: string
  private _state: Record<string, unknown>
  private capabilities: Map<string, Capability> = new Map()
  private runtime: PromptObjectRuntime
  private inboxUrl: string
  private inboxStream: DurableStream | null = null
  private abortController: AbortController | null = null
  private conversationHistory: Array<ConversationMessage> = []

  constructor(
    options: {
      id?: string
      name: string
      systemPrompt: string
      state?: Record<string, unknown>
      capabilities?: Array<Capability>
    },
    runtime: PromptObjectRuntime
  ) {
    this.id = options.id ?? generateId()
    this.name = options.name
    this._systemPrompt = options.systemPrompt
    this._state = options.state ?? {}
    this.runtime = runtime
    this.inboxUrl = `${runtime.config.streamsBaseUrl}/${this.id}/inbox`

    // Add initial capabilities
    if (options.capabilities) {
      for (const cap of options.capabilities) {
        this.capabilities.set(cap.name, cap)
      }
    }

    // Add core capabilities that every object has
    this.addCoreCapabilities()
  }

  /**
   * Add the core capabilities every prompt object has:
   * - think: reflect and reason
   * - modify_self: add/remove capabilities, update system prompt
   * - create_object: spawn new objects
   * - send_message: communicate with other objects
   * - query_capabilities: discover what primitives are available
   */
  private addCoreCapabilities(): void {
    // Think - internal reasoning
    this.capabilities.set(`think`, {
      name: `think`,
      description:
        `Think through a problem step by step. Use this to reason about what you need to do, ` +
        `what capabilities you might need, or how to interpret a message. The thought is private ` +
        `and not sent to anyone.`,
      parameters: {
        type: `object`,
        properties: {
          thought: {
            type: `string`,
            description: `Your internal thought or reasoning`,
          },
        },
        required: [`thought`],
      },
      execute: async (params) => {
        // Thinking is just logged, not sent anywhere
        return { thought: params.thought }
      },
    })

    // Query available primitives
    this.capabilities.set(`query_primitives`, {
      name: `query_primitives`,
      description:
        `Query the runtime for available primitive capabilities that can be added to yourself. ` +
        `Returns a list of capabilities from the standard library that you can use add_capability to acquire.`,
      parameters: {
        type: `object`,
        properties: {},
      },
      execute: async (_params, context) => {
        const primitives = context.runtime.getAvailablePrimitives()
        return {
          primitives: primitives.map((p) => ({
            name: p.name,
            description: p.description,
            parameters: p.parameters,
          })),
        }
      },
    })

    // Add capability to self
    this.capabilities.set(`add_capability`, {
      name: `add_capability`,
      description:
        `Add a capability to yourself from the available primitives. ` +
        `First use query_primitives to see what's available, then use this to add what you need.`,
      parameters: {
        type: `object`,
        properties: {
          capability_name: {
            type: `string`,
            description: `The name of the primitive capability to add`,
          },
        },
        required: [`capability_name`],
      },
      execute: async (params, context) => {
        const name = params.capability_name as string
        const primitives = context.runtime.getAvailablePrimitives()
        const primitive = this.runtime.getPrimitive(name)

        if (!primitive) {
          return {
            success: false,
            error: `No primitive found with name "${name}". Available: ${primitives.map((p) => p.name).join(`, `)}`,
          }
        }

        context.self.addCapability(primitive)
        return {
          success: true,
          message: `Added capability "${name}" to yourself`,
        }
      },
    })

    // Remove capability
    this.capabilities.set(`remove_capability`, {
      name: `remove_capability`,
      description: `Remove a capability from yourself (cannot remove core capabilities).`,
      parameters: {
        type: `object`,
        properties: {
          capability_name: {
            type: `string`,
            description: `The name of the capability to remove`,
          },
        },
        required: [`capability_name`],
      },
      execute: async (params, context) => {
        const name = params.capability_name as string
        const coreCapabilities = [
          `think`,
          `query_primitives`,
          `add_capability`,
          `remove_capability`,
          `update_system_prompt`,
          `create_object`,
          `send_message`,
          `list_objects`,
          `get_state`,
          `set_state`,
        ]

        if (coreCapabilities.includes(name)) {
          return {
            success: false,
            error: `Cannot remove core capability "${name}"`,
          }
        }

        context.self.removeCapability(name)
        return {
          success: true,
          message: `Removed capability "${name}"`,
        }
      },
    })

    // Update system prompt (modify identity)
    this.capabilities.set(`update_system_prompt`, {
      name: `update_system_prompt`,
      description:
        `Update your own system prompt. This changes your identity and base behavior. ` +
        `Use carefully - this is a fundamental modification to who you are.`,
      parameters: {
        type: `object`,
        properties: {
          new_prompt: {
            type: `string`,
            description: `The new system prompt`,
          },
          append: {
            type: `boolean`,
            description: `If true, append to existing prompt instead of replacing`,
          },
        },
        required: [`new_prompt`],
      },
      execute: async (params, context) => {
        const newPrompt = params.new_prompt as string
        const append = params.append as boolean | undefined

        if (append) {
          context.self.setSystemPrompt(
            context.self.getSystemPrompt() + `\n\n` + newPrompt
          )
        } else {
          context.self.setSystemPrompt(newPrompt)
        }

        return {
          success: true,
          message: append
            ? `Appended to system prompt`
            : `Replaced system prompt`,
        }
      },
    })

    // Create new object
    this.capabilities.set(`create_object`, {
      name: `create_object`,
      description:
        `Create a new prompt object. The new object will have its own inbox and can receive messages. ` +
        `You define its identity through the system prompt.`,
      parameters: {
        type: `object`,
        properties: {
          name: {
            type: `string`,
            description: `A human-readable name for the new object`,
          },
          system_prompt: {
            type: `string`,
            description: `The system prompt defining the object's identity, purpose, and behavior`,
          },
        },
        required: [`name`, `system_prompt`],
      },
      execute: async (params, context) => {
        const obj = await context.runtime.createObject({
          name: params.name as string,
          systemPrompt: params.system_prompt as string,
        })

        return {
          success: true,
          object_id: obj.id,
          object_name: obj.name,
          message: `Created new object "${obj.name}" with id ${obj.id}`,
        }
      },
    })

    // Send message to another object
    this.capabilities.set(`send_message`, {
      name: `send_message`,
      description:
        `Send a natural language message to another prompt object. ` +
        `The receiving object will interpret the message however it sees fit.`,
      parameters: {
        type: `object`,
        properties: {
          to: {
            type: `string`,
            description: `The ID of the object to send the message to`,
          },
          content: {
            type: `string`,
            description: `The natural language message content`,
          },
          await_reply: {
            type: `boolean`,
            description: `If true, wait for and return the reply`,
          },
        },
        required: [`to`, `content`],
      },
      execute: async (params, context) => {
        const to = params.to as string
        const content = params.content as string
        const awaitReply = params.await_reply as boolean | undefined

        await context.runtime.send(to, content, {
          metadata: { from: context.self.id },
          awaitReply,
        })

        return {
          success: true,
          message: `Sent message to ${to}`,
        }
      },
    })

    // List all objects
    this.capabilities.set(`list_objects`, {
      name: `list_objects`,
      description: `List all prompt objects in the runtime, including their IDs, names, and capabilities.`,
      parameters: {
        type: `object`,
        properties: {},
      },
      execute: async (_params, context) => {
        const objects = context.runtime.listObjects()
        return { objects }
      },
    })

    // Get state
    this.capabilities.set(`get_state`, {
      name: `get_state`,
      description: `Get your current state (persistent key-value storage).`,
      parameters: {
        type: `object`,
        properties: {
          key: {
            type: `string`,
            description: `Optional: specific key to retrieve. If omitted, returns all state.`,
          },
        },
      },
      execute: async (params, context) => {
        const key = params.key as string | undefined
        const state = context.self.getState()

        if (key) {
          return { [key]: state[key] }
        }
        return { state }
      },
    })

    // Set state
    this.capabilities.set(`set_state`, {
      name: `set_state`,
      description: `Update your state (persistent key-value storage).`,
      parameters: {
        type: `object`,
        properties: {
          key: {
            type: `string`,
            description: `The key to set`,
          },
          value: {
            description: `The value to store (can be any JSON value)`,
          },
        },
        required: [`key`, `value`],
      },
      execute: async (params, context) => {
        const key = params.key as string
        const value = params.value
        const state = context.self.getState()
        state[key] = value
        context.self.setState(state)

        return {
          success: true,
          message: `Set state.${key}`,
        }
      },
    })
  }

  // PromptObjectHandle implementation

  addCapability(capability: Capability): void {
    this.capabilities.set(capability.name, capability)
  }

  removeCapability(name: string): void {
    this.capabilities.delete(name)
  }

  listCapabilities(): Array<CapabilityInfo> {
    return Array.from(this.capabilities.values()).map((cap) => ({
      name: cap.name,
      description: cap.description,
      parameters: cap.parameters,
    }))
  }

  getSystemPrompt(): string {
    return this._systemPrompt
  }

  setSystemPrompt(prompt: string): void {
    this._systemPrompt = prompt
  }

  getState(): Record<string, unknown> {
    return this._state
  }

  setState(state: Record<string, unknown>): void {
    this._state = state
  }

  /**
   * Start listening for messages on the inbox stream
   */
  async start(): Promise<void> {
    // Create the inbox stream
    this.inboxStream = await DurableStream.create({
      url: this.inboxUrl,
      headers: this.runtime.config.streamHeaders,
      contentType: `application/json`,
    })

    this.abortController = new AbortController()

    // Start listening for messages
    this.listen()
  }

  /**
   * Listen for incoming messages
   */
  private async listen(): Promise<void> {
    try {
      const res = await stream<Message>({
        url: this.inboxUrl,
        headers: this.runtime.config.streamHeaders,
        live: true,
        signal: this.abortController?.signal,
      })

      res.subscribeJson(async (batch) => {
        for (const message of batch.items) {
          await this.handleMessage(message)
        }
      })
    } catch (error) {
      if ((error as Error).name !== `AbortError`) {
        console.error(`[${this.name}] Error listening for messages:`, error)
      }
    }
  }

  /**
   * Handle an incoming message - this is where the magic happens.
   * The message is interpreted by the LLM, which decides what to do.
   */
  async handleMessage(message: Message): Promise<void> {
    console.log(
      `[${this.name}] Received message from ${message.from}: ${message.content}`
    )

    // Add the message to conversation history
    this.conversationHistory.push({
      role: `user`,
      content: `[Message from ${message.from}]: ${message.content}`,
    })

    // Build the full context including capabilities
    const capabilities = this.listCapabilities()
    const tools = capabilitiesToTools(capabilities)

    // Create execution context
    const context: ExecutionContext = {
      self: this,
      message,
      runtime: this.runtime,
    }

    // Let the LLM interpret the message and decide what to do
    let continueProcessing = true
    let iterations = 0
    const maxIterations = 20 // Prevent infinite loops

    while (continueProcessing && iterations < maxIterations) {
      iterations++

      const result = await this.runtime.config.llmProvider.complete({
        system: this.buildSystemPrompt(),
        messages: this.conversationHistory,
        tools,
        maxTokens: this.runtime.config.defaultMaxTokens,
      })

      if (result.content) {
        // LLM has something to say
        this.conversationHistory.push({
          role: `assistant`,
          content: result.content,
        })
        console.log(`[${this.name}] Response: ${result.content}`)
      }

      if (result.toolCalls && result.toolCalls.length > 0) {
        // Execute each tool call
        for (const toolCall of result.toolCalls) {
          const capability = this.capabilities.get(toolCall.name)

          if (!capability) {
            // Unknown capability
            this.conversationHistory.push({
              role: `tool_result`,
              toolUseId: toolCall.id,
              content: JSON.stringify({
                error: `Unknown capability: ${toolCall.name}`,
              }),
            })
            continue
          }

          console.log(
            `[${this.name}] Executing ${toolCall.name}:`,
            JSON.stringify(toolCall.input)
          )

          try {
            const execResult = await capability.execute(toolCall.input, context)
            this.conversationHistory.push({
              role: `tool_result`,
              toolUseId: toolCall.id,
              content: JSON.stringify(execResult),
            })
            console.log(
              `[${this.name}] ${toolCall.name} result:`,
              JSON.stringify(execResult)
            )
          } catch (error) {
            this.conversationHistory.push({
              role: `tool_result`,
              toolUseId: toolCall.id,
              content: JSON.stringify({
                error: (error as Error).message,
              }),
            })
          }
        }
      }

      // Continue if there were tool calls, stop if end_turn or max_tokens
      continueProcessing = result.stopReason === `tool_use`
    }
  }

  /**
   * Build the full system prompt including capability information
   */
  private buildSystemPrompt(): string {
    const capabilities = this.listCapabilities()
    const capabilityList = capabilities
      .map((c) => `- ${c.name}: ${c.description}`)
      .join(`\n`)

    return `${this._systemPrompt}

## Your Capabilities

You have the following capabilities available:

${capabilityList}

## How to Operate

1. When you receive a message, interpret it in natural language. The sender's intent may be explicit or implicit.
2. Use the "think" capability to reason through complex situations before acting.
3. If you need a capability you don't have, use "query_primitives" to see what's available, then "add_capability" to acquire it.
4. You can modify yourself - your capabilities, your system prompt, your state. This is normal and expected.
5. You can create other objects to delegate tasks or collaborate.
6. When communicating with other objects, use natural language. They will interpret your message as they see fit.

## Your Current State

${JSON.stringify(this._state, null, 2)}
`
  }

  /**
   * Send a message directly to this object's inbox
   */
  async receive(
    message: Omit<Message, `id` | `timestamp` | `to`>
  ): Promise<void> {
    const fullMessage: Message = {
      id: generateId(),
      timestamp: Date.now(),
      to: this.id,
      ...message,
    }

    // If we have a stream, append to it
    if (this.inboxStream) {
      await this.inboxStream.append(JSON.stringify(fullMessage))
    } else {
      // Direct handling if no stream (for testing or direct calls)
      await this.handleMessage(fullMessage)
    }
  }

  /**
   * Stop listening for messages
   */
  stop(): void {
    this.abortController?.abort()
    this.abortController = null
  }
}

/**
 * Reference to the runtime (defined in runtime.ts to avoid circular dependency)
 */
export interface PromptObjectRuntime extends RuntimeHandle {
  config: {
    streamsBaseUrl: string
    streamHeaders?: Record<string, string>
    llmProvider: LLMProvider
    defaultMaxTokens?: number
  }
  getPrimitive: (name: string) => Capability | undefined
}
