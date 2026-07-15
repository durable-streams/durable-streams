import { describe, expect, it, vi } from "vitest"
import { authorizeChatRequest } from "./auth"
import { parseChatId } from "./chat-id"
import { createChatWorker } from "./chat-worker"
import { resolveChatRequest } from "./chat-request"

describe(`deploy security boundary`, () => {
  it.each([`/api/chats`, `/api/chat-stream?id=x`, `/api/chat`])(
    `rejects unauthenticated access to %s`,
    async (path) => {
      const downstream = {
        fetch: vi.fn(() => Promise.resolve(new Response(`model`))),
      }
      const worker = createChatWorker(downstream, () => `secret`)
      const request = new Request(`https://chat.example${path}`)
      expect((await worker.fetch(request)).status).toBe(401)
      expect(downstream.fetch).not.toHaveBeenCalled()
      expect(authorizeChatRequest(request, undefined)?.status).toBe(503)
    }
  )

  it(`allows the configured bearer token`, () => {
    const request = new Request(`https://chat.example/api/chat`, {
      headers: { Authorization: `Bearer secret` },
    })
    expect(authorizeChatRequest(request, `secret`)).toBeUndefined()
  })
})

describe(`POST chat route`, () => {
  const post = (id: string) =>
    new Request(`https://chat.example/api/chat`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({ id, messages: [] }),
    })

  it(`base behavior canonicalizes traversal to the chats index stream`, async () => {
    const base = await resolveChatRequest(post(`../chats/index`), (value) =>
      String(value)
    )
    expect(base.ok && new URL(base.writeUrl).pathname).toBe(
      `/streams/chats/index`
    )
  })

  it.each([
    `../chats/index`,
    `a/b`,
    `%2e%2e%2fchats%2findex`,
    ` chat `,
    `x`.repeat(129),
  ])(`rejects invalid route id %j`, async (id) => {
    const result = await resolveChatRequest(post(id))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(400)
  })
})

describe(`chat id parser`, () => {
  it.each([
    `../chats/index`,
    `a/b`,
    `%2e%2e%2fchats%2findex`,
    ` chat `,
    `x`.repeat(129),
  ])(`rejects %j`, (id) => expect(parseChatId(id)).toBeNull())
  it(`accepts generated-id characters`, () => {
    expect(parseChatId(`abc_DEF-123`)).toBe(`abc_DEF-123`)
  })
})
