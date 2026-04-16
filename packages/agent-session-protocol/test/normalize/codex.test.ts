import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { normalize } from "../../src/index.js"

const fixture = readFileSync(
  join(__dirname, `..`, `fixtures`, `codex-session.jsonl`),
  `utf8`
)
const lines = fixture.split(`\n`).filter((l) => l.trim())

describe(`normalize codex`, () => {
  const events = normalize(lines, `codex`)

  it(`emits session_init from session_meta`, () => {
    const init = events.find((e) => e.type === `session_init`)
    expect(init).toBeDefined()
    if (init!.type !== `session_init`) return
    expect(init.sessionId).toBe(`test-thread-001`)
    expect(init.cwd).toBe(`/tmp/test-project`)
    expect(init.agent).toBe(`codex`)
    expect(init.agentVersion).toBe(`0.99.0-alpha.5`)
    expect(init.git?.branch).toBe(`main`)
    expect(init.git?.commit).toBe(`abc123`)
    expect(init.git?.remote).toBe(`https://github.com/test/repo.git`)
  })

  it(`emits user_message`, () => {
    const userMsgs = events.filter((e) => e.type === `user_message`)
    expect(userMsgs.length).toBe(1)
    const first = userMsgs[0]!
    if (first.type !== `user_message`) return
    expect(first.text).toContain(`health check`)
  })

  it(`emits thinking from reasoning`, () => {
    const thinking = events.filter((e) => e.type === `thinking`)
    expect(thinking.length).toBe(1)
    const first = thinking[0]!
    if (first.type !== `thinking`) return
    expect(first.summary).toContain(`Reading the source file`)
    expect(first.text).toBeNull()
  })

  it(`emits assistant_message with phase`, () => {
    const msgs = events.filter((e) => e.type === `assistant_message`)
    expect(msgs.length).toBe(2)

    const commentary = msgs[0]!
    if (commentary.type !== `assistant_message`) return
    expect(commentary.phase).toBe(`commentary`)

    const final = msgs[1]!
    if (final.type !== `assistant_message`) return
    expect(final.phase).toBe(`final`)
  })

  it(`normalizes exec_command cat to file_read`, () => {
    const calls = events.filter((e) => e.type === `tool_call`)
    const catCall = calls.find(
      (e) => e.type === `tool_call` && e.callId === `call-001`
    )
    expect(catCall).toBeDefined()
    if (catCall?.type !== `tool_call`) return
    expect(catCall.tool).toBe(`file_read`)
    expect(catCall.originalTool).toBe(`exec_command`)
    expect(catCall.originalAgent).toBe(`codex`)
  })

  it(`normalizes apply_patch to file_edit`, () => {
    const calls = events.filter((e) => e.type === `tool_call`)
    const patchCall = calls.find(
      (e) => e.type === `tool_call` && e.callId === `call-002`
    )
    expect(patchCall).toBeDefined()
    if (patchCall?.type !== `tool_call`) return
    expect(patchCall.tool).toBe(`file_edit`)
    expect(patchCall.originalTool).toBe(`apply_patch`)
  })

  it(`emits tool_result for function_call_output`, () => {
    const results = events.filter((e) => e.type === `tool_result`)
    const catResult = results.find(
      (e) => e.type === `tool_result` && e.callId === `call-001`
    )
    expect(catResult).toBeDefined()
    if (catResult?.type !== `tool_result`) return
    expect(catResult.output).toContain(`express`)
  })

  it(`parses custom_tool_call_output correctly`, () => {
    const results = events.filter((e) => e.type === `tool_result`)
    const patchResult = results.find(
      (e) => e.type === `tool_result` && e.callId === `call-002`
    )
    expect(patchResult).toBeDefined()
    if (patchResult?.type !== `tool_result`) return
    expect(patchResult.output).toContain(`Success`)
    expect(patchResult.isError).toBe(false)
  })
})
