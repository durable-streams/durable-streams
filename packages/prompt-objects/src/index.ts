/**
 * Prompt Objects
 *
 * A TypeScript implementation of prompt objects - self-contained computing
 * environments that communicate via natural language message passing.
 *
 * Inspired by Alan Kay's vision of objects as little computers, and Scott Werner's
 * "What If We Took Message-Passing Seriously?" which applies these ideas to AI agents.
 *
 * Key concepts:
 * - Objects receive messages and interpret them at runtime (semantic late binding)
 * - Objects can modify themselves by adding capabilities
 * - Objects can create other objects
 * - Communication is in natural language, interpreted by the receiver
 *
 * Built on Durable Streams for persistent, resumable message passing.
 *
 * @example
 * ```typescript
 * import { createRuntime, AnthropicProvider } from "@durable-streams/prompt-objects";
 *
 * const runtime = createRuntime({
 *   streamsBaseUrl: "http://localhost:8080/streams",
 *   llmProvider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
 * });
 *
 * // Create an object
 * const assistant = await runtime.createObject({
 *   name: "assistant",
 *   systemPrompt: "You are a helpful assistant that can read and write files.",
 * });
 *
 * // Send it a message
 * await runtime.sendExternal(assistant.id, "Please read the contents of README.md");
 * ```
 *
 * @packageDocumentation
 */

// Core types
// Convenience function to create a runtime
import { Runtime } from "./runtime.js"
import type { RuntimeConfig } from "./types.js"

export type {
  Message,
  Capability,
  CapabilityInfo,
  ExecutionContext,
  PromptObjectHandle,
  PromptObjectInfo,
  RuntimeHandle,
  RuntimeConfig,
  CreateObjectOptions,
  SendOptions,
  LLMProvider,
  CompletionOptions,
  CompletionResult,
  ConversationMessage,
  ToolDefinition,
  ToolCall,
} from "./types.js"

// Runtime
export { Runtime } from "./runtime.js"

// Prompt Object
export { PromptObject } from "./prompt-object.js"

// LLM Providers
export {
  AnthropicProvider,
  type AnthropicProviderOptions,
} from "./llm-provider.js"

/**
 * Create a new prompt objects runtime
 */
export function createRuntime(config: RuntimeConfig): Runtime {
  return new Runtime(config)
}
