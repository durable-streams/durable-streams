import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { REAL_AGENT_TIMEOUT_MS, scenario } from "./scenario-dsl.js"
import type { ScenarioResult } from "./scenario-dsl.js"
import type { PermissionRequestEvent } from "../src/normalize/types.js"

const maybeIt = process.env.CODING_AGENTS_RUN_REAL === `1` ? it : it.skip
const codexApprovalMatcher = (event: PermissionRequestEvent): boolean =>
  event.tool === `terminal` || event.tool === `file_change`

async function withWorkspaceTempCwd<T>(
  prefix: string,
  run: (cwd: string) => Promise<T>
): Promise<T> {
  const parent = join(process.cwd(), `.tmp`)
  await mkdir(parent, { recursive: true })

  const cwd = await mkdtemp(join(parent, prefix))
  try {
    return await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function assistantTexts(result: ScenarioResult): Array<string> {
  return result.normalizedEvents.flatMap((event) => {
    if (
      event.direction !== `agent` ||
      event.event.type !== `assistant_message`
    ) {
      return []
    }

    return [
      event.event.content
        .map((part) => {
          switch (part.type) {
            case `text`:
            case `thinking`:
              return part.text
            case `tool_result`:
              return part.output
            case `tool_use`:
              return JSON.stringify(part.input)
          }
        })
        .join(` `)
        .trim(),
    ]
  })
}

describe(`real agent smoke scenarios`, () => {
  maybeIt(
    `Claude can complete a simple prompt round trip`,
    async () => {
      await scenario(`real claude smoke`)
        .agent(`claude`, {
          permissionMode: `plan`,
        })
        .client(`kyle`)
        .prompt(`Reply with exactly the word PONG and nothing else.`)
        .waitForAssistantMessage(/\bPONG\b/i, REAL_AGENT_TIMEOUT_MS)
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .expectAssistantMessage(/\bPONG\b/i, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_started`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_ended`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectInvariant(`bridge_lifecycle_well_formed`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .run()
    },
    180_000
  )

  maybeIt(
    `Codex can complete a simple prompt round trip`,
    async () => {
      await scenario(`real codex smoke`)
        .agent(`codex`, {
          permissionMode: `plan`,
        })
        .client(`kyle`)
        .prompt(`Reply with exactly the word PONG and nothing else.`)
        .waitForAssistantMessage(/\bPONG\b/i, REAL_AGENT_TIMEOUT_MS)
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .expectAssistantMessage(/\bPONG\b/i, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_started`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_ended`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectInvariant(`bridge_lifecycle_well_formed`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .run()
    },
    180_000
  )

  maybeIt(
    `Claude can complete an approval round trip`,
    async () => {
      const cwd = process.cwd()
      const commandTarget = `/Users/kylemathews/programs/durable-streams`

      const result = await scenario(`real claude approval`)
        .agent(`claude`, {
          cwd,
          permissionMode: `default`,
        })
        .client(`kyle`)
        .prompt(`Run ${commandTarget} using Bash and then tell me the output.`)
        .waitForPermissionRequest(`Bash`, REAL_AGENT_TIMEOUT_MS)
        .respondToLatestPermissionRequest(
          { behavior: `allow` },
          {
            matcher: `Bash`,
            timeoutMs: REAL_AGENT_TIMEOUT_MS,
          }
        )
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .expectPermissionRequest(`Bash`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectForwardedCount(
          (event) => event.source === `client_response`,
          1,
          {
            timeoutMs: REAL_AGENT_TIMEOUT_MS,
          }
        )
        .run()

      expect(
        assistantTexts(result).some(
          (text) =>
            text.includes(commandTarget) ||
            text.toLowerCase().includes(`permission denied`)
        )
      ).toBe(true)
      expect(result.forwardedMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: `client_response`,
          }),
        ])
      )
    },
    180_000
  )

  maybeIt(
    `Codex can complete an approval round trip`,
    async () => {
      await withWorkspaceTempCwd(
        `coding-agents-codex-approval-`,
        async (cwd) => {
          const fileName = `approval-codex.txt`

          const result = await scenario(`real codex approval`)
            .agent(`codex`, {
              cwd,
              permissionMode: `untrusted`,
            })
            .client(`kyle`)
            .prompt(
              `Create a file named ${fileName} in the current directory containing hello, then tell me you did it.`
            )
            .waitForPermissionRequest(
              codexApprovalMatcher,
              REAL_AGENT_TIMEOUT_MS
            )
            .respondToLatestPermissionRequest(
              { behavior: `allow` },
              {
                matcher: codexApprovalMatcher,
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
            .expectPermissionRequest(codexApprovalMatcher, {
              timeoutMs: REAL_AGENT_TIMEOUT_MS,
            })
            .expectForwardedCount(
              (event) => event.source === `client_response`,
              1,
              {
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .run()

          expect(
            assistantTexts(result).some((text) => text.includes(fileName))
          ).toBe(true)
          expect(result.forwardedMessages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                source: `client_response`,
              }),
            ])
          )
        }
      )
    },
    180_000
  )

  maybeIt(
    `Claude interrupt cancels pending approval and allows queued prompt to continue`,
    async () => {
      const commandTarget = `/Users/kylemathews/programs/durable-streams`
      const followupToken = `CLAUDE_INTERRUPT_RECOVERED`

      const result = await scenario(`real claude interrupt with queued prompt`)
        .agent(`claude`, {
          cwd: process.cwd(),
          permissionMode: `default`,
        })
        .client(`kyle`)
        .prompt(`Run ${commandTarget} using Bash and then tell me the output.`)
        .waitForPermissionRequest(`Bash`, REAL_AGENT_TIMEOUT_MS)
        .prompt(`Reply with exactly ${followupToken} and nothing else.`)
        .cancel()
        .waitForForwardedCount(
          (event) => event.source === `interrupt_synthesized_response`,
          1,
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForForwardedCount(
          (event) => event.source === `interrupt`,
          1,
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForForwardedCount(
          (event) => event.source === `queued_prompt`,
          2,
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForAssistantMessage(
          new RegExp(`\\b${followupToken}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .expectInvariant(`single_in_flight_prompt`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectInvariant(`bridge_lifecycle_well_formed`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .run()

      const synthesizedIndex = result.forwardedMessages.findIndex(
        (event) => event.source === `interrupt_synthesized_response`
      )
      const interruptIndex = result.forwardedMessages.findIndex(
        (event) => event.source === `interrupt`
      )

      expect(synthesizedIndex).toBeGreaterThanOrEqual(0)
      expect(interruptIndex).toBeGreaterThan(synthesizedIndex)
      expect(
        assistantTexts(result).some((text) => text.includes(followupToken))
      ).toBe(true)
    },
    240_000
  )

  maybeIt(
    `Codex interrupt cancels pending approval and allows queued prompt to continue`,
    async () => {
      const followupToken = `CODEX_INTERRUPT_RECOVERED`

      await withWorkspaceTempCwd(
        `coding-agents-codex-interrupt-`,
        async (cwd) => {
          const fileName = `interrupt-codex.txt`

          const result = await scenario(
            `real codex interrupt with queued prompt`
          )
            .agent(`codex`, {
              cwd,
              permissionMode: `untrusted`,
            })
            .client(`kyle`)
            .prompt(
              `Create a file named ${fileName} in the current directory containing hello, then tell me you did it.`
            )
            .waitForPermissionRequest(
              codexApprovalMatcher,
              REAL_AGENT_TIMEOUT_MS
            )
            .prompt(`Reply with exactly ${followupToken} and nothing else.`)
            .cancel()
            .waitForForwardedCount(
              (event) => event.source === `interrupt_synthesized_response`,
              1,
              REAL_AGENT_TIMEOUT_MS
            )
            .waitForForwardedCount(
              (event) => event.source === `interrupt`,
              1,
              REAL_AGENT_TIMEOUT_MS
            )
            .waitForForwardedCount(
              (event) => event.source === `queued_prompt`,
              2,
              REAL_AGENT_TIMEOUT_MS
            )
            .waitForAssistantMessage(
              new RegExp(`\\b${followupToken}\\b`),
              REAL_AGENT_TIMEOUT_MS
            )
            .expectInvariant(`single_in_flight_prompt`, {
              timeoutMs: REAL_AGENT_TIMEOUT_MS,
            })
            .expectInvariant(`bridge_lifecycle_well_formed`, {
              timeoutMs: REAL_AGENT_TIMEOUT_MS,
            })
            .run()

          const synthesizedIndex = result.forwardedMessages.findIndex(
            (event) => event.source === `interrupt_synthesized_response`
          )
          const interruptIndex = result.forwardedMessages.findIndex(
            (event) => event.source === `interrupt`
          )

          expect(synthesizedIndex).toBeGreaterThanOrEqual(0)
          expect(interruptIndex).toBeGreaterThan(synthesizedIndex)
          expect(
            assistantTexts(result).some((text) => text.includes(followupToken))
          ).toBe(true)
        }
      )
    },
    240_000
  )
})
