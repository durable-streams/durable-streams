import { afterEach, describe, expect, test } from "vitest"
import { GET as listChats } from "./app/api/chats/route"
import { GET as readTranscript } from "./app/api/chat-stream/route"
import { POST as runModel } from "./app/api/chat/route"
import { middleware } from "./middleware"
import { resolveChatFile } from "./app/lib/chat-id"

const previous = process.env.CHAT_AUTH_TOKEN
afterEach(() => {
  process.env.CHAT_AUTH_TOKEN = previous
})

describe(`chat AI SDK security boundary`, () => {
  test(`fails closed for index, chat index, transcript, and model routes`, async () => {
    delete process.env.CHAT_AUTH_TOKEN
    expect(middleware(new Request(`http://app/`)).status).toBe(401)
    expect(middleware(new Request(`http://app/chat`)).status).toBe(401)
    expect((await listChats(new Request(`http://app/api/chats`))).status).toBe(
      401
    )
    expect(
      (
        await readTranscript(
          new Request(`http://app/api/chat-stream?path=chat/x`)
        )
      ).status
    ).toBe(401)
    expect(
      (await runModel(new Request(`http://app/api/chat`, { method: `POST` })))
        .status
    ).toBe(401)
  })

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
      const response = await runModel(
        new Request(`http://app/api/chat`, {
          method: `POST`,
          headers: {
            authorization: `Bearer secret`,
            "content-type": `application/json`,
          },
          body: JSON.stringify({ id, messages: [] }),
        })
      )
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
