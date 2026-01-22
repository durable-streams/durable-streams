import { parseSSEStream } from "./durableConnection"
import type { UIMessage } from "@tanstack/ai-react"

/** Resume a stream by directly fetching from the durable proxy endpoint */
export async function resumeStream(
  streamUrl: string,
  readToken: string,
  streamCredentialsKey: string,
  currentMessages: Array<UIMessage>,
  setMessages: (messages: Array<UIMessage>) => void
): Promise<void> {
  const response = await fetch(streamUrl, {
    headers: {
      Authorization: `Bearer ${readToken}`,
      Accept: `text/event-stream`,
    },
  })

  if (!response.ok) {
    let errorMessage = `Resume failed: ${response.status}`
    try {
      const errorBody = await response.text()
      if (errorBody) {
        try {
          const errorJson = JSON.parse(errorBody)
          errorMessage = errorJson.error || errorJson.message || errorBody
        } catch {
          errorMessage = errorBody
        }
      }
    } catch {
      // Ignore body read errors
    }
    throw new Error(errorMessage)
  }

  if (!response.body) {
    throw new Error(`No response body`)
  }

  let assistantContent = ``

  // Find existing assistant message ID or create new one
  const lastMessage =
    currentMessages.length > 0
      ? currentMessages[currentMessages.length - 1]
      : null
  const hasAssistantMessage = lastMessage?.role === `assistant`
  const assistantMessageId = hasAssistantMessage
    ? lastMessage.id
    : `assistant-resume-${Date.now()}`

  const updateMessages = (content: string) => {
    const updatedMessages = [...currentMessages]
    const assistantMessage: UIMessage = {
      id: assistantMessageId,
      role: `assistant`,
      parts: [{ type: `text`, content }],
    }
    if (hasAssistantMessage) {
      updatedMessages[updatedMessages.length - 1] = assistantMessage
    } else {
      updatedMessages.push(assistantMessage)
    }
    setMessages(updatedMessages)
  }

  for await (const event of parseSSEStream(response.body.getReader())) {
    if (event.type === `content`) {
      assistantContent += event.delta
      updateMessages(assistantContent)
    } else if (event.type === `done`) {
      localStorage.removeItem(streamCredentialsKey)
      updateMessages(assistantContent)
      break
    }
  }
}
