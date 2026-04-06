import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { describe, expect, it } from "vitest"
import { createClient } from "../src/client.js"
import { createSession } from "../src/index.js"
import { REAL_AGENT_TIMEOUT_MS, scenario } from "./scenario-dsl.js"
import type { StreamEnvelope } from "../src/types.js"
import type { ScenarioResult } from "./scenario-dsl.js"
import type { PermissionRequestEvent } from "../src/normalize/types.js"

const maybeIt = process.env.CODING_AGENTS_RUN_REAL === `1` ? it : it.skip
const codexApprovalMatcher = (event: PermissionRequestEvent): boolean =>
  event.tool === `terminal` || event.tool === `file_change`

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

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

async function withWorkspaceAndOutsideTempDirs<T>(
  prefix: string,
  run: (paths: { cwd: string; outside: string }) => Promise<T>
): Promise<T> {
  const parent = join(process.cwd(), `.tmp`)
  await mkdir(parent, { recursive: true })

  const cwd = await mkdtemp(join(parent, `${prefix}workspace-`))
  const outside = await mkdtemp(join(parent, `${prefix}outside-`))
  try {
    return await run({ cwd, outside })
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}

async function withTwoWorkspaceTempDirs<T>(
  prefix: string,
  run: (paths: { initialCwd: string; resumedCwd: string }) => Promise<T>
): Promise<T> {
  const initialCwd = await mkdtemp(join(tmpdir(), `${prefix}initial-`))
  const resumedCwd = await mkdtemp(join(tmpdir(), `${prefix}resumed-`))
  try {
    return await run({ initialCwd, resumedCwd })
  } finally {
    await rm(initialCwd, { recursive: true, force: true })
    await rm(resumedCwd, { recursive: true, force: true })
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

function turnCompleteSequences(result: ScenarioResult): Array<number> {
  return result.agentMessages.flatMap((event) => {
    const message = event.raw as Record<string, unknown>
    const isTurnComplete =
      result.agent === `claude`
        ? message.type === `result`
        : message.method === `turn/completed`

    return isTurnComplete ? [event.sequence] : []
  })
}

function normalizedAgentEventCounts(
  result: ScenarioResult
): Map<string, number> {
  const counts = new Map<string, number>()

  for (const event of result.normalizedEvents) {
    if (event.direction !== `agent`) {
      continue
    }

    counts.set(event.event.type, (counts.get(event.event.type) ?? 0) + 1)
  }

  return counts
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
    `Claude normalization stays stable on a live prompt history`,
    async () => {
      const result = await scenario(`real claude normalization`)
        .agent(`claude`, {
          permissionMode: `plan`,
        })
        .client(`kyle`)
        .prompt(
          `Reply with exactly the word NORMALIZE_CLAUDE and nothing else.`
        )
        .waitForAssistantMessage(/\bNORMALIZE_CLAUDE\b/i, REAL_AGENT_TIMEOUT_MS)
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .run()

      const counts = normalizedAgentEventCounts(result)

      expect(counts.get(`assistant_message`)).toBeGreaterThanOrEqual(1)
      expect(counts.get(`turn_complete`)).toBe(1)
      expect(counts.get(`session_init`)).toBeGreaterThanOrEqual(1)
      expect(counts.get(`unknown`) ?? 0).toBe(0)
    },
    180_000
  )

  maybeIt(
    `Codex normalization stays stable on a live prompt history`,
    async () => {
      const result = await scenario(`real codex normalization`)
        .agent(`codex`, {
          permissionMode: `plan`,
        })
        .client(`kyle`)
        .prompt(`Reply with exactly the word NORMALIZE_CODEX and nothing else.`)
        .waitForAssistantMessage(/\bNORMALIZE_CODEX\b/i, REAL_AGENT_TIMEOUT_MS)
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .run()

      const counts = normalizedAgentEventCounts(result)

      expect(counts.get(`assistant_message`)).toBeGreaterThanOrEqual(1)
      expect(counts.get(`stream_delta`)).toBeGreaterThanOrEqual(1)
      expect(counts.get(`turn_complete`)).toBe(1)
      expect(counts.get(`session_init`)).toBe(1)
      expect(counts.get(`unknown`) ?? 0).toBe(0)
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
    `Codex can complete a file-change approval round trip`,
    async () => {
      await withWorkspaceTempCwd(
        `coding-agents-codex-file-change-`,
        async (cwd) => {
          const fileName = `approval-codex-file-change.txt`
          const filePath = join(cwd, fileName)

          const result = await scenario(`real codex file-change approval`)
            .agent(`codex`, {
              cwd,
              permissionMode: `untrusted`,
            })
            .client(`kyle`)
            .prompt(
              `Create a file named ${fileName} in the current directory containing hello. Do not use shell commands or terminal commands. Edit the file directly, then tell me you did it.`
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

          expect(await readFile(filePath, `utf8`)).toBe(`hello\n`)
          expect(
            assistantTexts(result).some((text) => text.includes(fileName))
          ).toBe(true)
        }
      )
    },
    180_000
  )

  maybeIt(
    `Codex can complete a permissions approval round trip`,
    async () => {
      await withWorkspaceAndOutsideTempDirs(
        `coding-agents-codex-permissions-`,
        async ({ cwd, outside }) => {
          const filePath = join(outside, `permission-target.txt`)
          await writeFile(filePath, `PERMISSION_TOKEN\n`)

          const result = await scenario(`real codex permissions approval`)
            .agent(`codex`, {
              cwd,
              sandboxMode: `workspace-write`,
              approvalPolicy: {
                granular: {
                  sandbox_approval: true,
                  rules: true,
                  skill_approval: false,
                  request_permissions: true,
                  mcp_elicitations: false,
                },
              },
              experimentalFeatures: {
                request_permissions_tool: true,
              },
            })
            .client(`kyle`)
            .prompt(
              `Before reading the file at ${filePath}, use the request_permissions tool to request read access for exactly that file. After permission is granted, read the file and reply with exactly its contents and nothing else.`
            )
            .waitForPermissionRequest(`permissions`, REAL_AGENT_TIMEOUT_MS)
            .respondToLatestPermissionRequest(
              {
                permissions: {
                  fileSystem: {
                    read: [filePath],
                  },
                },
                scope: `turn`,
              },
              {
                matcher: `permissions`,
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
            .expectPermissionRequest(`permissions`, {
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
            assistantTexts(result).some((text) =>
              text.includes(`PERMISSION_TOKEN`)
            )
          ).toBe(true)
        }
      )
    },
    180_000
  )

  maybeIt(
    `Codex can complete a request-user-input round trip`,
    async () => {
      await withWorkspaceTempCwd(
        `coding-agents-codex-request-user-input-`,
        async (cwd) => {
          const result = await scenario(`real codex request-user-input`)
            .agent(`codex`, {
              cwd,
              permissionMode: `plan`,
              experimentalFeatures: {
                default_mode_request_user_input: true,
              },
            })
            .client(`kyle`)
            .prompt(
              `Before you answer, use the request_user_input tool to ask me whether I prefer option Alpha or option Beta. Do not choose for me and do not answer until I respond. After I answer, reply with exactly CHOSEN:<option>.`
            )
            .waitForPermissionRequest(
              `request_user_input`,
              REAL_AGENT_TIMEOUT_MS
            )
            .respondToLatestPermissionRequest(
              {
                answers: {
                  option_choice: {
                    answers: [`Alpha`],
                  },
                },
              },
              {
                matcher: `request_user_input`,
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
            .expectPermissionRequest(`request_user_input`, {
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
            assistantTexts(result).some((text) => text.includes(`CHOSEN:Alpha`))
          ).toBe(true)
        }
      )
    },
    180_000
  )

  maybeIt(
    `Claude deny approval blocks side effects`,
    async () => {
      await withWorkspaceTempCwd(`coding-agents-claude-deny-`, async (cwd) => {
        const fileName = `approval-claude-deny.txt`
        const filePath = join(cwd, fileName)

        await scenario(`real claude approval deny`)
          .agent(`claude`, {
            cwd,
            permissionMode: `default`,
          })
          .client(`kyle`)
          .prompt(
            `Use Bash to run: printf 'hello\\n' > ${fileName}. Then tell me what happened.`
          )
          .waitForPermissionRequest(`Bash`, REAL_AGENT_TIMEOUT_MS)
          .respondToLatestPermissionRequest(
            { behavior: `deny` },
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

        expect(await pathExists(filePath)).toBe(false)
      })
    },
    180_000
  )

  maybeIt(
    `Claude cancel approval blocks side effects`,
    async () => {
      await withWorkspaceTempCwd(
        `coding-agents-claude-cancel-`,
        async (cwd) => {
          const fileName = `approval-claude-cancel.txt`
          const filePath = join(cwd, fileName)

          await scenario(`real claude approval cancel`)
            .agent(`claude`, {
              cwd,
              permissionMode: `default`,
            })
            .client(`kyle`)
            .prompt(
              `Use Bash to run: printf 'hello\\n' > ${fileName}. Then tell me what happened.`
            )
            .waitForPermissionRequest(`Bash`, REAL_AGENT_TIMEOUT_MS)
            .cancelLatestPermissionRequest({
              matcher: `Bash`,
              timeoutMs: REAL_AGENT_TIMEOUT_MS,
            })
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

          expect(await pathExists(filePath)).toBe(false)
        }
      )
    },
    180_000
  )

  maybeIt(
    `Codex deny approval blocks side effects`,
    async () => {
      await withWorkspaceTempCwd(`coding-agents-codex-deny-`, async (cwd) => {
        const fileName = `approval-codex-deny.txt`
        const filePath = join(cwd, fileName)

        await scenario(`real codex approval deny`)
          .agent(`codex`, {
            cwd,
            permissionMode: `untrusted`,
          })
          .client(`kyle`)
          .prompt(
            `Create a file named ${fileName} in the current directory containing hello. Do not use shell commands or terminal commands. Edit the file directly, and if that edit is denied, do not try any fallback tool or alternative method; just explain that you were blocked.`
          )
          .waitForPermissionRequest(`file_change`, REAL_AGENT_TIMEOUT_MS)
          .respondToLatestPermissionRequest(
            { behavior: `deny` },
            {
              matcher: `file_change`,
              timeoutMs: REAL_AGENT_TIMEOUT_MS,
            }
          )
          .sleep(2_000)
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

        expect(await pathExists(filePath)).toBe(false)
      })
    },
    180_000
  )

  maybeIt(
    `Codex cancel approval blocks side effects`,
    async () => {
      await withWorkspaceTempCwd(`coding-agents-codex-cancel-`, async (cwd) => {
        const fileName = `approval-codex-cancel.txt`
        const filePath = join(cwd, fileName)

        await scenario(`real codex approval cancel`)
          .agent(`codex`, {
            cwd,
            permissionMode: `untrusted`,
          })
          .client(`kyle`)
          .prompt(
            `Create a file named ${fileName} in the current directory containing hello, then tell me you did it.`
          )
          .waitForPermissionRequest(codexApprovalMatcher, REAL_AGENT_TIMEOUT_MS)
          .cancelLatestPermissionRequest({
            matcher: codexApprovalMatcher,
            timeoutMs: REAL_AGENT_TIMEOUT_MS,
          })
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

        expect(await pathExists(filePath)).toBe(false)
      })
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

  maybeIt(
    `Claude can resume after bridge restart`,
    async () => {
      const beforeToken = `CLAUDE_BEFORE_RESTART_OK`
      const afterToken = `CLAUDE_AFTER_RESTART_OK`

      const result = await scenario(`real claude restart and resume`)
        .agent(`claude`, {
          permissionMode: `plan`,
        })
        .client(`kyle`)
        .prompt(`Reply with exactly ${beforeToken} and nothing else.`)
        .waitForAssistantMessage(
          new RegExp(`\\b${beforeToken}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .restart()
        .prompt(`Reply with exactly ${afterToken} and nothing else.`)
        .waitForAssistantMessage(
          new RegExp(`\\b${afterToken}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .expectBridgeEvent(`session_started`, {
          count: 1,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_resumed`, {
          count: 1,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_ended`, {
          count: 2,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectInvariant(`bridge_lifecycle_well_formed`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .run()

      const text = assistantTexts(result).join(` `)
      expect(text).toContain(beforeToken)
      expect(text).toContain(afterToken)
    },
    240_000
  )

  maybeIt(
    `Codex can resume after bridge restart`,
    async () => {
      const beforeToken = `CODEX_BEFORE_RESTART_OK`
      const afterToken = `CODEX_AFTER_RESTART_OK`

      const result = await scenario(`real codex restart and resume`)
        .agent(`codex`, {
          permissionMode: `plan`,
        })
        .client(`kyle`)
        .prompt(`Reply with exactly ${beforeToken} and nothing else.`)
        .waitForAssistantMessage(
          new RegExp(`\\b${beforeToken}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .restart()
        .prompt(`Reply with exactly ${afterToken} and nothing else.`)
        .waitForAssistantMessage(
          new RegExp(`\\b${afterToken}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .expectBridgeEvent(`session_started`, {
          count: 1,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_resumed`, {
          count: 1,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_ended`, {
          count: 2,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectInvariant(`bridge_lifecycle_well_formed`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .run()

      const text = assistantTexts(result).join(` `)
      expect(text).toContain(beforeToken)
      expect(text).toContain(afterToken)
    },
    240_000
  )

  maybeIt(
    `Claude can resume after restart before turn completion`,
    async () => {
      const token = `CLAUDE_REPLAY_AFTER_RESTART`

      const result = await scenario(`real claude replay after restart`)
        .agent(`claude`, {
          permissionMode: `plan`,
        })
        .client(`kyle`)
        .prompt(`Reply with exactly ${token} and nothing else.`)
        .restart()
        .waitForAssistantMessage(
          new RegExp(`\\b${token}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .expectBridgeEvent(`session_started`, {
          count: 1,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_resumed`, {
          count: 1,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_ended`, {
          count: 2,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .run()

      expect(assistantTexts(result).some((text) => text.includes(token))).toBe(
        true
      )
    },
    240_000
  )

  maybeIt(
    `Codex can resume after restart before turn completion`,
    async () => {
      const token = `CODEX_REPLAY_AFTER_RESTART`

      const result = await scenario(`real codex replay after restart`)
        .agent(`codex`, {
          permissionMode: `plan`,
        })
        .client(`kyle`)
        .prompt(`Reply with exactly ${token} and nothing else.`)
        .restart()
        .waitForAssistantMessage(
          new RegExp(`\\b${token}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForTurnComplete(REAL_AGENT_TIMEOUT_MS)
        .expectBridgeEvent(`session_started`, {
          count: 1,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_resumed`, {
          count: 1,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .expectBridgeEvent(`session_ended`, {
          count: 2,
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .run()

      expect(assistantTexts(result).some((text) => text.includes(token))).toBe(
        true
      )
    },
    240_000
  )

  maybeIt(
    `Claude can resume reconstructed history across cwd changes by seeding the new workspace`,
    async () => {
      await withTwoWorkspaceTempDirs(
        `coding-agents-claude-rewrite-`,
        async ({ initialCwd, resumedCwd }) => {
          const originalPath = join(initialCwd, `important-token.txt`)
          const rewrittenPath = join(resumedCwd, `important-token.txt`)
          const server = new DurableStreamTestServer({ port: 0 })
          await server.start()

          const streamUrl = `${server.url}/v1/stream/claude-cross-cwd-${randomUUID()}`
          const stream = new DurableStream({
            url: streamUrl,
            contentType: `application/json`,
          })
          const client = createClient({
            agent: `claude`,
            streamUrl,
            user: { name: `Kyle`, email: `kyle@example.com` },
          })

          const readHistory = async (): Promise<Array<StreamEnvelope>> => {
            const response = await stream.stream<StreamEnvelope>({
              live: false,
              json: true,
            })
            return await response.json()
          }

          const waitForHistory = async (
            predicate: (history: Array<StreamEnvelope>) => boolean,
            timeoutMs: number
          ): Promise<Array<StreamEnvelope>> => {
            const started = Date.now()
            while (Date.now() - started < timeoutMs) {
              const history = await readHistory()
              if (predicate(history)) {
                return history
              }
              await new Promise((resolve) => setTimeout(resolve, 1000))
            }

            throw new Error(`Timed out waiting for cross-cwd Claude resume`)
          }

          const assistantMessages = (
            history: Array<StreamEnvelope>
          ): Array<string> =>
            history.flatMap((event) => {
              if (event.direction !== `agent`) {
                return []
              }

              const raw = event.raw as Record<string, unknown>
              if (raw.type !== `assistant`) {
                return []
              }

              const message = raw.message as Record<string, unknown> | undefined
              const content = message?.content
              if (!Array.isArray(content)) {
                return []
              }

              return [
                content
                  .flatMap((item) => {
                    const part = item as Record<string, unknown>
                    return part.type === `text` && typeof part.text === `string`
                      ? [part.text]
                      : []
                  })
                  .join(` `)
                  .trim(),
              ]
            })

          let firstSession:
            | Awaited<ReturnType<typeof createSession>>
            | undefined
          let resumedSession:
            | Awaited<ReturnType<typeof createSession>>
            | undefined

          try {
            firstSession = await createSession({
              agent: `claude`,
              streamUrl,
              cwd: initialCwd,
              permissionMode: `plan`,
            })

            client.prompt(
              `Remember this exact absolute path for later: ${originalPath}. Reply with exactly OK and nothing else.`
            )

            await waitForHistory(
              (history) =>
                assistantMessages(history).some((text) =>
                  text.includes(`OK`)
                ) &&
                history.some(
                  (event) =>
                    event.direction === `agent` &&
                    (event.raw as Record<string, unknown>).type === `result`
                ),
              REAL_AGENT_TIMEOUT_MS
            )

            await firstSession.close()

            resumedSession = await createSession({
              agent: `claude`,
              streamUrl,
              cwd: resumedCwd,
              permissionMode: `plan`,
              resume: true,
              rewritePaths: {
                [initialCwd]: resumedCwd,
              },
            })
            await waitForHistory(
              (history) =>
                history.some(
                  (event) =>
                    event.direction === `bridge` &&
                    event.type === `session_resumed`
                ),
              REAL_AGENT_TIMEOUT_MS
            )

            client.prompt(
              `What exact absolute path did I ask you to remember earlier? Reply with only the path.`
            )

            const finalHistory = await waitForHistory(
              (history) =>
                assistantMessages(history).some((text) =>
                  text.includes(rewrittenPath)
                ) &&
                history.filter(
                  (event) =>
                    event.direction === `bridge` &&
                    event.type === `session_resumed`
                ).length >= 1,
              REAL_AGENT_TIMEOUT_MS
            )

            expect(
              assistantMessages(finalHistory).some((text) =>
                text.includes(rewrittenPath)
              )
            ).toBe(true)
          } finally {
            await resumedSession?.close().catch(() => undefined)
            await firstSession?.close().catch(() => undefined)
            await client.close().catch(() => undefined)
            await server.stop().catch(() => undefined)
          }
        }
      )
    },
    240_000
  )

  maybeIt(
    `Claude serializes multiple queued live prompts`,
    async () => {
      const firstToken = `CLAUDE_QUEUE_FIRST`
      const secondToken = `CLAUDE_QUEUE_SECOND`

      const result = await scenario(`real claude queued prompts`)
        .agent(`claude`, {
          permissionMode: `plan`,
        })
        .client(`kyle`)
        .prompt(`Reply with exactly ${firstToken} and nothing else.`)
        .prompt(`Reply with exactly ${secondToken} and nothing else.`)
        .waitForForwardedCount(
          (event) => event.source === `queued_prompt`,
          1,
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForAssistantMessage(
          new RegExp(`\\b${firstToken}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForTurnCompleteCount(1, REAL_AGENT_TIMEOUT_MS)
        .waitForForwardedCount(
          (event) => event.source === `queued_prompt`,
          2,
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForAssistantMessage(
          new RegExp(`\\b${secondToken}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForTurnCompleteCount(2, REAL_AGENT_TIMEOUT_MS)
        .expectInvariant(`single_in_flight_prompt`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .run()

      const queuedPromptSequences = result.forwardedMessages
        .filter((event) => event.source === `queued_prompt`)
        .map((event) => ({
          sequence: event.sequence,
          text: JSON.stringify(event.raw),
        }))
      const completedTurns = turnCompleteSequences(result)
      const text = assistantTexts(result).join(` `)

      expect(queuedPromptSequences).toHaveLength(2)
      expect(completedTurns.length).toBeGreaterThanOrEqual(2)
      expect(queuedPromptSequences[0]?.text).toContain(firstToken)
      expect(queuedPromptSequences[1]?.text).toContain(secondToken)
      expect(queuedPromptSequences[1]!.sequence).toBeGreaterThan(
        completedTurns[0]!
      )
      expect(text).toContain(firstToken)
      expect(text).toContain(secondToken)
    },
    240_000
  )

  maybeIt(
    `Codex serializes multiple queued live prompts`,
    async () => {
      const firstToken = `CODEX_QUEUE_FIRST`
      const secondToken = `CODEX_QUEUE_SECOND`

      const result = await scenario(`real codex queued prompts`)
        .agent(`codex`, {
          permissionMode: `plan`,
        })
        .client(`kyle`)
        .prompt(`Reply with exactly ${firstToken} and nothing else.`)
        .prompt(`Reply with exactly ${secondToken} and nothing else.`)
        .waitForForwardedCount(
          (event) => event.source === `queued_prompt`,
          1,
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForAssistantMessage(
          new RegExp(`\\b${firstToken}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForTurnCompleteCount(1, REAL_AGENT_TIMEOUT_MS)
        .waitForForwardedCount(
          (event) => event.source === `queued_prompt`,
          2,
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForAssistantMessage(
          new RegExp(`\\b${secondToken}\\b`),
          REAL_AGENT_TIMEOUT_MS
        )
        .waitForTurnCompleteCount(2, REAL_AGENT_TIMEOUT_MS)
        .expectInvariant(`single_in_flight_prompt`, {
          timeoutMs: REAL_AGENT_TIMEOUT_MS,
        })
        .run()

      const queuedPromptSequences = result.forwardedMessages
        .filter((event) => event.source === `queued_prompt`)
        .map((event) => ({
          sequence: event.sequence,
          text: JSON.stringify(event.raw),
        }))
      const completedTurns = turnCompleteSequences(result)
      const text = assistantTexts(result).join(` `)

      expect(queuedPromptSequences).toHaveLength(2)
      expect(completedTurns.length).toBeGreaterThanOrEqual(2)
      expect(queuedPromptSequences[0]?.text).toContain(firstToken)
      expect(queuedPromptSequences[1]?.text).toContain(secondToken)
      expect(queuedPromptSequences[1]!.sequence).toBeGreaterThan(
        completedTurns[0]!
      )
      expect(text).toContain(firstToken)
      expect(text).toContain(secondToken)
    },
    240_000
  )

  maybeIt(
    `Claude keeps only the first live approval response across clients`,
    async () => {
      await withWorkspaceTempCwd(
        `coding-agents-claude-response-race-`,
        async (cwd) => {
          const fileName = `claude-race.txt`
          const filePath = join(cwd, fileName)

          const result = await scenario(`real claude duplicate approval race`)
            .agent(`claude`, {
              cwd,
              permissionMode: `default`,
            })
            .client(`alice`)
            .client(`bob`)
            .useClient(`alice`)
            .prompt(
              `Use Bash to run: printf 'hello\\n' > ${fileName}. Then tell me what happened.`
            )
            .waitForPermissionRequest(`Bash`, REAL_AGENT_TIMEOUT_MS)
            .useClient(`alice`)
            .respondToLatestPermissionRequest(
              { behavior: `deny` },
              {
                matcher: `Bash`,
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .useClient(`bob`)
            .respondToLatestPermissionRequest(
              { behavior: `allow` },
              {
                matcher: `Bash`,
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .sleep(2_000)
            .expectForwardedCount(
              (event) => event.source === `client_response`,
              1,
              {
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .expectInvariant(`first_response_wins`, {
              timeoutMs: REAL_AGENT_TIMEOUT_MS,
            })
            .run()

          expect(await pathExists(filePath)).toBe(false)
          expect(result.forwardedMessages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                source: `client_response`,
                raw: expect.objectContaining({
                  response: expect.objectContaining({
                    response: { behavior: `deny` },
                  }),
                }),
              }),
            ])
          )
        }
      )
    },
    240_000
  )

  maybeIt(
    `Codex keeps only the first live approval response across clients`,
    async () => {
      await withWorkspaceTempCwd(
        `coding-agents-codex-response-race-`,
        async (cwd) => {
          const fileName = `codex-race.txt`
          const filePath = join(cwd, fileName)

          const result = await scenario(`real codex duplicate approval race`)
            .agent(`codex`, {
              cwd,
              permissionMode: `untrusted`,
            })
            .client(`alice`)
            .client(`bob`)
            .useClient(`alice`)
            .prompt(
              `Create a file named ${fileName} in the current directory containing hello, then tell me you did it.`
            )
            .waitForPermissionRequest(
              codexApprovalMatcher,
              REAL_AGENT_TIMEOUT_MS
            )
            .useClient(`alice`)
            .respondToLatestPermissionRequest(
              { behavior: `deny` },
              {
                matcher: codexApprovalMatcher,
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .useClient(`bob`)
            .respondToLatestPermissionRequest(
              { behavior: `allow` },
              {
                matcher: codexApprovalMatcher,
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .sleep(2_000)
            .expectForwardedCount(
              (event) => event.source === `client_response`,
              1,
              {
                timeoutMs: REAL_AGENT_TIMEOUT_MS,
              }
            )
            .expectInvariant(`first_response_wins`, {
              timeoutMs: REAL_AGENT_TIMEOUT_MS,
            })
            .run()

          expect(await pathExists(filePath)).toBe(false)
          const forwardedResponses = result.forwardedMessages.filter(
            (event) => event.source === `client_response`
          )
          expect(forwardedResponses).toHaveLength(1)
          expect(forwardedResponses).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                raw: expect.objectContaining({
                  result: expect.objectContaining({
                    decision: `decline`,
                  }),
                }),
              }),
            ])
          )
          expect(forwardedResponses).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                raw: expect.objectContaining({
                  result: expect.objectContaining({
                    decision: `accept`,
                  }),
                }),
              }),
            ])
          )
        }
      )
    },
    240_000
  )
})
