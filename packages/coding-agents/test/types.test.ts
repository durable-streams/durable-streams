import { describe, expect, it } from "vitest"
import type {
  AgentEnvelope,
  BridgeEnvelope,
  StreamEnvelope,
  UserEnvelope,
} from "../src/types.js"

describe(`StreamEnvelope`, () => {
  const expectAgentEnvelope = (envelope: StreamEnvelope) => {
    if (envelope.direction === `agent`) {
      expect(envelope.raw).toBeDefined()
    }
  }

  it(`should accept a valid agent envelope`, () => {
    const envelope: AgentEnvelope = {
      agent: `claude`,
      direction: `agent`,
      timestamp: Date.now(),
      raw: { type: `assistant`, message: { content: [] } },
    }

    expect(envelope.direction).toBe(`agent`)
    expect(envelope.agent).toBe(`claude`)
  })

  it(`should accept a valid user envelope`, () => {
    const envelope: UserEnvelope = {
      agent: `claude`,
      direction: `user`,
      timestamp: Date.now(),
      user: { name: `Kyle`, email: `kyle@example.com` },
      raw: { type: `user_message`, text: `hello` },
    }

    expect(envelope.direction).toBe(`user`)
    expect(envelope.user.name).toBe(`Kyle`)
  })

  it(`should accept a valid bridge envelope`, () => {
    const envelope: BridgeEnvelope = {
      agent: `claude`,
      direction: `bridge`,
      timestamp: Date.now(),
      type: `session_started`,
    }

    expect(envelope.direction).toBe(`bridge`)
    expect(envelope.type).toBe(`session_started`)
  })

  it(`should discriminate envelope types via direction field`, () => {
    const envelope: StreamEnvelope = {
      agent: `codex`,
      direction: `agent`,
      timestamp: Date.now(),
      raw: { jsonrpc: `2.0`, method: `test` },
    }

    expectAgentEnvelope(envelope)
  })
})
