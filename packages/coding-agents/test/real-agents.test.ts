import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { REAL_AGENT_TIMEOUT_MS, scenario } from "./scenario-dsl.js"
import type { ScenarioResult } from "./scenario-dsl.js"

const maybeIt = process.env.CODING_AGENTS_RUN_REAL === `1` ? it : it.skip

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
            .waitForPermissionRequest(`file_change`, REAL_AGENT_TIMEOUT_MS)
            .respondToLatestPermissionRequest(
              { behavior: `allow` },
              {
                matcher: `file_change`,
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
            .expectPermissionRequest(`file_change`, {
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
})
