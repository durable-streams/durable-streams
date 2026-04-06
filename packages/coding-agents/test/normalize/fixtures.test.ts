import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { normalizeClaude } from "../../src/normalize/claude.js"
import { normalizeCodex } from "../../src/normalize/codex.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

async function readFixture(name: string): Promise<Array<object>> {
  const path = join(__dirname, `..`, `fixtures`, name)
  return JSON.parse(await readFile(path, `utf8`)) as Array<object>
}

describe(`protocol fixtures`, () => {
  it(`should normalize the recorded Claude fixture history`, async () => {
    const history = await readFixture(`claude-live-history.json`)
    const normalized = history
      .map((event) => normalizeClaude(event))
      .filter((event) => event !== null)

    expect(normalized).toEqual([
      {
        type: `session_init`,
        sessionId: `claude-session-1`,
        model: `claude-sonnet-4-5-20250514`,
        permissionMode: `plan`,
      },
      {
        type: `stream_delta`,
        delta: { kind: `text`, text: `PO` },
      },
      {
        type: `stream_delta`,
        delta: {
          kind: `thinking`,
          text: `checking whether a tool is needed`,
        },
      },
      {
        type: `assistant_message`,
        content: [
          { type: `text`, text: `PONG` },
          {
            type: `tool_use`,
            id: `toolu_1`,
            name: `Bash`,
            input: { command: `pwd` },
          },
        ],
      },
      {
        type: `permission_request`,
        id: `perm-1`,
        tool: `Bash`,
        input: { command: `pwd` },
      },
      {
        type: `tool_progress`,
        toolUseId: `toolu_1`,
        elapsed: 125,
      },
      {
        type: `turn_complete`,
        success: true,
        cost: {
          inputTokens: 100,
          outputTokens: 25,
          totalCost: 0.02,
        },
      },
      {
        type: `unknown`,
        rawType: `some_future_type`,
        raw: {
          type: `some_future_type`,
          value: 123,
        },
      },
    ])
  })

  it(`should normalize the recorded Codex fixture history`, async () => {
    const history = await readFixture(`codex-live-history.json`)
    const normalized = history
      .map((event) => normalizeCodex(event))
      .filter((event) => event !== null)

    expect(normalized).toEqual([
      {
        type: `session_init`,
        sessionId: `thread-1`,
      },
      {
        type: `status_change`,
        status: `active`,
      },
      {
        type: `stream_delta`,
        delta: { kind: `text`, text: `PO` },
      },
      {
        type: `stream_delta`,
        delta: { kind: `thinking`, text: `checking command safety` },
      },
      {
        type: `assistant_message`,
        content: [{ type: `text`, text: `PONG` }],
      },
      {
        type: `assistant_message`,
        content: [{ type: `thinking`, text: `Need to check one extra file.` }],
      },
      {
        type: `tool_call`,
        id: `cmd-1`,
        tool: `terminal`,
        input: { command: `pwd` },
      },
      {
        type: `tool_call`,
        id: `file-1`,
        tool: `file_edit`,
        input: {
          changes: [{ path: `src/index.ts`, diff: `+const x = 1` }],
        },
      },
      {
        type: `permission_request`,
        id: `approval-1`,
        tool: `terminal`,
        input: { command: `pwd`, cwd: `/repo` },
      },
      {
        type: `permission_request`,
        id: `approval-2`,
        tool: `file_change`,
        input: { reason: `Need to write a file`, grantRoot: `/repo` },
      },
      {
        type: `permission_request`,
        id: `approval-3`,
        tool: `permissions`,
        input: {
          fileSystem: {
            mode: `read-only`,
            roots: [`/tmp/extra`],
          },
        },
      },
      {
        type: `permission_request`,
        id: `approval-4`,
        tool: `request_user_input`,
        input: {
          questions: [
            {
              id: `choice`,
              header: `Pick one`,
              question: `Choose a mode`,
              isOther: false,
              isSecret: false,
              options: [
                { label: `A`, value: `A` },
                { label: `B`, value: `B` },
              ],
            },
          ],
          question: `Choose a mode`,
        },
      },
      {
        type: `turn_complete`,
        success: true,
      },
      {
        type: `unknown`,
        rawType: `future/protocol/change`,
        raw: {
          method: `future/protocol/change`,
          params: { value: 123 },
        },
      },
    ])
  })
})
