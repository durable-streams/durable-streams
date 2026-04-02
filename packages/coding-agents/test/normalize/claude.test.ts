import { describe, expect, it } from "vitest"
import { normalizeClaude } from "../../src/normalize/claude.js"

describe(`normalizeClaude`, () => {
  it(`should normalize a system init message`, () => {
    const raw = {
      type: `system`,
      subtype: `init`,
      session_id: `sess-123`,
      model: `claude-sonnet-4-5-20250514`,
      tools: [],
    }

    expect(normalizeClaude(raw)).toEqual({
      type: `session_init`,
      sessionId: `sess-123`,
      model: `claude-sonnet-4-5-20250514`,
      permissionMode: undefined,
    })
  })

  it(`should normalize an assistant message`, () => {
    const raw = {
      type: `assistant`,
      message: {
        content: [{ type: `text`, text: `Hello world` }],
      },
    }

    expect(normalizeClaude(raw)).toEqual({
      type: `assistant_message`,
      content: [{ type: `text`, text: `Hello world` }],
    })
  })

  it(`should normalize a stream_event text delta`, () => {
    const raw = {
      type: `stream_event`,
      event: {
        type: `content_block_delta`,
        delta: { type: `text_delta`, text: `Hello` },
      },
    }

    expect(normalizeClaude(raw)).toEqual({
      type: `stream_delta`,
      delta: { kind: `text`, text: `Hello` },
    })
  })

  it(`should normalize a stream_event thinking delta`, () => {
    const raw = {
      type: `stream_event`,
      event: {
        type: `content_block_delta`,
        delta: { type: `thinking_delta`, thinking: `Let me think...` },
      },
    }

    expect(normalizeClaude(raw)).toEqual({
      type: `stream_delta`,
      delta: { kind: `thinking`, text: `Let me think...` },
    })
  })

  it(`should normalize a permission request`, () => {
    const raw = {
      type: `control_request`,
      request_id: `req-42`,
      request: {
        subtype: `can_use_tool`,
        tool_name: `Bash`,
        input: { command: `npm install` },
      },
    }

    expect(normalizeClaude(raw)).toEqual({
      type: `permission_request`,
      id: `req-42`,
      tool: `Bash`,
      input: { command: `npm install` },
    })
  })

  it(`should normalize a success result`, () => {
    const raw = {
      type: `result`,
      subtype: `success`,
      cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
    }

    expect(normalizeClaude(raw)).toEqual({
      type: `turn_complete`,
      success: true,
      cost: {
        inputTokens: 1000,
        outputTokens: 500,
        totalCost: 0.05,
      },
    })
  })

  it(`should normalize an error result`, () => {
    expect(
      normalizeClaude({
        type: `result`,
        subtype: `error_during_execution`,
      })
    ).toEqual({
      type: `turn_complete`,
      success: false,
    })
  })

  it(`should normalize a tool_progress event`, () => {
    expect(
      normalizeClaude({
        type: `tool_progress`,
        tool_use_id: `tool-1`,
        elapsed: 5000,
      })
    ).toEqual({
      type: `tool_progress`,
      toolUseId: `tool-1`,
      elapsed: 5000,
    })
  })

  it(`should return unknown for unrecognized types`, () => {
    const raw = { type: `some_future_type`, data: 123 }
    expect(normalizeClaude(raw)).toEqual({
      type: `unknown`,
      rawType: `some_future_type`,
      raw,
    })
  })

  it(`should skip keep_alive and user echo messages`, () => {
    expect(normalizeClaude({ type: `keep_alive` })).toBeNull()
    expect(normalizeClaude({ type: `user` })).toBeNull()
    expect(normalizeClaude({ type: `rate_limit_event` })).toBeNull()
  })
})
