import { openai } from "@ai-sdk/openai"
import { convertToModelMessages, streamText } from "ai"
import { saveChatMessages } from "../../lib/chat-store"
import { assertOpenAiApiKeyConfigured } from "../../utils"
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

  result.consumeStream()

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: ({ messages }) => {
      if (id) {
        void saveChatMessages({ id, messages })
      }
    },
  })
}
