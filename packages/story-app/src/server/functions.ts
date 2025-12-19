import { createServerFn } from "@tanstack/react-start"
import { DurableStream } from "@durable-streams/client"
import OpenAI from "openai"
import {
  encodeAudioFrame,
  encodeEndFrame,
  encodeErrorFrame,
  encodeMetadataFrame,
  encodeTextFrame,
} from "../lib/frame-parser"

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
 * Server function to generate a story
 * Creates a durable stream and returns the stream ID immediately
 * Then continues processing OpenAI response in the background
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

    // Spawn background task to process OpenAI response
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
 * Background task to process OpenAI response and stream to durable stream
 */
async function processStoryGeneration(
  handle: DurableStream,
  prompt: string
): Promise<void> {
  const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  })

  try {
    // Create chat completion with audio output
    // Using type assertion for audio modality which is in preview
    const response = await openai.chat.completions.create({
      model: `gpt-4o-audio-preview`,
      modalities: [`text`, `audio`],
      audio: {
        voice: `alloy`,
        format: `pcm16`,
      },
      messages: [
        { role: `system`, content: SYSTEM_PROMPT },
        { role: `user`, content: prompt },
      ],
      stream: true,
    } as unknown as Parameters<typeof openai.chat.completions.create>[0] & {
      stream: true
    })

    let accumulatedText = ``
    let titleExtracted = false
    let pendingTextAfterTitle = ``
    // Match title pattern with the full title line (until newline, period, or we have enough text)
    const titlePattern = /The title of this story is:\s*([^\n.]+)/i

    // The response is a stream when stream: true
    // Type assertion needed because audio modality types are in preview
    const streamResponse = response as AsyncIterable<{
      choices: Array<{ delta: unknown }>
    }>

    // Process the stream
    for await (const chunk of streamResponse) {
      // Type assertion for audio fields which are in preview
      const delta = chunk.choices[0]?.delta as {
        content?: string | null
        audio?: { transcript?: string; data?: string }
      }

      // Handle text/transcript delta
      const transcript = delta.audio?.transcript || delta.content
      if (transcript) {
        accumulatedText += transcript

        // Check for title extraction
        if (!titleExtracted) {
          const match = accumulatedText.match(titlePattern)
          if (match) {
            // Check if we have a newline after the title which confirms it's complete
            const matchEnd = match.index! + match[0].length
            const afterMatch = accumulatedText.substring(matchEnd)

            // Wait for newline or period to confirm title is complete
            if (
              afterMatch.includes(`\n`) ||
              afterMatch.includes(`.`) ||
              afterMatch.length > 10
            ) {
              const title = match[1].trim()
              // Send title frame
              const titleFrame = encodeTextFrame(title, true)
              await handle.append(titleFrame)
              titleExtracted = true

              // Find where the actual story starts (after newline or period)
              let storyStart = matchEnd
              const newlineIdx = afterMatch.indexOf(`\n`)
              const periodIdx = afterMatch.indexOf(`.`)

              if (newlineIdx !== -1) {
                storyStart = matchEnd + newlineIdx + 1
              } else if (periodIdx !== -1) {
                storyStart = matchEnd + periodIdx + 1
              }

              // Send the rest of the accumulated text as regular text
              pendingTextAfterTitle = accumulatedText
                .substring(storyStart)
                .trim()
              if (pendingTextAfterTitle) {
                const textFrame = encodeTextFrame(pendingTextAfterTitle, false)
                await handle.append(textFrame)
                pendingTextAfterTitle = ``
              }
            }
          }
        } else {
          // Title already extracted, send as regular text
          const textFrame = encodeTextFrame(transcript, false)
          await handle.append(textFrame)
        }
      }

      // Handle audio delta - send immediately after text
      if (delta.audio?.data) {
        // Audio data comes as base64 encoded
        const audioData = Buffer.from(delta.audio.data, `base64`)
        const audioFrame = encodeAudioFrame(new Uint8Array(audioData))
        await handle.append(audioFrame)
      }
    }

    // If we didn't find a title pattern, use a default approach
    if (!titleExtracted && accumulatedText.length > 0) {
      // Use the first line or sentence as title
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
    console.error(`OpenAI API error:`, error)

    // Send error frame
    const errorMessage =
      error instanceof Error ? error.message : `Failed to generate story`
    const errorFrame = encodeErrorFrame(errorMessage, `OPENAI_ERROR`)
    await handle.append(errorFrame)
  }
}
