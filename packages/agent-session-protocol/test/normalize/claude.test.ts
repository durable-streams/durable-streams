import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { normalize } from "../../src/index.js"

const fixture = readFileSync(
  join(__dirname, `..`, `fixtures`, `claude-session.jsonl`),
  `utf8`
)
const lines = fixture.split(`\n`).filter((l) => l.trim())

describe(`normalize claude`, () => {
  const events = normalize(lines, `claude`)

  it(`emits session_init from system/init`, () => {
    const init = events.find((e) => e.type === `session_init`)
    expect(init).toBeDefined()
    expect(init!.type).toBe(`session_init`)
    if (init!.type !== `session_init`) return
    expect(init.sessionId).toBe(`test-session-001`)
    expect(init.cwd).toBe(`/tmp/test-project`)
    expect(init.agent).toBe(`claude`)
    expect(init.agentVersion).toBe(`2.1.83`)
  })

  it(`emits user_message`, () => {
    const userMsgs = events.filter((e) => e.type === `user_message`)
    expect(userMsgs.length).toBeGreaterThanOrEqual(1)
    const first = userMsgs[0]!
    if (first.type !== `user_message`) return
    expect(first.text).toContain(`health check`)
  })

  it(`emits thinking from assistant thinking blocks`, () => {
    const thinking = events.filter((e) => e.type === `thinking`)
    expect(thinking.length).toBeGreaterThanOrEqual(1)
    const first = thinking[0]!
    if (first.type !== `thinking`) return
    expect(first.text).toBe(`I need to read the file first`)
  })

  it(`emits assistant_message from text blocks`, () => {
    const msgs = events.filter((e) => e.type === `assistant_message`)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
  })

  it(`emits tool_call with normalized tool name`, () => {
    const calls = events.filter((e) => e.type === `tool_call`)
    expect(calls.length).toBe(2)

    const readCall = calls[0]!
    if (readCall.type !== `tool_call`) return
    expect(readCall.tool).toBe(`file_read`)
    expect(readCall.originalTool).toBe(`Read`)
    expect(readCall.callId).toBe(`tool-001`)

    const editCall = calls[1]!
    if (editCall.type !== `tool_call`) return
    expect(editCall.tool).toBe(`file_edit`)
    expect(editCall.originalTool).toBe(`Edit`)
    expect(editCall.callId).toBe(`tool-002`)
  })

  it(`emits tool_result paired by callId`, () => {
    const results = events.filter((e) => e.type === `tool_result`)
    expect(results.length).toBe(2)

    const readResult = results[0]!
    if (readResult.type !== `tool_result`) return
    expect(readResult.callId).toBe(`tool-001`)
    expect(readResult.output).toContain(`express`)
    expect(readResult.isError).toBe(false)
  })

  it(`emits turn_complete`, () => {
    const completes = events.filter((e) => e.type === `turn_complete`)
    expect(completes.length).toBeGreaterThanOrEqual(1)
  })

  it(`preserves event ordering`, () => {
    const types = events.map((e) => e.type)
    const initIdx = types.indexOf(`session_init`)
    const userIdx = types.indexOf(`user_message`)
    const toolCallIdx = types.indexOf(`tool_call`)
    const toolResultIdx = types.indexOf(`tool_result`)

    expect(initIdx).toBeLessThan(userIdx)
    expect(userIdx).toBeLessThan(toolCallIdx)
    expect(toolCallIdx).toBeLessThan(toolResultIdx)
  })
})
