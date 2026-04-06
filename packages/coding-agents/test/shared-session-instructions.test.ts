import { describe, expect, it } from "vitest"
import {
  SHARED_SESSION_INSTRUCTIONS,
  getSharedSessionInstructions,
} from "../src/shared-session-instructions.js"

describe(`shared session instructions`, () => {
  it(`returns the default shared-session framing when no developer instructions are provided`, () => {
    expect(getSharedSessionInstructions()).toBe(SHARED_SESSION_INSTRUCTIONS)
    expect(getSharedSessionInstructions()).toContain(
      `This is a shared multi-user coding session.`
    )
    expect(getSharedSessionInstructions()).toContain(
      `Forwarded user prompts include an explicit current-speaker block with that person's name and email.`
    )
  })

  it(`prepends the shared-session framing ahead of custom developer instructions`, () => {
    expect(getSharedSessionInstructions(`Be concise.`)).toBe(
      `${SHARED_SESSION_INSTRUCTIONS}\n\nBe concise.`
    )
  })
})
