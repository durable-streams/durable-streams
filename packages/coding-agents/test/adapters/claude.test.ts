import { describe, expect, it } from "vitest"
import { ClaudeAdapter } from "../../src/adapters/claude.js"

describe(`ClaudeAdapter`, () => {
  const adapter = new ClaudeAdapter()

  it(`should expose the claude agent type`, () => {
    expect(adapter.agentType).toBe(`claude`)
  })

  describe(`parseDirection`, () => {
    it(`should classify a control_request as a request`, () => {
      expect(
        adapter.parseDirection({
          type: `control_request`,
          request_id: `req-1`,
          request: { subtype: `can_use_tool` },
        })
      ).toEqual({ type: `request`, id: `req-1` })
    })

    it(`should classify a control_response as a response`, () => {
      expect(
        adapter.parseDirection({
          type: `control_response`,
          response: { request_id: `req-1`, subtype: `success` },
        })
      ).toEqual({ type: `response`, id: `req-1` })
    })

    it(`should classify assistant messages as notifications`, () => {
      expect(
        adapter.parseDirection({
          type: `assistant`,
          message: { content: [] },
        })
      ).toEqual({ type: `notification` })
    })
  })

  describe(`isTurnComplete`, () => {
    it(`should return true for result messages`, () => {
      expect(
        adapter.isTurnComplete({ type: `result`, subtype: `success` })
      ).toBe(true)
      expect(
        adapter.isTurnComplete({
          type: `result`,
          subtype: `error_during_execution`,
        })
      ).toBe(true)
    })

    it(`should return false for other messages`, () => {
      expect(adapter.isTurnComplete({ type: `assistant` })).toBe(false)
      expect(adapter.isTurnComplete({ type: `stream_event` })).toBe(false)
      expect(adapter.isTurnComplete({ type: `control_request` })).toBe(false)
    })
  })

  it(`should translate prompts into Claude stream-json user messages`, () => {
    expect(
      adapter.translateClientIntent({ type: `user_message`, text: `hello` })
    ).toEqual({
      type: `user`,
      message: {
        role: `user`,
        content: `hello`,
      },
      parent_tool_use_id: null,
      session_id: ``,
    })
  })

  it(`should pass through non-prompt client intents unchanged`, () => {
    const raw = {
      type: `control_response`,
      response: {
        request_id: `req-1`,
        subtype: `success`,
        response: { behavior: `allow` },
      },
    } as const

    expect(adapter.translateClientIntent(raw)).toBe(raw)
  })
})
