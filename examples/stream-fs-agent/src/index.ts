/**
 * Stream-FS Agent Example
 *
 * Demonstrates an AI agent using Claude to interact with a durable filesystem.
 * The agent can create, read, edit, and delete files using natural language.
 */

import Anthropic from "@anthropic-ai/sdk"
import { DurableFilesystem, InMemoryStreamFactory } from "@durable-streams/stream-fs"
import {
  allTools,
  toClaudeTools,
  handleToolCall,
  type ToolResult,
} from "@durable-streams/stream-fs/tools"

// =============================================================================
// Configuration
// =============================================================================

const SYSTEM_PROMPT = `You are a helpful AI assistant with access to a shared filesystem.
You can create, read, edit, and delete files using the provided tools.

When editing files:
- Use edit_file for targeted changes (find and replace a unique string)
- Use write_file only when you need to replace the entire file content
- Always read a file first before editing to understand its current content

When creating files:
- Create parent directories first if they don't exist
- Use appropriate file extensions

Be concise in your responses and confirm what actions you've taken.`

// =============================================================================
// Main Agent Loop
// =============================================================================

async function runAgent() {
  // Initialize the filesystem (in-memory for this example)
  const streamFactory = new InMemoryStreamFactory()
  const fs = new DurableFilesystem({
    metadataStreamOptions: { url: "memory://__metadata__" },
    streamFactory,
  })
  await fs.initialize()

  // Create some initial structure
  console.log("Setting up initial filesystem structure...")
  await fs.mkdir("/projects")
  await fs.mkdir("/projects/demo")
  await fs.createFile(
    "/projects/demo/README.md",
    `# Demo Project

This is a demo project for the stream-fs agent.

## Getting Started

1. Install dependencies
2. Run the project
3. Have fun!
`
  )
  await fs.createFile(
    "/projects/demo/config.json",
    JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2)
  )

  console.log("Filesystem ready!\n")

  // Initialize Claude client
  const anthropic = new Anthropic()
  const tools = toClaudeTools()

  // Conversation history
  const messages: Anthropic.MessageParam[] = []

  // Example conversation
  const userPrompts = [
    "What files are in the /projects/demo directory?",
    "Read the README.md file",
    "Add a new section called 'Features' to the README with a bullet point about 'Durable filesystem'",
    "Create a new file called /projects/demo/src/main.ts with a simple hello world function",
    "Update the config.json to add a 'main' field pointing to 'src/main.ts'",
  ]

  for (const userPrompt of userPrompts) {
    console.log(`\n${"=".repeat(60)}`)
    console.log(`User: ${userPrompt}`)
    console.log("=".repeat(60))

    messages.push({ role: "user", content: userPrompt })

    // Keep processing until we get a final response (no more tool calls)
    let continueLoop = true
    while (continueLoop) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      })

      // Check if we need to process tool calls
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      )

      if (toolUseBlocks.length === 0) {
        // No tool calls, we have a final response
        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === "text"
        )
        const assistantMessage = textBlocks.map((b) => b.text).join("\n")
        console.log(`\nAssistant: ${assistantMessage}`)
        messages.push({ role: "assistant", content: response.content })
        continueLoop = false
      } else {
        // Process tool calls
        messages.push({ role: "assistant", content: response.content })

        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const toolUse of toolUseBlocks) {
          console.log(`\n[Tool: ${toolUse.name}]`)
          console.log(`Input: ${JSON.stringify(toolUse.input, null, 2)}`)

          const result = await handleToolCall(
            fs,
            toolUse.name,
            toolUse.input as Record<string, unknown>
          )

          console.log(`Result: ${JSON.stringify(result, null, 2)}`)

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          })
        }

        messages.push({ role: "user", content: toolResults })
      }
    }
  }

  // Final state
  console.log("\n" + "=".repeat(60))
  console.log("Final filesystem state:")
  console.log("=".repeat(60))

  async function printTree(path: string, indent = "") {
    const entries = await fs.list(path)
    for (const entry of entries) {
      console.log(`${indent}${entry.type === "directory" ? "📁" : "📄"} ${entry.name}`)
      if (entry.type === "directory") {
        await printTree(entry.path, indent + "  ")
      }
    }
  }

  await printTree("/")

  // Print file contents
  console.log("\n--- /projects/demo/README.md ---")
  console.log(await fs.readTextFile("/projects/demo/README.md"))

  console.log("\n--- /projects/demo/config.json ---")
  console.log(await fs.readTextFile("/projects/demo/config.json"))

  if (await fs.exists("/projects/demo/src/main.ts")) {
    console.log("\n--- /projects/demo/src/main.ts ---")
    console.log(await fs.readTextFile("/projects/demo/src/main.ts"))
  }

  fs.close()
}

// =============================================================================
// Run
// =============================================================================

runAgent().catch(console.error)
