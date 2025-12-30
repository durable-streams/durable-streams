/**
 * Serverless-compatible workflow that can `await input()` from the browser.
 *
 * This demonstrates a replay-based workflow pattern where:
 * 1. When input arrives, the workflow function is invoked
 * 2. The workflow replays from the event log to restore state
 * 3. When `await input()` is called:
 *    - If a response exists in the log, it returns immediately (replay)
 *    - If no response exists, it sends the request and suspends
 * 4. When new input arrives, the function is re-invoked and resumes
 *
 * This works in serverless because the function doesn't need to stay running -
 * it's called fresh each time and replays to the correct state.
 */

import { DurableStream } from "@durable-streams/client"
import { createStreamDB, createStateSchema } from "@durable-streams/state"
import { z } from "zod"

const SERVER_URL = "http://localhost:4437"
const STREAM_PATH = "/browser-input-workflow"

// Schema for workflow events
const workflowEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("input_request"),
    requestId: z.string(),
    prompt: z.string(),
    fields: z
      .record(
        z.object({
          type: z.enum(["text", "email", "checkbox"]),
          label: z.string(),
        })
      )
      .optional(),
  }),
  z.object({
    kind: z.literal("input_response"),
    requestId: z.string(),
    value: z.unknown(),
  }),
  z.object({
    kind: z.literal("loading"),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("output"),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("complete"),
  }),
])

type WorkflowEvent = z.infer<typeof workflowEventSchema>

const stateSchema = createStateSchema({
  events: {
    schema: workflowEventSchema,
    type: "event",
    primaryKey: (e: WorkflowEvent) =>
      e.kind === "input_request" || e.kind === "input_response"
        ? `${e.kind}-${e.requestId}`
        : `${e.kind}-${Date.now()}-${Math.random()}`,
  },
})

// Special error to signal workflow suspension
class WorkflowSuspendedError extends Error {
  constructor(public requestId: string) {
    super("Workflow suspended waiting for input")
    this.name = "WorkflowSuspendedError"
  }
}

type StreamDB = ReturnType<typeof createStreamDB<typeof stateSchema>>

/**
 * Workflow context with replay-aware helper functions.
 * Works in serverless by replaying from the event log.
 */
class WorkflowContext {
  private db: StreamDB
  private inputRequestCounter = 0
  private events: WorkflowEvent[]
  private inputRequests: Map<string, WorkflowEvent>
  private inputResponses: Map<string, WorkflowEvent>

  constructor(db: StreamDB) {
    this.db = db
    this.events = Array.from(db.collections.events.values())

    // Index input requests and responses for replay
    this.inputRequests = new Map()
    this.inputResponses = new Map()

    for (const event of this.events) {
      if (event.kind === "input_request") {
        this.inputRequests.set(event.requestId, event)
      } else if (event.kind === "input_response") {
        this.inputResponses.set(event.requestId, event)
      }
    }
  }

  /**
   * Request input from the browser.
   * In replay mode: returns cached response if available.
   * In live mode: sends request and suspends workflow.
   */
  async input<T = string>(
    prompt: string,
    fields?: Record<string, { type: "text" | "email" | "checkbox"; label: string }>
  ): Promise<T> {
    // Generate deterministic request ID based on call order
    this.inputRequestCounter++
    const requestId = `input-${this.inputRequestCounter}`

    // Check if we already have a response (replay mode)
    const existingResponse = this.inputResponses.get(requestId)
    if (existingResponse && existingResponse.kind === "input_response") {
      console.log(`↩️  Replaying input #${this.inputRequestCounter}: "${prompt}" -> ${JSON.stringify(existingResponse.value)}`)
      return existingResponse.value as T
    }

    // Check if we already sent this request
    const existingRequest = this.inputRequests.get(requestId)
    if (!existingRequest) {
      // Send new input request
      await this.db.stream.append(
        stateSchema.events.insert({
          value: {
            kind: "input_request",
            requestId,
            prompt,
            fields,
          },
        })
      )
      console.log(`⏳ Awaiting input #${this.inputRequestCounter}: "${prompt}"`)
    } else {
      console.log(`⏳ Still waiting for input #${this.inputRequestCounter}: "${prompt}"`)
    }

    // Suspend workflow - will be re-invoked when response arrives
    throw new WorkflowSuspendedError(requestId)
  }

  /**
   * Show loading state while performing async work.
   */
  async loading<T>(
    message: string,
    fn: (ctx: { complete: (msg: string) => void }) => Promise<T>
  ): Promise<T> {
    await this.db.stream.append(
      stateSchema.events.insert({
        value: { kind: "loading", message },
      })
    )

    console.log(`⏳ ${message}`)

    let completionMessage = ""
    const result = await fn({
      complete: (msg) => {
        completionMessage = msg
      },
    })

    if (completionMessage) {
      console.log(`✓ ${completionMessage}`)
    }

    return result
  }

  /**
   * Output a message to the browser.
   */
  async output(message: string): Promise<void> {
    await this.db.stream.append(
      stateSchema.events.insert({
        value: { kind: "output", message },
      })
    )
    console.log(`📤 Output: ${message}`)
  }

  /**
   * Mark workflow as complete.
   */
  async complete(): Promise<void> {
    await this.db.stream.append(
      stateSchema.events.insert({
        value: { kind: "complete" },
      })
    )
  }

  /**
   * Check if workflow is already complete.
   */
  isComplete(): boolean {
    return this.events.some((e) => e.kind === "complete")
  }
}

// Helper to sleep
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The actual workflow - can be run in serverless.
 * Each call replays from the event log and continues from where it left off.
 */
async function workflow(ctx: WorkflowContext) {
  // Step 1: Ask for name
  const name = await ctx.input<string>("What is your name?")
  console.log(`✓ Got name: ${name}`)

  // Step 2: Ask for more details
  const { email, subscribe } = await ctx.input<{
    email: string
    subscribe: boolean
  }>("Enter more info", {
    email: { type: "email", label: "Email address" },
    subscribe: { type: "checkbox", label: "Subscribe to newsletter?" },
  })
  console.log(`✓ Got details: email=${email}, subscribe=${subscribe}`)

  // Step 3: If subscribed, show loading while "subscribing"
  if (subscribe) {
    await ctx.loading("Subscribing to newsletter...", async ({ complete }) => {
      await sleep(2000)
      complete("Subscribed to newsletter!")
    })
  }

  // Step 4: Output final message
  await ctx.output(`Thanks, ${name}! Check ${email} for next steps.`)

  // Mark complete
  await ctx.complete()
}

/**
 * Run the workflow - called each time input arrives.
 * Returns true if workflow completed, false if suspended.
 */
async function runWorkflow(db: StreamDB): Promise<boolean> {
  const ctx = new WorkflowContext(db)

  // Skip if already complete
  if (ctx.isComplete()) {
    console.log("✅ Workflow already completed")
    return true
  }

  try {
    await workflow(ctx)
    console.log("\n✅ Workflow completed!")
    return true
  } catch (err) {
    if (err instanceof WorkflowSuspendedError) {
      console.log(`💤 Workflow suspended, waiting for input response...`)
      return false
    }
    throw err
  }
}

// Main entry point - simulates serverless invocation
async function main() {
  console.log("🚀 Starting workflow runner (serverless-compatible)...")
  console.log("   Each input response triggers a fresh workflow execution\n")

  const streamUrl = `${SERVER_URL}/v1/stream${STREAM_PATH}`

  // Create stream if it doesn't exist
  try {
    const testStream = new DurableStream({ url: streamUrl })
    await testStream.head()
    // Stream exists - delete for fresh start
    await testStream.delete()
    console.log("🗑️  Deleted existing stream for fresh workflow")
  } catch {
    // Stream doesn't exist
  }

  await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  console.log(`📡 Created stream: ${streamUrl}`)

  // Create StreamDB
  const db = createStreamDB({
    streamOptions: {
      url: streamUrl,
      contentType: "application/json",
    },
    state: stateSchema,
  })

  await db.preload()

  console.log("\n🌐 Open the browser client to interact:")
  console.log("   http://localhost:5173/browser-input-workflow/\n")
  console.log("─".repeat(50))

  // Initial workflow run
  let completed = await runWorkflow(db)

  if (completed) {
    process.exit(0)
  }

  // Subscribe to changes and re-run workflow when input arrives
  // In a real serverless env, this would be a webhook or queue trigger
  db.collections.events.subscribeChanges(async () => {
    // Reload events
    await db.preload()

    console.log("\n─".repeat(50))
    console.log("📥 Event received, re-running workflow...\n")

    completed = await runWorkflow(db)

    if (completed) {
      console.log("\n🎉 All done!")
      process.exit(0)
    }
  })
}

main().catch((err) => {
  console.error("❌ Error:", err)
  process.exit(1)
})
