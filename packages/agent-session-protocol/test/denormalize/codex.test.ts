import { describe, expect, it } from "vitest"
import { denormalize } from "../../src/index.js"
import type { NormalizedEvent } from "../../src/types.js"

const events: Array<NormalizedEvent> = [
  {
    v: 1,
    ts: 1000,
    type: `session_init`,
    sessionId: `orig-session`,
    cwd: `/tmp/orig`,
    model: `claude-opus-4-6`,
    agent: `claude`,
    agentVersion: `2.1.83`,
    git: { branch: `main`, commit: `abc123` },
  },
  { v: 1, ts: 2000, type: `user_message`, text: `Hello agent` },
  { v: 1, ts: 3000, type: `thinking`, summary: `Planning`, text: null },
  {
    v: 1,
    ts: 4000,
    type: `assistant_message`,
    text: `I'll help you.`,
    phase: `commentary`,
  },
  {
    v: 1,
    ts: 5000,
    type: `tool_call`,
    callId: `c1`,
    tool: `terminal`,
    input: { cmd: `pwd` },
  },
  {
    v: 1,
    ts: 6000,
    type: `tool_result`,
    callId: `c1`,
    output: `/tmp/test`,
    isError: false,
  },
  {
    v: 1,
    ts: 7000,
    type: `tool_call`,
    callId: `c2`,
    tool: `file_edit`,
    input: { raw: `*** Begin Patch\n*** Update File: foo.ts` },
  },
  {
    v: 1,
    ts: 8000,
    type: `tool_result`,
    callId: `c2`,
    output: `Success`,
    isError: false,
  },
  {
    v: 1,
    ts: 9000,
    type: `assistant_message`,
    text: `Done.`,
    phase: `final`,
  },
]

describe(`denormalize to codex`, () => {
  const lines = denormalize(events, `codex`, {
    sessionId: `codex-thread-001`,
    cwd: `/tmp/codex-test`,
  })

  it(`produces valid JSONL`, () => {
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it(`starts with session_meta using overridden id and cwd`, () => {
    const first = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(first.type).toBe(`session_meta`)
    const payload = first.payload as Record<string, unknown>
    expect(payload.id).toBe(`codex-thread-001`)
    expect(payload.cwd).toBe(`/tmp/codex-test`)
    expect(payload.model_provider).toBe(`openai`)
  })

  it(`emits user message as response_item[message][user]`, () => {
    const userMsgs = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      return (
        obj.type === `response_item` &&
        payload?.type === `message` &&
        payload?.role === `user`
      )
    })
    expect(userMsgs.length).toBe(1)
    const payload = (
      JSON.parse(userMsgs[0]!) as Record<string, unknown>
    ).payload as Record<string, unknown>
    const content = payload.content as Array<Record<string, unknown>>
    expect(content[0]!.text).toBe(`Hello agent`)
  })

  it(`emits reasoning for thinking`, () => {
    const reasoningLines = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      return obj.type === `response_item` && payload?.type === `reasoning`
    })
    expect(reasoningLines.length).toBe(1)
  })

  it(`maps terminal to function_call with exec_command`, () => {
    const calls = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      return obj.type === `response_item` && payload?.type === `function_call`
    })
    expect(calls.length).toBe(1)
    const payload = (JSON.parse(calls[0]!) as Record<string, unknown>)
      .payload as Record<string, unknown>
    expect(payload.name).toBe(`exec_command`)
    expect(payload.call_id).toBe(`c1`)
  })

  it(`maps file_edit to custom_tool_call with apply_patch`, () => {
    const calls = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      return (
        obj.type === `response_item` && payload?.type === `custom_tool_call`
      )
    })
    expect(calls.length).toBe(1)
    const payload = (JSON.parse(calls[0]!) as Record<string, unknown>)
      .payload as Record<string, unknown>
    expect(payload.name).toBe(`apply_patch`)
    expect(payload.call_id).toBe(`c2`)
  })

  it(`emits function_call_output for terminal tool_result`, () => {
    const outputs = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      return (
        obj.type === `response_item` &&
        payload?.type === `function_call_output`
      )
    })
    expect(outputs.length).toBe(1)
    const payload = (JSON.parse(outputs[0]!) as Record<string, unknown>)
      .payload as Record<string, unknown>
    expect(payload.call_id).toBe(`c1`)
    expect(payload.output).toBe(`/tmp/test`)
  })

  it(`emits custom_tool_call_output for file_edit tool_result`, () => {
    const outputs = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      return (
        obj.type === `response_item` &&
        payload?.type === `custom_tool_call_output`
      )
    })
    expect(outputs.length).toBe(1)
    const payload = (JSON.parse(outputs[0]!) as Record<string, unknown>)
      .payload as Record<string, unknown>
    expect(payload.call_id).toBe(`c2`)
  })

  it(`emits assistant messages with phase mapping`, () => {
    const msgs = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      return (
        obj.type === `response_item` &&
        payload?.type === `message` &&
        payload?.role === `assistant`
      )
    })
    expect(msgs.length).toBe(2)
    const first = (JSON.parse(msgs[0]!) as Record<string, unknown>)
      .payload as Record<string, unknown>
    expect(first.phase).toBe(`commentary`)
    const second = (JSON.parse(msgs[1]!) as Record<string, unknown>)
      .payload as Record<string, unknown>
    expect(second.phase).toBe(`final_answer`)
  })
})
