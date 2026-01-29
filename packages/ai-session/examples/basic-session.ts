/**
 * Basic AI Session Example
 *
 * Demonstrates creating a durable AI session and writing streaming events.
 * Run with: npx tsx examples/basic-session.ts
 */

import { createAISession } from "../src/session.js"
import {
  createVercelAdapter,
  type VercelStreamEvent,
} from "../src/adapters/vercel.js"

// Simulated Vercel AI SDK streaming events
const simulatedEvents: VercelStreamEvent[] = [
  { type: "message-start", id: "msg_1" },
  { type: "text-start", id: "text_1" },
  { type: "text-delta", id: "text_1", delta: "Hello" },
  { type: "text-delta", id: "text_1", delta: ", " },
  { type: "text-delta", id: "text_1", delta: "I'm " },
  { type: "text-delta", id: "text_1", delta: "Claude!" },
  { type: "text-end", id: "text_1" },
  {
    type: "tool-input-start",
    toolCallId: "tc_1",
    toolName: "get_weather",
  },
  {
    type: "tool-input-delta",
    toolCallId: "tc_1",
    toolName: "get_weather",
    delta: '{"city":',
  },
  {
    type: "tool-input-delta",
    toolCallId: "tc_1",
    toolName: "get_weather",
    delta: '"Paris"}',
  },
  {
    type: "tool-input-available",
    toolCallId: "tc_1",
    toolName: "get_weather",
    input: { city: "Paris" },
  },
  {
    type: "tool-output-available",
    toolCallId: "tc_1",
    output: { temperature: 22, condition: "sunny" },
  },
  { type: "text-start", id: "text_2" },
  {
    type: "text-delta",
    id: "text_2",
    delta: "The weather in Paris is sunny, 22°C!",
  },
  { type: "text-end", id: "text_2" },
  { type: "finish" },
]

async function main() {
  // In a real app, this would be your hosted durable streams URL
  const sessionUrl =
    process.env.SESSION_URL || "http://localhost:4000/sessions/demo-session"

  console.log("Creating AI session at:", sessionUrl)

  // Create the session
  const session = await createAISession({
    url: sessionUrl,
    create: true,
  })

  // Register an agent
  const agent = await session.registerAgent({
    id: "claude",
    name: "Claude",
    model: "claude-sonnet-4-20250514",
  })
  console.log("Registered agent:", agent)

  // Create the Vercel adapter
  const adapter = createVercelAdapter({
    session,
    agentId: agent.id,
  })

  // Start a new assistant message
  const message = await adapter.startMessage()
  console.log("Started message:", message.id)

  // Process simulated events (in real app, these come from Vercel AI SDK stream)
  console.log("\nProcessing streaming events...")
  for (const event of simulatedEvents) {
    await adapter.processEvent(event)
    if (event.type === "text-delta") {
      process.stdout.write(event.delta)
    }
  }
  console.log("\n")

  // Preload to sync all data
  console.log("Preloading session data...")
  await session.preload()

  // Query the data
  console.log("\n--- Session Data ---")
  console.log("Messages:", session.db.collections.messages.size)
  console.log("Deltas:", session.db.collections.deltas.size)
  console.log("Agents:", session.db.collections.agents.size)

  // Get all deltas for our message
  const deltas = Array.from(session.db.collections.deltas.values()).filter(
    (d) => d.messageId === message.id
  )

  console.log("\nDeltas for message", message.id + ":")
  for (const delta of deltas.sort((a, b) => {
    if (a.partIndex !== b.partIndex) return a.partIndex - b.partIndex
    return a.seq - b.seq
  })) {
    console.log(
      `  [part ${delta.partIndex}, seq ${delta.seq}] ${delta.partType}: ${delta.text || delta.toolName || JSON.stringify(delta.toolOutput) || (delta.done ? "(done)" : "")}`
    )
  }

  // Cleanup
  session.close()
  console.log("\nSession closed.")
}

main().catch(console.error)
