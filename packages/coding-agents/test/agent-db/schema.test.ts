import { describe, expect, it } from "vitest"
import { createAgentDB } from "../../src/agent-db.js"

describe(`createAgentDB`, () => {
  it(`exposes a minimal public scaffold`, () => {
    const db = createAgentDB({
      streamOptions: {
        url: `https://example.com/streams/test`,
      },
    })

    expect(Object.keys(db.collections)).toEqual([
      `sessions`,
      `participants`,
      `messages`,
      `message_parts`,
      `turns`,
      `tool_calls`,
      `permission_requests`,
      `approval_responses`,
      `session_events`,
      `debug_events`,
    ])
    expect(Object.keys(db.actions)).toEqual([
      `prompt`,
      `respond`,
      `cancel`,
      `interrupt`,
    ])
    expect(typeof db.preload).toBe(`function`)
    expect(typeof db.close).toBe(`function`)
    expect(typeof db.utils.awaitTxId).toBe(`function`)
  })

  it(`resolves relative stream urls in browser-like environments`, () => {
    const originalWindow = globalThis.window

    Object.defineProperty(globalThis, `window`, {
      configurable: true,
      value: {
        location: {
          href: `http://localhost:3004/session/ac06a35d`,
        },
      },
    })

    try {
      const db = createAgentDB({
        streamOptions: {
          url: `/api/stream/ac06a35d`,
        },
      })

      expect(db.stream.url).toBe(`http://localhost:3004/api/stream/ac06a35d`)
    } finally {
      Object.defineProperty(globalThis, `window`, {
        configurable: true,
        value: originalWindow,
      })
    }
  })
})
