/**
 * Prompt Objects: Taking message-passing seriously
 *
 * Inspired by Alan Kay's vision of objects as self-contained computers
 * that communicate via messages, interpreted by the receiver.
 *
 * Key concepts:
 * - Objects receive messages and interpret them at runtime (semantic late binding)
 * - Objects can modify themselves by adding capabilities
 * - Objects can create other objects
 * - Communication is in natural language
 */

/**
 * A message passed between prompt objects.
 * Messages are natural language, interpreted by the receiver.
 */
export interface Message {
  /** Unique message ID */
  id: string
  /** Sender object ID (or "user" for external messages) */
  from: string
  /** Recipient object ID */
  to: string
  /** The natural language content of the message */
  content: string
  /** Optional: stream URL where the sender expects a reply */
  replyTo?: string
  /** When the message was sent */
  timestamp: number
  /** Optional metadata for routing or context */
  metadata?: Record<string, unknown>
}

/**
 * A capability that an object can use.
 * Capabilities are discovered and added at runtime.
 */
export interface Capability {
  /** Unique name for this capability */
  name: string
  /** Natural language description of what this capability does */
  description: string
  /** JSON schema for the parameters (optional) */
  parameters?: {
    type: `object`
    properties: Record<string, unknown>
    required?: Array<string>
  }
  /** The implementation */
  execute: (
    params: Record<string, unknown>,
    context: ExecutionContext
  ) => Promise<unknown>
}

/**
 * Context provided to capability execution
 */
export interface ExecutionContext {
  /** The object executing this capability */
  self: PromptObjectHandle
  /** The message that triggered this execution */
  message: Message
  /** Access to the runtime for creating objects, sending messages, etc. */
  runtime: RuntimeHandle
}

/**
 * A handle to a prompt object (for use by capabilities)
 */
export interface PromptObjectHandle {
  /** The object's unique ID */
  id: string
  /** The object's name */
  name: string
  /** Add a capability to this object */
  addCapability: (capability: Capability) => void
  /** Remove a capability */
  removeCapability: (name: string) => void
  /** List all capabilities */
  listCapabilities: () => Array<CapabilityInfo>
  /** Get the object's current system prompt */
  getSystemPrompt: () => string
  /** Update the object's system prompt */
  setSystemPrompt: (prompt: string) => void
  /** Get object state */
  getState: () => Record<string, unknown>
  /** Update object state */
  setState: (state: Record<string, unknown>) => void
}

/**
 * Information about a capability (without the implementation)
 */
export interface CapabilityInfo {
  name: string
  description: string
  parameters?: {
    type: `object`
    properties: Record<string, unknown>
    required?: Array<string>
  }
}

/**
 * A handle to the runtime (for use by capabilities)
 */
export interface RuntimeHandle {
  /** Send a message to an object */
  send: (to: string, content: string, options?: SendOptions) => Promise<void>
  /** Create a new object */
  createObject: (options: CreateObjectOptions) => Promise<PromptObjectHandle>
  /** Get a handle to an existing object */
  getObject: (id: string) => PromptObjectHandle | undefined
  /** List all objects */
  listObjects: () => Array<PromptObjectInfo>
  /** Query available primitives (standard library capabilities) */
  getAvailablePrimitives: () => Array<CapabilityInfo>
}

/**
 * Options for sending a message
 */
export interface SendOptions {
  /** Optional metadata */
  metadata?: Record<string, unknown>
  /** Whether to wait for a reply */
  awaitReply?: boolean
  /** Timeout for reply (ms) */
  replyTimeout?: number
}

/**
 * Options for creating a new object
 */
export interface CreateObjectOptions {
  /** Optional ID (generated if not provided) */
  id?: string
  /** Human-readable name */
  name: string
  /** System prompt defining the object's identity and behavior */
  systemPrompt: string
  /** Initial capabilities to add */
  capabilities?: Array<Capability>
  /** Initial state */
  state?: Record<string, unknown>
}

/**
 * Information about a prompt object
 */
export interface PromptObjectInfo {
  id: string
  name: string
  capabilities: Array<CapabilityInfo>
}

/**
 * LLM provider interface - abstraction over different AI providers
 */
export interface LLMProvider {
  /**
   * Generate a completion with tool use support
   */
  complete: (options: CompletionOptions) => Promise<CompletionResult>
}

/**
 * Options for LLM completion
 */
export interface CompletionOptions {
  /** System prompt */
  system: string
  /** Messages in the conversation */
  messages: Array<ConversationMessage>
  /** Available tools/capabilities */
  tools?: Array<ToolDefinition>
  /** Maximum tokens to generate */
  maxTokens?: number
}

/**
 * A message in a conversation
 */
export interface ConversationMessage {
  role: `user` | `assistant` | `tool_result`
  content: string
  /** For tool_result messages */
  toolUseId?: string
}

/**
 * Tool definition for LLM
 */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: `object`
    properties: Record<string, unknown>
    required?: Array<string>
  }
}

/**
 * Result from LLM completion
 */
export interface CompletionResult {
  /** Text content (if any) */
  content?: string
  /** Tool calls requested */
  toolCalls?: Array<ToolCall>
  /** Whether the model wants to stop */
  stopReason: `end_turn` | `tool_use` | `max_tokens`
}

/**
 * A tool call from the LLM
 */
export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * Configuration for the prompt objects runtime
 */
export interface RuntimeConfig {
  /** Base URL for durable streams */
  streamsBaseUrl: string
  /** Headers for stream authentication */
  streamHeaders?: Record<string, string>
  /** LLM provider to use */
  llmProvider: LLMProvider
  /** Default max tokens for completions */
  defaultMaxTokens?: number
  /** Primitives (standard library capabilities) available to all objects */
  primitives?: Array<Capability>
}
