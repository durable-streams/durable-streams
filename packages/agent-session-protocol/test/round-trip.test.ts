import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { denormalize, normalize } from "../src/index.js"
import type { NormalizedEvent } from "../src/types.js"

const claudeFixture = readFileSync(
  join(__dirname, `fixtures`, `claude-session.jsonl`),
  `utf8`
)
const claudeLines = claudeFixture.split(`\n`).filter((l) => l.trim())

const codexFixture = readFileSync(
  join(__dirname, `fixtures`, `codex-session.jsonl`),
  `utf8`
)
const codexLines = codexFixture.split(`\n`).filter((l) => l.trim())

function countByType(
  events: Array<NormalizedEvent>,
  type: string
): number {
  return events.filter((e) => e.type === type).length
}

describe(`round-trip: Claude → normalized → Codex`, () => {
  const normalized = normalize(claudeLines, `claude`)
  const codexOutput = denormalize(normalized, `codex`, {
    sessionId: `round-trip-001`,
    cwd: `/tmp/round-trip`,
  })

  it(`produces valid Codex JSONL`, () => {
    for (const line of codexOutput) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it(`starts with session_meta`, () => {
    const first = JSON.parse(codexOutput[0]!) as Record<string, unknown>
    expect(first.type).toBe(`session_meta`)
    const payload = first.payload as Record<string, unknown>
    expect(payload.id).toBe(`round-trip-001`)
    expect(payload.cwd).toBe(`/tmp/round-trip`)
  })

  it(`includes user messages`, () => {
    const userMsgs = codexOutput.filter((line) => {
      const obj = JSON.parse(line) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      return (
        obj.type === `response_item` &&
        payload?.type === `message` &&
        payload?.role === `user`
      )
    })
    expect(userMsgs.length).toBeGreaterThanOrEqual(1)
  })

  it(`includes function calls and outputs`, () => {
    const calls = codexOutput.filter((line) => {
      const obj = JSON.parse(line) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      return (
        obj.type === `response_item` &&
        (payload?.type === `function_call` ||
          payload?.type === `custom_tool_call`)
      )
    })
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it(`re-normalizes back to equivalent events`, () => {
    const reNormalized = normalize(codexOutput, `codex`)
    // Should have similar event types
    expect(countByType(reNormalized, `session_init`)).toBe(1)
    expect(countByType(reNormalized, `user_message`)).toBe(
      countByType(normalized, `user_message`)
    )
    expect(countByType(reNormalized, `tool_call`)).toBe(
      countByType(normalized, `tool_call`)
    )
    expect(countByType(reNormalized, `tool_result`)).toBe(
      countByType(normalized, `tool_result`)
    )
  })
})

describe(`round-trip: Codex → normalized → Claude`, () => {
  const normalized = normalize(codexLines, `codex`)
  const claudeOutput = denormalize(normalized, `claude`, {
    sessionId: `round-trip-002`,
    cwd: `/tmp/round-trip`,
  })

  it(`produces valid Claude JSONL`, () => {
    for (const line of claudeOutput) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it(`starts with system/init`, () => {
    const first = JSON.parse(claudeOutput[0]!) as Record<string, unknown>
    expect(first.type).toBe(`system`)
    expect(first.subtype).toBe(`init`)
    expect(first.sessionId).toBe(`round-trip-002`)
  })

  it(`includes user and assistant entries`, () => {
    const types = claudeOutput.map((line) => {
      const obj = JSON.parse(line) as Record<string, unknown>
      return obj.type
    })
    expect(types).toContain(`user`)
    expect(types).toContain(`assistant`)
  })

  it(`includes tool_use in assistant and tool_result in user`, () => {
    let hasToolUse = false
    let hasToolResult = false

    for (const line of claudeOutput) {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj.type === `assistant`) {
        const msg = obj.message as Record<string, unknown>
        const content = msg.content as Array<Record<string, unknown>>
        if (content?.some((b) => b.type === `tool_use`)) {
          hasToolUse = true
        }
      }
      if (obj.type === `user`) {
        const msg = obj.message as Record<string, unknown>
        const content = msg.content
        if (
          Array.isArray(content) &&
          content.some(
            (b: Record<string, unknown>) => b.type === `tool_result`
          )
        ) {
          hasToolResult = true
        }
      }
    }

    expect(hasToolUse).toBe(true)
    expect(hasToolResult).toBe(true)
  })

  it(`re-normalizes back to equivalent events`, () => {
    const reNormalized = normalize(claudeOutput, `claude`)
    expect(countByType(reNormalized, `session_init`)).toBe(1)
    expect(countByType(reNormalized, `user_message`)).toBeGreaterThanOrEqual(1)
    expect(countByType(reNormalized, `tool_call`)).toBe(
      countByType(normalized, `tool_call`)
    )
  })
})

describe(`round-trip: Codex → normalized → Codex (same agent)`, () => {
  const normalized = normalize(codexLines, `codex`)
  const codexOutput = denormalize(normalized, `codex`, {
    sessionId: `same-agent-001`,
    cwd: `/tmp/same-agent`,
  })
  const reNormalized = normalize(codexOutput, `codex`)

  it(`preserves user message text`, () => {
    const origMsgs = normalized.filter((e) => e.type === `user_message`)
    const roundMsgs = reNormalized.filter((e) => e.type === `user_message`)
    expect(roundMsgs.length).toBe(origMsgs.length)
    for (let i = 0; i < origMsgs.length; i++) {
      if (
        origMsgs[i]!.type === `user_message` &&
        roundMsgs[i]!.type === `user_message`
      ) {
        expect(roundMsgs[i]!.text).toBe(origMsgs[i]!.text)
      }
    }
  })

  it(`preserves tool call count`, () => {
    expect(countByType(reNormalized, `tool_call`)).toBe(
      countByType(normalized, `tool_call`)
    )
  })

  it(`preserves tool result count`, () => {
    expect(countByType(reNormalized, `tool_result`)).toBe(
      countByType(normalized, `tool_result`)
    )
  })
})
