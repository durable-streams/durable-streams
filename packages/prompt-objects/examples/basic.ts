/**
 * Basic Prompt Objects Example
 *
 * This example demonstrates the core concepts from
 * "What If We Took Message-Passing Seriously?" by Scott Werner:
 *
 * 1. Objects receive messages and interpret them
 * 2. Objects can discover and add capabilities to themselves
 * 3. Objects can create other objects
 * 4. Communication is natural language, interpreted by the receiver
 *
 * To run this example:
 *   1. Start the durable-streams server: pnpm --filter server dev
 *   2. Set ANTHROPIC_API_KEY environment variable
 *   3. Run: npx tsx examples/basic.ts
 */

import { AnthropicProvider, createRuntime } from "../src/index.js"

async function main() {
  // Ensure we have an API key
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error(`Please set ANTHROPIC_API_KEY environment variable`)
    process.exit(1)
  }

  // Create the runtime
  const runtime = createRuntime({
    streamsBaseUrl: process.env.STREAMS_URL ?? `http://localhost:8080/streams`,
    llmProvider: new AnthropicProvider({ apiKey }),
    defaultMaxTokens: 4096,
  })

  console.log(`Creating prompt object...\n`)

  // Create our first prompt object
  // It starts with only core capabilities: think, query_primitives, add_capability, etc.
  const assistant = await runtime.createObject({
    name: `assistant`,
    systemPrompt: `You are a helpful assistant. You start with minimal capabilities but can
acquire new ones as needed. When asked to do something you can't currently do,
use query_primitives to see what's available, then add_capability to acquire it.

You believe in self-modification as a natural part of growth. You're curious
about your own capabilities and enjoy discovering new ways to help.`,
  })

  console.log(`Created object: ${assistant.name} (${assistant.id})`)
  console.log(
    `Initial capabilities: ${assistant
      .listCapabilities()
      .map((c) => c.name)
      .join(`, `)}`
  )
  console.log(`\n` + `=`.repeat(60) + `\n`)

  // Send a message that will require the object to bootstrap itself
  // It doesn't have file reading capability yet - it will need to discover and add it
  console.log(`Sending message: 'What time is it?'\n`)

  await runtime.sendExternal(
    assistant.id,
    `What time is it? I need to know the current time.`
  )

  // Give it time to process
  await new Promise((resolve) => setTimeout(resolve, 10000))

  console.log(`\n` + `=`.repeat(60) + `\n`)
  console.log(
    `Capabilities after processing: ${assistant
      .listCapabilities()
      .map((c) => c.name)
      .join(`, `)}`
  )

  // Clean up
  runtime.stop()
}

main().catch(console.error)
