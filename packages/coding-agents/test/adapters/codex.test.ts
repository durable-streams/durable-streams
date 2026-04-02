import { describe, expect, it } from "vitest"
import { CodexAdapter } from "../../src/adapters/codex.js"

describe(`CodexAdapter`, () => {
  const adapter = new CodexAdapter()

  it(`should expose the codex agent type`, () => {
    expect(adapter.agentType).toBe(`codex`)
  })

  describe(`parseDirection`, () => {
    it(`should classify app-server requests as requests`, () => {
      expect(
        adapter.parseDirection({
          id: 1,
          method: `item/commandExecution/requestApproval`,
          params: {},
        })
      ).toEqual({ type: `request`, id: 1 })
    })

    it(`should classify JSON-RPC responses as responses`, () => {
      expect(
        adapter.parseDirection({
          jsonrpc: `2.0`,
          id: 1,
          result: { success: true },
        })
      ).toEqual({ type: `response`, id: 1 })
    })

    it(`should classify notifications and items correctly`, () => {
      expect(
        adapter.parseDirection({
          method: `turn/started`,
          params: {},
        })
      ).toEqual({ type: `notification` })

      expect(
        adapter.parseDirection({
          type: `item`,
          item: { type: `agentMessage` },
        })
      ).toEqual({ type: `notification` })
    })
  })

  describe(`isTurnComplete`, () => {
    it(`should complete turns when app-server emits turn/completed`, () => {
      expect(
        adapter.isTurnComplete({
          method: `turn/completed`,
          params: {
            threadId: `thread-1`,
            turn: { id: `turn-1`, status: `completed`, items: [], error: null },
          },
        })
      ).toBe(true)

      expect(
        adapter.isTurnComplete({
          method: `turn/started`,
          params: {
            threadId: `thread-1`,
            turn: {
              id: `turn-1`,
              status: `inProgress`,
              items: [],
              error: null,
            },
          },
        })
      ).toBe(false)
    })
  })

  describe(`translateClientIntent`, () => {
    it(`should translate a user_message to turn/start`, () => {
      expect(
        adapter.translateClientIntent({
          type: `user_message`,
          text: `Fix the bug`,
        })
      ).toMatchObject({
        jsonrpc: `2.0`,
        method: `turn/start`,
        params: {
          threadId: ``,
          input: [
            {
              type: `text`,
              text: `Fix the bug`,
              text_elements: [],
            },
          ],
        },
      })
    })

    it(`should translate an untyped control_response to a JSON-RPC response`, () => {
      expect(
        adapter.translateClientIntent({
          type: `control_response`,
          response: {
            request_id: 42,
            subtype: `success`,
            response: { behavior: `allow` },
          },
        })
      ).toEqual({
        jsonrpc: `2.0`,
        id: 42,
        result: { behavior: `allow` },
      })
    })

    it(`should translate an interrupt to a JSON-RPC cancel`, () => {
      expect(adapter.translateClientIntent({ type: `interrupt` })).toEqual({
        jsonrpc: `2.0`,
        id: expect.any(String),
        method: `turn/interrupt`,
        params: {
          threadId: ``,
          turnId: ``,
        },
      })
    })
  })
})
