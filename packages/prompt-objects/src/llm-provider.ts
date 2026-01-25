/**
 * LLM Provider implementations
 */

import type {
  CompletionOptions,
  CompletionResult,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from "./types.js"

/**
 * Anthropic Claude provider
 */
export class AnthropicProvider implements LLMProvider {
  private client: AnthropicClient | null
  private model: string

  constructor(options: AnthropicProviderOptions) {
    // Dynamic import check - we use the client passed in or create one
    if (options.client) {
      this.client = options.client
    } else if (options.apiKey) {
      // Lazy initialization - will be set on first use
      this.client = null as unknown as AnthropicClient
      this.initClient(options.apiKey)
    } else {
      throw new Error(`AnthropicProvider requires either a client or apiKey`)
    }
    this.model = options.model ?? `claude-sonnet-4-20250514`
  }

  private async initClient(apiKey: string): Promise<void> {
    try {
      const { default: Anthropic } = await import(`@anthropic-ai/sdk`)
      this.client = new Anthropic({ apiKey }) as AnthropicClient
    } catch {
      throw new Error(
        `Failed to import @anthropic-ai/sdk. Please install it: npm install @anthropic-ai/sdk`
      )
    }
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    // Ensure client is initialized
    if (!this.client) {
      throw new Error(`Anthropic client not initialized`)
    }

    const tools = options.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))

    const messages = options.messages.map((msg) => {
      if (msg.role === `tool_result`) {
        return {
          role: `user` as const,
          content: [
            {
              type: `tool_result` as const,
              tool_use_id: msg.toolUseId!,
              content: msg.content,
            },
          ],
        }
      }
      return {
        role: msg.role,
        content: msg.content,
      }
    })

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      system: options.system,
      messages,
      tools: tools?.length ? tools : undefined,
    })

    // Extract text content and tool calls
    let content: string | undefined
    const toolCalls: Array<ToolCall> = []

    for (const block of response.content) {
      if (block.type === `text`) {
        content = (content ?? ``) + block.text
      } else {
        // block.type === "tool_use"
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        })
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason:
        response.stop_reason === `tool_use`
          ? `tool_use`
          : response.stop_reason === `max_tokens`
            ? `max_tokens`
            : `end_turn`,
    }
  }
}

export interface AnthropicProviderOptions {
  /** Anthropic API key */
  apiKey?: string
  /** Pre-configured Anthropic client */
  client?: AnthropicClient
  /** Model to use (default: claude-sonnet-4-20250514) */
  model?: string
}

// Minimal type for Anthropic client to avoid hard dependency
interface AnthropicClient {
  messages: {
    create: (options: {
      model: string
      max_tokens: number
      system: string
      messages: Array<{
        role: `user` | `assistant`
        content:
          | string
          | Array<{ type: `tool_result`; tool_use_id: string; content: string }>
      }>
      tools?: Array<{
        name: string
        description: string
        input_schema: {
          type: `object`
          properties: Record<string, unknown>
          required?: Array<string>
        }
      }>
    }) => Promise<{
      content: Array<
        | { type: `text`; text: string }
        | { type: `tool_use`; id: string; name: string; input: unknown }
      >
      stop_reason: string
    }>
  }
}

/**
 * Create capability tool definitions from capabilities
 */
export function capabilitiesToTools(
  capabilities: Array<{
    name: string
    description: string
    parameters?: ToolDefinition[`inputSchema`]
  }>
): Array<ToolDefinition> {
  return capabilities.map((cap) => ({
    name: cap.name,
    description: cap.description,
    inputSchema: cap.parameters ?? {
      type: `object`,
      properties: {},
    },
  }))
}
