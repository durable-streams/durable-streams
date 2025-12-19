import { createServerFn } from "@tanstack/react-start"
import { DurableStream } from "@durable-streams/client"
import { chat, type ContentStreamChunk, type StreamChunk } from "@tanstack/ai"
import { createOpenAI } from "@tanstack/ai-openai"
import {
  encodeAudioFrame,
  encodeEndFrame,
  encodeErrorFrame,
  encodeMetadataFrame,
  encodeTextFrame,
} from "../lib/frame-parser"

// Audio chunk type (added to TanStack AI adapter for audio output support)
interface AudioStreamChunk {
  type: "audio"
  id: string
  model: string
  timestamp: number
  data: string
  transcript?: string
  format?: string
}

// Environment configuration
const DURABLE_STREAM_URL =
  process.env.DURABLE_STREAM_URL || `http://localhost:4437`
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// 7 days in seconds
const STREAM_TTL_SECONDS = 7 * 24 * 60 * 60

// System prompt for story generation
const SYSTEM_PROMPT = `You are a friendly storyteller for children. 
First, announce the story title by saying "The title of this story is: [TITLE]"
Then tell a short, engaging story based on the user's prompt.
Keep it appropriate for children ages 4-10.
Keep the story under 2 minutes when read aloud.
Use vivid descriptions and a warm, engaging tone.`

/**
 * Generate a unique stream ID
 */
function generateStreamId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `${timestamp}-${random}`
}

/**
 * Create TanStack AI OpenAI adapter
 */
function createAdapter() {
  if (!OPENAI_API_KEY) {
    throw new Error(`OPENAI_API_KEY is not configured`)
  }
  return createOpenAI(OPENAI_API_KEY)
}

/**
 * Server function to generate a story
 * Creates a durable stream and returns the stream ID immediately
 * Then continues processing the AI response in the background
 */
export const generateStory = createServerFn({ method: `POST` }).handler(
  async (ctx: any) => {
    const prompt = ctx.data?.prompt as string | undefined

    if (!prompt || typeof prompt !== `string`) {
      throw new Error(`Prompt is required`)
    }
    if (prompt.length > 500) {
      throw new Error(`Prompt is too long (max 500 characters)`)
    }

    if (!OPENAI_API_KEY) {
      throw new Error(`OPENAI_API_KEY is not configured`)
    }

    // Generate unique stream ID
    const streamId = generateStreamId()
    const streamUrl = `${DURABLE_STREAM_URL}/v1/stream/${streamId}`

    // Create the durable stream
    const handle = await DurableStream.create({
      url: streamUrl,
      contentType: `application/octet-stream`,
      ttlSeconds: STREAM_TTL_SECONDS,
    })

    // Append metadata frame with prompt
    const metadataFrame = encodeMetadataFrame(prompt)
    await handle.append(metadataFrame)

    // Spawn background task to process AI response
    // We don't await this - it runs in the background
    processStoryGeneration(handle, prompt).catch((error) => {
      console.error(`Story generation failed:`, error)
    })

    // Return stream info immediately
    return {
      streamId,
      streamUrl,
    }
  }
)

/**
 * Process story generation using TanStack AI with audio output
 * 
 * Uses the modified OpenAI adapter that switches to Chat Completions API
 * when modalities includes 'audio', enabling streaming audio generation.
 */
async function processStoryGeneration(
  handle: DurableStream,
  prompt: string
): Promise<void> {
  const adapter = createAdapter()

  try {
    // Create streaming chat with audio output
    const stream = chat({
      adapter,
      model: `gpt-4o-audio-preview` as any,
      messages: [{ role: `user`, content: prompt }],
      systemPrompts: [SYSTEM_PROMPT],
      providerOptions: {
        modalities: [`text`, `audio`],
        audio: { voice: `alloy`, format: `pcm16` },
      } as any,
    })

    let accumulatedText = ``
    let titleExtracted = false
    const titlePattern = /The title of this story is:\s*([^\n.]+)/i

    for await (const chunk of stream) {
      // Handle audio chunks
      if ((chunk as unknown as AudioStreamChunk).type === `audio`) {
        const audioChunk = chunk as unknown as AudioStreamChunk
        if (audioChunk.data) {
          const audioData = Buffer.from(audioChunk.data, `base64`)
          const audioFrame = encodeAudioFrame(new Uint8Array(audioData))
          await handle.append(audioFrame)
        }
        continue
      }

      // Handle content chunks (transcript text)
      if (chunk.type === `content`) {
        const contentChunk = chunk as ContentStreamChunk
        const text = contentChunk.delta
        if (text) {
          accumulatedText += text

          // Extract title from the story
          if (!titleExtracted) {
            const match = accumulatedText.match(titlePattern)
            if (match) {
              const matchEnd = match.index! + match[0].length
              const afterMatch = accumulatedText.substring(matchEnd)
              if (
                afterMatch.includes(`\n`) ||
                afterMatch.includes(`.`) ||
                afterMatch.length > 10
              ) {
                const title = match[1].trim()
                const titleFrame = encodeTextFrame(title, true)
                await handle.append(titleFrame)
                titleExtracted = true

                let storyStart = matchEnd
                const newlineIdx = afterMatch.indexOf(`\n`)
                const periodIdx = afterMatch.indexOf(`.`)
                if (newlineIdx !== -1) {
                  storyStart = matchEnd + newlineIdx + 1
                } else if (periodIdx !== -1) {
                  storyStart = matchEnd + periodIdx + 1
                }

                const remaining = accumulatedText.substring(storyStart).trim()
                if (remaining) {
                  const textFrame = encodeTextFrame(remaining, false)
                  await handle.append(textFrame)
                }
              }
            }
          } else {
            const textFrame = encodeTextFrame(text, false)
            await handle.append(textFrame)
          }
        }
        continue
      }

      // Handle errors
      if (chunk.type === `error`) {
        const errorChunk = chunk as StreamChunk & { error?: { message?: string } }
        throw new Error(errorChunk.error?.message || `Unknown error`)
      }
    }

    // Fallback: use first line as title if pattern wasn't found
    if (!titleExtracted && accumulatedText.length > 0) {
      const firstLine = accumulatedText.split(/[\n.!?]/)[0]?.trim()
      if (firstLine) {
        const titleFrame = encodeTextFrame(firstLine.substring(0, 100), true)
        await handle.append(titleFrame)
      }
    }

    // Send end frame
    const endFrame = encodeEndFrame()
    await handle.append(endFrame)
  } catch (error) {
    console.error(`Story generation error:`, error)
    const errorMessage =
      error instanceof Error ? error.message : `Failed to generate story`
    const errorFrame = encodeErrorFrame(errorMessage, `GENERATION_ERROR`)
    await handle.append(errorFrame)
  }
}
