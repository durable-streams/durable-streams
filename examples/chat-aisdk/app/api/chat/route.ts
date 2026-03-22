import { openai } from "@ai-sdk/openai"
import { convertToModelMessages, streamText } from "ai"
import { toDurableStreamResponse } from "@durable-streams/aisdk-transport"
import { saveChat, saveChatMessages } from "../../lib/chat-store"
import {
  DURABLE_STREAMS_WRITE_HEADERS,
  assertOpenAiApiKeyConfigured,
  buildReadProxyUrl,
  buildWriteStreamUrl,
} from "../../utils"
import type { UIMessage } from "ai"

export async function POST(request: Request) {
  assertOpenAiApiKeyConfigured()

  const { messages, id }: { messages: Array<UIMessage>; id: string } =
    await request.json()

  if (id) {
    await saveChatMessages({ id, messages })
  }

  const result = streamText({
    model: openai(`gpt-4o-mini`),
    messages: await convertToModelMessages(messages),
  })

  // Each generation writes to its own durable stream path.
  const streamPath = `chat/${id}/${crypto.randomUUID()}`

  if (id) {
    // Persist the currently active stream so a page refresh can reconnect.
    await saveChat({ id, activeStreamId: streamPath })
  }

  return toDurableStreamResponse({
    source: result.toUIMessageStream({
      originalMessages: messages,
      onFinish: ({ messages: finalMessages }) => {
        if (id) {
          // Persist completion and clear active stream atomically to avoid races.
          void saveChat({ id, messages: finalMessages, activeStreamId: null })
        }
      },
    }),
    stream: {
      writeUrl: buildWriteStreamUrl(streamPath),
      // Return an app route for reads so auth/secrets stay server-side.
      readUrl: buildReadProxyUrl(request, streamPath),
      headers: DURABLE_STREAMS_WRITE_HEADERS,
    },
  })
}
