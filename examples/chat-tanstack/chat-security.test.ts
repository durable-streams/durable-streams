import { afterEach, describe, expect, test } from "vitest"
import { handleChatPost } from "./src/routes/api/chat"
import { requireAuth } from "./src/lib/auth.server"
import { resolveChatFile } from "./src/lib/chat-id"

const previous = process.env.CHAT_AUTH_TOKEN
afterEach(() => {
  process.env.CHAT_AUTH_TOKEN = previous
})

describe(`TanStack chat security boundary`, () => {
  test.each([`/`, `/chat`, `/api/chats`, `/api/chat-stream?id=x`, `/api/chat`])(
    `fails closed for unauthenticated server boundary %s`,
    (pathname) => {
      delete process.env.CHAT_AUTH_TOKEN
      expect(requireAuth(new Request(`http://app${pathname}`))?.status).toBe(
        401
      )
    }
  )

  test.each([
    `../escape`,
    `a/b`,
    `a%2fb`,
    `a%5cb`,
    ` white`,
    `white `,
    `a b`,
    `x`.repeat(65),
  ])(
    `POST rejects invalid id %j before persistence/model access`,
    async (id) => {
      process.env.CHAT_AUTH_TOKEN = `secret`
      const response = await handleChatPost({
        request: new Request(`http://app/api/chat`, {
          method: `POST`,
          headers: {
            authorization: `Bearer secret`,
            "content-type": `application/json`,
          },
          body: JSON.stringify({ id, messages: [] }),
        }),
      })
      expect(response.status).toBe(400)
    }
  )

  test(`resolved chat files remain inside the chat root`, () => {
    expect(resolveChatFile(`/tmp/chats`, `safe-id`)).toBe(
      `/tmp/chats/safe-id.json`
    )
    expect(() => resolveChatFile(`/tmp/chats`, `../outside`)).toThrow(
      `Invalid chat id`
    )
  })
})
