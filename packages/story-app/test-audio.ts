/**
 * Test script to verify TanStack AI audio streaming works
 * Run with: npx tsx test-audio.ts
 */
import { chat } from "@tanstack/ai"
import { createOpenAI } from "@tanstack/ai-openai"

const OPENAI_API_KEY = process.env.OPENAI_API_KEY

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY environment variable is required")
  process.exit(1)
}

async function testAudioStreaming() {
  console.log("Creating OpenAI adapter...")
  const adapter = createOpenAI(OPENAI_API_KEY)

  console.log("Starting chat with audio modalities...")
  
  const providerOptions = {
    modalities: ["text", "audio"] as const,
    audio: { voice: "alloy" as const, format: "pcm16" as const },
  }
  
  console.log("Provider options:", JSON.stringify(providerOptions, null, 2))

  const stream = chat({
    adapter,
    model: "gpt-4o-audio-preview" as any,
    messages: [{ role: "user", content: "Say hello in one word" }],
    providerOptions: providerOptions as any,
  })

  let textContent = ""
  let audioChunks = 0
  let audioBytes = 0

  console.log("\nStreaming response...")
  
  try {
    for await (const chunk of stream) {
      console.log(`Chunk type: ${chunk.type}`)
      
      if (chunk.type === "content") {
        const c = chunk as any
        textContent += c.delta || ""
        console.log(`  Content delta: "${c.delta}"`)
      }
      
      if (chunk.type === "audio") {
        const c = chunk as any
        audioChunks++
        if (c.data) {
          audioBytes += c.data.length
        }
        console.log(`  Audio chunk #${audioChunks}, data length: ${c.data?.length || 0}`)
      }
      
      if (chunk.type === "error") {
        const c = chunk as any
        console.error(`  ERROR: ${c.error?.message}`)
      }
      
      if (chunk.type === "done") {
        console.log(`  Done, finish reason: ${(chunk as any).finishReason}`)
      }
    }
    
    console.log("\n=== Summary ===")
    console.log(`Text content: "${textContent}"`)
    console.log(`Audio chunks: ${audioChunks}`)
    console.log(`Total audio data (base64 chars): ${audioBytes}`)
    console.log("SUCCESS!")
    
  } catch (error) {
    console.error("\nError during streaming:", error)
    process.exit(1)
  }
}

testAudioStreaming()
