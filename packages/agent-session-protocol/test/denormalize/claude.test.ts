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
    model: `gpt-5`,
    agent: `codex`,
    agentVersion: `0.99.0`,
    git: { branch: `main` },
  },
  { v: 1, ts: 2000, type: `user_message`, text: `Hello agent` },
  { v: 1, ts: 3000, type: `thinking`, summary: `Planning`, text: null },
  {
    v: 1,
    ts: 4000,
    type: `assistant_message`,
    text: `I'll help you.`,
  },
  {
    v: 1,
    ts: 5000,
    type: `tool_call`,
    callId: `c1`,
    tool: `file_read`,
    input: { file_path: `/tmp/foo.ts` },
  },
  {
    v: 1,
    ts: 6000,
    type: `tool_result`,
    callId: `c1`,
    output: `const x = 1`,
    isError: false,
  },
  {
    v: 1,
    ts: 7000,
    type: `assistant_message`,
    text: `Done.`,
  },
  {
    v: 1,
    ts: 8000,
    type: `turn_complete`,
    success: true,
    usage: { inputTokens: 100, outputTokens: 50 },
  },
]

describe(`denormalize to claude`, () => {
  const lines = denormalize(events, `claude`, {
    sessionId: `claude-session-001`,
    cwd: `/tmp/claude-test`,
  })

  it(`produces valid JSONL`, () => {
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it(`starts with system/init using overridden sessionId and cwd`, () => {
    const first = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(first.type).toBe(`system`)
    expect(first.subtype).toBe(`init`)
    expect(first.sessionId).toBe(`claude-session-001`)
    expect(first.cwd).toBe(`/tmp/claude-test`)
  })

  it(`emits user entry for user_message`, () => {
    const userLines = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      return obj.type === `user` && !(obj.message as Record<string, unknown>)?.content?.toString().includes(`tool_result`)
    })
    expect(userLines.length).toBeGreaterThanOrEqual(1)
    const first = JSON.parse(userLines[0]!) as Record<string, unknown>
    const msg = first.message as Record<string, unknown>
    expect(msg.content).toBe(`Hello agent`)
  })

  it(`embeds text and tool_use in assistant content array, skips empty thinking`, () => {
    const assistantLines = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      return obj.type === `assistant`
    })
    expect(assistantLines.length).toBeGreaterThanOrEqual(1)

    // First assistant should contain text + tool_use (thinking skipped because text is null)
    const first = JSON.parse(assistantLines[0]!) as Record<string, unknown>
    const msg = first.message as Record<string, unknown>
    const content = msg.content as Array<Record<string, unknown>>
    const types = content.map((b) => b.type)
    expect(types).not.toContain(`thinking`) // null text → skipped
    expect(types).toContain(`text`)
    expect(types).toContain(`tool_use`)
  })

  it(`maps normalized tool names back to claude names`, () => {
    const assistantLines = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      return obj.type === `assistant`
    })
    const first = JSON.parse(assistantLines[0]!) as Record<string, unknown>
    const msg = first.message as Record<string, unknown>
    const content = msg.content as Array<Record<string, unknown>>
    const toolUse = content.find((b) => b.type === `tool_use`)
    expect(toolUse).toBeDefined()
    expect(toolUse!.name).toBe(`Read`) // file_read → Read
  })

  it(`emits tool_result as user entry`, () => {
    const toolResults = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      if (obj.type !== `user`) return false
      const msg = obj.message as Record<string, unknown>
      const content = msg.content
      return (
        Array.isArray(content) &&
        content.some((b: Record<string, unknown>) => b.type === `tool_result`)
      )
    })
    expect(toolResults.length).toBe(1)
    const obj = JSON.parse(toolResults[0]!) as Record<string, unknown>
    const content = (obj.message as Record<string, unknown>)
      .content as Array<Record<string, unknown>>
    // The denormalizer generates Claude-format IDs (toolu_01...) for non-Claude call IDs
    expect(content[0]!.tool_use_id).toMatch(/^toolu_/)
  })

  it(`emits system/turn_duration for turn_complete`, () => {
    const turnLines = lines.filter((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>
      return obj.type === `system` && obj.subtype === `turn_duration`
    })
    expect(turnLines.length).toBe(1)
  })
})
