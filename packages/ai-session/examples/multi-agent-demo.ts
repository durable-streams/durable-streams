/**
 * Multi-Agent Demo
 *
 * Demonstrates multiple agents and users collaborating on a shared durable session.
 *
 * Run with:
 *   1. Start the dev server: cd packages/server && pnpm dev
 *   2. Run this demo: npx tsx examples/multi-agent-demo.ts
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { createAISession } from "../src/session.js"
import { createVercelAdapter } from "../src/adapters/vercel.js"

// =============================================================================
// Simulated streaming helpers
// =============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function simulateTyping(
  adapter: ReturnType<typeof createVercelAdapter>,
  text: string,
  textId: string
): Promise<void> {
  await adapter.processEvent({ type: "text-start", id: textId })

  // Stream word by word
  const words = text.split(" ")
  for (const [i, w] of words.entries()) {
    const word = i === 0 ? w : " " + w
    await adapter.processEvent({ type: "text-delta", id: textId, delta: word })
    process.stdout.write(word)
    await delay(50) // Simulate streaming delay
  }

  await adapter.processEvent({ type: "text-end", id: textId })
  console.log()
}

// =============================================================================
// Main demo
// =============================================================================

async function main() {
  console.log("🚀 Starting Multi-Agent Demo\n")

  // Start a test server
  const server = new DurableStreamTestServer({ port: 0 })
  await server.start()
  const baseUrl = server.url
  console.log(`📡 Server running at ${baseUrl}\n`)

  const sessionUrl = `${baseUrl}/sessions/collab-${Date.now()}`

  // Create two separate session connections (simulating different clients)
  // First one creates the stream, second one joins
  const session1 = await createAISession({ url: sessionUrl, create: true })
  const session2 = await createAISession({ url: sessionUrl })

  // Register agents
  const claude = await session1.registerAgent({
    id: "claude",
    name: "Claude",
    model: "claude-sonnet-4-20250514",
  })

  const gpt = await session2.registerAgent({
    id: "gpt",
    name: "GPT-4",
    model: "gpt-4-turbo",
  })

  console.log("🤖 Registered agents:", claude.name, "and", gpt.name)

  // Create adapters for each agent
  const claudeAdapter = createVercelAdapter({ session: session1, agentId: claude.id })
  const gptAdapter = createVercelAdapter({ session: session2, agentId: gpt.id })

  // Simulate a user message
  console.log("\n--- Conversation ---\n")

  const userMessage = await session1.createMessage({
    role: "user",
    userId: "kyle",
  })
  await session1.appendDelta({
    messageId: userMessage.id,
    partIndex: 0,
    partType: "text",
    seq: 0,
    text: "What's the best way to handle real-time collaboration?",
    done: true,
  })
  console.log("👤 Kyle: What's the best way to handle real-time collaboration?\n")

  await delay(200)

  // Claude responds
  console.log("🔵 Claude: ", "")
  await claudeAdapter.startMessage()
  await simulateTyping(
    claudeAdapter,
    "Great question! I'd recommend using an append-only log pattern. Each participant writes events to a shared stream, and all clients can read from any position.",
    "claude_text_1"
  )

  await delay(300)

  // GPT adds to the conversation
  console.log("\n🟢 GPT-4: ", "")
  await gptAdapter.startMessage()
  await simulateTyping(
    gptAdapter,
    "Building on Claude's point - the key is idempotent writes. With producer IDs and sequence numbers, you get exactly-once semantics even with retries.",
    "gpt_text_1"
  )

  await delay(300)

  // Claude responds to GPT
  console.log("\n🔵 Claude: ", "")
  await claudeAdapter.startMessage()
  await simulateTyping(
    claudeAdapter,
    "Exactly! And with SSE for live updates, clients stay in sync without polling. The stream becomes the single source of truth.",
    "claude_text_2"
  )

  // Preload both sessions to sync
  await Promise.all([session1.preload(), session2.preload()])

  // Show session stats
  console.log("\n--- Session Stats ---\n")
  console.log(`Messages: ${session1.db.collections.messages.size}`)
  console.log(`Deltas: ${session1.db.collections.deltas.size}`)
  console.log(`Agents: ${session1.db.collections.agents.size}`)

  // Show all messages
  console.log("\n--- Message Log ---\n")
  const messages = Array.from(session1.db.collections.messages.values())
    .sort((a, b) => a.createdAt - b.createdAt)

  for (const msg of messages) {
    const deltas = Array.from(session1.db.collections.deltas.values())
      .filter((d) => d.messageId === msg.id)
      .sort((a, b) => a.seq - b.seq)

    const content = deltas
      .filter((d) => d.text)
      .map((d) => d.text)
      .join("")

    const sender = msg.role === "user"
      ? `User:${msg.userId}`
      : `Agent:${msg.agentId}`

    console.log(`[${sender}] ${content.slice(0, 60)}...`)
  }

  // Cleanup
  session1.close()
  session2.close()
  await server.stop()

  console.log("\n✅ Demo complete!")
}

main().catch(console.error)
