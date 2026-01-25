/**
 * Multi-Object Communication Example
 *
 * This example demonstrates objects creating and communicating with each other.
 * An orchestrator object receives a task and delegates to specialized workers.
 *
 * To run this example:
 *   1. Start the durable-streams server: pnpm --filter server dev
 *   2. Set ANTHROPIC_API_KEY environment variable
 *   3. Run: npx tsx examples/multi-object.ts
 */

import { AnthropicProvider, createRuntime } from "../src/index.js"

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error(`Please set ANTHROPIC_API_KEY environment variable`)
    process.exit(1)
  }

  const runtime = createRuntime({
    streamsBaseUrl: process.env.STREAMS_URL ?? `http://localhost:8080/streams`,
    llmProvider: new AnthropicProvider({ apiKey }),
    defaultMaxTokens: 4096,
  })

  console.log(`Creating orchestrator object...\n`)

  // Create an orchestrator that can spawn specialized workers
  const orchestrator = await runtime.createObject({
    name: `orchestrator`,
    systemPrompt: `You are an orchestrator. When given complex tasks, you break them down
and delegate to specialized workers.

Your approach:
1. Analyze the task to understand what needs to be done
2. Create specialized objects for different parts of the work
3. Send them messages to coordinate the work
4. Collect and synthesize results

You are thoughtful about what kind of workers to create. Each worker should
have a clear, focused purpose defined in their system prompt.

When creating workers, give them specific system prompts that define:
- Their specialty/expertise
- How they should approach problems
- What kind of responses they should give`,
  })

  console.log(`Created: ${orchestrator.name} (${orchestrator.id})`)
  console.log(`\n` + `=`.repeat(60) + `\n`)

  // Give the orchestrator a complex task
  console.log(
    `Sending task: 'I need a haiku about programming and a calculation of 2^10'\n`
  )

  await runtime.sendExternal(
    orchestrator.id,
    `I have two tasks for you:
1. Write me a haiku about the joy of programming
2. Calculate 2 raised to the power of 10

Please handle these appropriately.`
  )

  // Give time for multi-object interaction
  await new Promise((resolve) => setTimeout(resolve, 30000))

  console.log(`\n` + `=`.repeat(60) + `\n`)
  console.log(`Objects in runtime:`)
  for (const obj of runtime.listObjects()) {
    console.log(
      `  - ${obj.name} (${obj.id}): ${obj.capabilities.length} capabilities`
    )
  }

  runtime.stop()
}

main().catch(console.error)
