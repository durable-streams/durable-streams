/**
 * Agent Runner - Agents subscribe to the stream and respond to user messages
 *
 * The stream is the event bus. Agents are just listeners that:
 * 1. Watch for new user messages
 * 2. Process them with their tools
 * 3. Write responses back to the stream
 *
 * Run with: ANTHROPIC_API_KEY=your-key npx tsx agent-runner.ts <agent-id> <session-url>
 */

import { createAISession } from "@durable-streams/ai-session"
import { createLiveQueryCollection, eq, and } from "@tanstack/db"
import Anthropic from "@anthropic-ai/sdk"
import { agents, type ToolDefinition } from "./agents"
import type { Message, Delta } from "@durable-streams/ai-session"

const client = new Anthropic()

async function main() {
  const agentId = process.argv[2]
  const sessionUrl = process.argv[3]

  if (!agentId || !sessionUrl) {
    console.error("Usage: npx tsx agent-runner.ts <agent-id> <session-url>")
    console.error("Available agents:", Object.keys(agents).join(", "))
    process.exit(1)
  }

  const agent = agents[agentId]
  if (!agent) {
    console.error(`Unknown agent: ${agentId}`)
    console.error("Available agents:", Object.keys(agents).join(", "))
    process.exit(1)
  }

  console.log(`Starting agent: ${agent.name} (${agentId})`)
  console.log(`Listening to: ${sessionUrl}`)

  // Connect to the session stream (create if doesn't exist)
  const session = await createAISession({ url: sessionUrl, create: true })

  // Track which messages we've already responded to
  const processedMessages = new Set<string>()

  // Track if we're currently processing (to avoid parallel responses)
  let isProcessing = false

  // First preload to get existing messages
  await session.preload()
  console.log(`\nConnected to stream`)

  // Create a live query that joins messages with their deltas
  // Returns complete user messages (status="done") with their content
  const messagesWithContent = createLiveQueryCollection((q) =>
    q
      .from({ message: session.db.collections.messages })
      .where(({ message }) =>
        and(
          eq(message.role, "user"),
          eq(message.status, "done")
        )
      )
      .join({ delta: session.db.collections.deltas }, ({ message, delta }) =>
        eq(message.id, delta.messageId)
      )
      .orderBy(({ message }) => message.createdAt, "asc")
      .select(({ message, delta }) => ({
        messageId: message.id,
        createdAt: message.createdAt,
        text: delta?.text,
        partIndex: delta?.partIndex ?? 0,
        seq: delta?.seq ?? 0,
      }))
  )

  // Helper to get message content by joining with deltas
  function getMessageContent(messageId: string): string {
    const deltas = Array.from(session.db.collections.deltas.values()) as Delta[]
    return deltas
      .filter((d) => d.messageId === messageId && d.text)
      .sort((a, b) => {
        if (a.partIndex !== b.partIndex) return a.partIndex - b.partIndex
        return a.seq - b.seq
      })
      .map((d) => d.text)
      .join("")
  }

  // Helper to process query results
  const processQueryResults = () => {
    if (isProcessing) return

    const results = Array.from(messagesWithContent.values())

    // Group by messageId and build content
    const messageMap = new Map<string, { createdAt: number; parts: Array<{ text?: string; partIndex: number; seq: number }> }>()
    for (const row of results) {
      if (processedMessages.has(row.messageId)) continue

      let msg = messageMap.get(row.messageId)
      if (!msg) {
        msg = { createdAt: row.createdAt, parts: [] }
        messageMap.set(row.messageId, msg)
      }
      if (row.text) {
        msg.parts.push({ text: row.text, partIndex: row.partIndex, seq: row.seq })
      }
    }

    if (messageMap.size === 0) return

    // Get oldest unprocessed message
    const sorted = Array.from(messageMap.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt)
    const [messageId, data] = sorted[0]

    // Build content from parts
    const content = data.parts
      .sort((a, b) => a.partIndex !== b.partIndex ? a.partIndex - b.partIndex : a.seq - b.seq)
      .map((p) => p.text)
      .join("")

    if (!content) return

    processedMessages.add(messageId)
    isProcessing = true

    processMessage(messageId, content).finally(() => {
      isProcessing = false
    })
  }

  // Mark all existing messages as processed
  for (const row of messagesWithContent.values()) {
    processedMessages.add(row.messageId)
  }
  console.log(`Skipped ${processedMessages.size} existing messages`)

  // Subscribe to query result changes
  messagesWithContent.subscribeChanges(processQueryResults)

  // Stop tool - allows Sonnet to decline responding after the relevance check passes
  const stopTool: Anthropic.Tool = {
    name: "stop",
    description: "Call this tool if this message is not relevant to your capabilities. This allows you to gracefully decline responding without producing output.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  }

  // Token usage tracking
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheWriteTokens = 0

  // Helper to calculate cost (approximate Sonnet pricing)
  function calculateCost(input: number, output: number, cacheRead: number, cacheWrite: number): number {
    // Sonnet 4: $3/M input, $15/M output, $0.30/M cache read, $3.75/M cache write
    return (input * 3 + output * 15 + cacheRead * 0.3 + cacheWrite * 3.75) / 1_000_000
  }

  // Message processing function
  async function processMessage(_messageId: string, messageContent: string) {
    const startTime = Date.now()

    try {
      console.log(`\nChecking relevance: "${messageContent}"`)

      // Build conversation history from current state FIRST (needed for relevance check)
      const messages = Array.from(session.db.collections.messages.values()) as Message[]
      const conversationHistory = messages
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((msg) => ({
          role: msg.role as "user" | "assistant",
          content: getMessageContent(msg.id),
        }))
        .filter((m) => m.content)

      console.log(`   Processing with ${agent.name}...`)
      console.log(`   Conversation history: ${conversationHistory.length} messages`)

      // Emit "thinking" status
      await session.updateStatus({
        agentId,
        state: "thinking",
        activity: "Processing request...",
        durationMs: 0,
      })

      // Get tool schemas for API - include stop tool so Sonnet can decline
      const tools = agent.tools as Record<string, ToolDefinition>
      const toolSchemas = [...Object.values(tools).map(t => t.schema), stopTool]

      // First call: stream but buffer until we confirm no "stop" tool call
      let currentMessages: Anthropic.MessageParam[] = conversationHistory
      const toolNames = Object.keys(tools).join(", ")
      const systemPrompt = `${agent.systemPrompt}

You are part of a multi-agent system. Your tools are: ${toolNames}.

CRITICAL:
- If you can help, USE YOUR TOOLS immediately. Never answer from memory.
- If you CANNOT help (request is outside your tools), call "stop" tool IMMEDIATELY with no text output. Do not explain why you can't help - just call stop silently. Another agent will handle it.

Examples for ${agent.name}:
${toolNames.includes("fetch_weather") ? "- Weather questions: use fetch_weather (SLC ≈ 40.76, -111.89)" : "- Weather questions: call stop (not your domain)"}
${toolNames.includes("fetch_wikipedia") ? "- Info lookups: use fetch_wikipedia" : "- Info lookups: call stop (not your domain)"}
${toolNames.includes("list_directory") ? "- File questions: use list_directory, read_file, search_files" : "- File questions: call stop (not your domain)"}`

      const firstStream = client.messages.stream({
        model: agent.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: currentMessages,
        tools: toolSchemas,
      })

      // Buffer text while streaming, check for stop tool
      const textBuffer: string[] = []
      let sawStopTool = false

      for await (const event of firstStream) {
        if (event.type === "content_block_delta") {
          const delta = event.delta
          if (delta.type === "text_delta") {
            textBuffer.push(delta.text)
          }
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use" && event.content_block.name === "stop") {
            sawStopTool = true
          }
        }
      }

      const firstResponse = await firstStream.finalMessage()

      // Track token usage
      totalInputTokens += firstResponse.usage.input_tokens
      totalOutputTokens += firstResponse.usage.output_tokens
      if ('cache_read_input_tokens' in firstResponse.usage) {
        totalCacheReadTokens += (firstResponse.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0
      }
      if ('cache_creation_input_tokens' in firstResponse.usage) {
        totalCacheWriteTokens += (firstResponse.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0
      }

      console.log(`   [${Date.now() - startTime}ms] First response: stop_reason=${firstResponse.stop_reason}, content_blocks=${firstResponse.content.length}`)
      console.log(`   Tokens: in=${firstResponse.usage.input_tokens} out=${firstResponse.usage.output_tokens}`)
      for (const block of firstResponse.content) {
        console.log(`     - ${block.type}${block.type === "tool_use" ? `: ${block.name}` : block.type === "text" ? `: "${block.text.substring(0, 100)}..."` : ""}`)
      }

      // Check if Sonnet declined by calling stop
      if (sawStopTool) {
        console.log(`   Sonnet declined - not relevant to ${agent.name}`)
        await session.updateStatus({
          agentId,
          state: "done",
          activity: "Not relevant, delegating...",
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadTokens: totalCacheReadTokens,
          cacheWriteTokens: totalCacheWriteTokens,
          costUsd: calculateCost(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens),
          durationMs: Date.now() - startTime,
        })
        return
      }

      // Sonnet wants to respond - now create the message and flush buffer
      const responseMessage = await session.createMessage({
        role: "assistant",
        agentId,
      })
      console.log(`   Created response message: ${responseMessage.id}`)

      // Update status to streaming
      await session.updateStatus({
        agentId,
        messageId: responseMessage.id,
        state: "streaming",
        activity: "Generating response...",
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheWriteTokens: totalCacheWriteTokens,
        costUsd: calculateCost(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens),
        durationMs: Date.now() - startTime,
      })

      let partIndex = 0
      let seq = 0

      // Helper to append text delta
      const appendText = async (text: string) => {
        await session.appendDelta({
          messageId: responseMessage.id,
          partIndex,
          partType: "text",
          seq: seq++,
          text,
          done: false,
        })
      }

      // Flush buffered text from first response
      let hasText = textBuffer.length > 0
      if (hasText) {
        console.log(`   First response text: "${textBuffer.join("").substring(0, 200)}..."`)
      }
      for (const text of textBuffer) {
        await appendText(text)
      }

      // Collect tool uses from first response
      const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
      for (const block of firstResponse.content) {
        if (block.type === "tool_use" && block.name !== "stop") {
          console.log(`   Tool call: ${block.name}`)
          toolUses.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          })
        }
      }

      // If no tool uses, we're done
      if (toolUses.length === 0) {
        if (hasText) {
          await session.appendDelta({
            messageId: responseMessage.id,
            partIndex,
            partType: "text",
            seq: seq++,
            done: true,
          })
        }
        console.log(`   Finished: ${firstResponse.stop_reason}`)
      } else {
        // Mark text as done if we have some before tool execution
        if (hasText) {
          await session.appendDelta({
            messageId: responseMessage.id,
            partIndex,
            partType: "text",
            seq: seq++,
            done: true,
          })
          partIndex++
          seq = 0
        }

        // Execute first batch of tools and continue agentic loop
        let currentToolUses = toolUses
        let lastContent: Anthropic.ContentBlock[] = firstResponse.content
        let maxSteps = 4

        while (currentToolUses.length > 0 && maxSteps > 0) {
          maxSteps--

          // Pre-assign partIndex for each tool (call + result = 2 parts each)
          const toolPartIndices = currentToolUses.map((_, i) => ({
            callIndex: partIndex + (i * 2),
            resultIndex: partIndex + (i * 2) + 1,
          }))
          partIndex += currentToolUses.length * 2

          // Write all tool-call deltas first
          for (let i = 0; i < currentToolUses.length; i++) {
            const toolUse = currentToolUses[i]
            await session.appendDelta({
              messageId: responseMessage.id,
              partIndex: toolPartIndices[i].callIndex,
              partType: "tool-call",
              seq: 0,
              toolCallId: toolUse.id,
              toolName: toolUse.name,
              text: JSON.stringify(toolUse.input, null, 2),
              done: true,
            })
          }

          // Update status to tool_executing
          const toolNamesList = currentToolUses.map(t => t.name).join(", ")
          await session.updateStatus({
            agentId,
            messageId: responseMessage.id,
            state: "tool_executing",
            activity: `Running ${currentToolUses.length} tool(s): ${toolNamesList}`,
            toolName: currentToolUses[0].name,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheReadTokens: totalCacheReadTokens,
            cacheWriteTokens: totalCacheWriteTokens,
            costUsd: calculateCost(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens),
            durationMs: Date.now() - startTime,
          })

          // Execute all tools in parallel
          console.log(`   [${Date.now() - startTime}ms] Executing ${currentToolUses.length} tool(s) in parallel...`)
          const toolResultsContent = await Promise.all(
            currentToolUses.map(async (toolUse, i) => {
              const tool = tools[toolUse.name]
              let result: string
              if (!tool) {
                result = `Error: Unknown tool ${toolUse.name}`
              } else {
                result = await tool.execute(toolUse.input)
                console.log(`   Tool ${toolUse.name} result: ${result.substring(0, 100)}...`)
              }

              // Write tool-result delta with pre-assigned index
              await session.appendDelta({
                messageId: responseMessage.id,
                partIndex: toolPartIndices[i].resultIndex,
                partType: "tool-result",
                seq: 0,
                toolCallId: toolUse.id,
                toolName: toolUse.name,
                text: result,
                done: true,
              })

              return {
                type: "tool_result" as const,
                tool_use_id: toolUse.id,
                content: result,
              }
            })
          )

          const toolResults: Anthropic.MessageParam = {
            role: "user",
            content: toolResultsContent,
          }

          // Add assistant message and tool results
          currentMessages = [
            ...currentMessages,
            { role: "assistant" as const, content: lastContent },
            toolResults,
          ]

          // Get next response with streaming
          console.log(`   [${Date.now() - startTime}ms] Calling API for next response...`)
          const stream = client.messages.stream({
            model: agent.model,
            max_tokens: 4096,
            system: agent.systemPrompt,
            messages: currentMessages,
            tools: toolSchemas,
          })

          // Stream text as it arrives
          currentToolUses = []
          for await (const event of stream) {
            if (event.type === "content_block_delta") {
              const delta = event.delta
              if (delta.type === "text_delta") {
                await appendText(delta.text)
                hasText = true
              }
            }
          }

          // Get final message for tool calls
          const nextResponse = await stream.finalMessage()

          // Track additional token usage
          totalInputTokens += nextResponse.usage.input_tokens
          totalOutputTokens += nextResponse.usage.output_tokens
          if ('cache_read_input_tokens' in nextResponse.usage) {
            totalCacheReadTokens += (nextResponse.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0
          }
          if ('cache_creation_input_tokens' in nextResponse.usage) {
            totalCacheWriteTokens += (nextResponse.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0
          }

          console.log(`   [${Date.now() - startTime}ms] Got next response (tokens: in=${nextResponse.usage.input_tokens} out=${nextResponse.usage.output_tokens})`)
          for (const block of nextResponse.content) {
            if (block.type === "tool_use" && block.name !== "stop") {
              console.log(`   Tool call: ${block.name}`)
              currentToolUses.push({
                id: block.id,
                name: block.name,
                input: block.input as Record<string, unknown>,
              })
            }
          }
          lastContent = nextResponse.content

          // If there are more tool calls, mark current text as done
          if (currentToolUses.length > 0 && hasText) {
            await session.appendDelta({
              messageId: responseMessage.id,
              partIndex,
              partType: "text",
              seq: seq++,
              done: true,
            })
            partIndex++
            seq = 0
            hasText = false
          }
        }

        // Final text completion
        if (hasText) {
          await session.appendDelta({
            messageId: responseMessage.id,
            partIndex,
            partType: "text",
            seq: seq++,
            done: true,
          })
        }
      }

      // Final "done" status
      await session.updateStatus({
        agentId,
        messageId: responseMessage.id,
        state: "done",
        activity: "Response complete",
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheWriteTokens: totalCacheWriteTokens,
        costUsd: calculateCost(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens),
        durationMs: Date.now() - startTime,
      })

      console.log(`   [${Date.now() - startTime}ms] Response complete`)
      console.log(`   Total tokens: in=${totalInputTokens} out=${totalOutputTokens} cache_read=${totalCacheReadTokens}`)
      console.log(`   Estimated cost: $${calculateCost(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens).toFixed(6)}`)
    } catch (err) {
      console.error(`   Error processing message:`, err)
      // Error status
      await session.updateStatus({
        agentId,
        state: "error",
        activity: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheWriteTokens: totalCacheWriteTokens,
        costUsd: calculateCost(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens),
        durationMs: Date.now() - startTime,
      })
    }
  }

  console.log(`Listening for new messages...`)
}

main().catch(console.error)
