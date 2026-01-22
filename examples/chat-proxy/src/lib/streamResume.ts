import { resume } from "@durable-streams/proxy/client"
import { parseTanStackSSE } from "./durableConnection"
import type { UIMessage } from "@tanstack/ai-react"

/** Resume a stream using the proxy client's resume function */
export async function resumeStream(
  proxyUrl: string,
  streamKey: string,
  readToken: string,
  offset: string,
  streamCredentialsKey: string,
  currentMessages: Array<UIMessage>,
  setMessages: (messages: Array<UIMessage>) => void
): Promise<void> {
  const response = await resume({
    proxyUrl,
    streamKey,
    readToken,
    offset,
  })

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

  for await (const event of parseTanStackSSE(response.body.getReader())) {
    if (event.type === `content`) {
      assistantContent += event.delta || ``
      updateMessages(assistantContent)
    } else if (event.type === `done`) {
      localStorage.removeItem(streamCredentialsKey)
      updateMessages(assistantContent)
      break
    }
  }
}
