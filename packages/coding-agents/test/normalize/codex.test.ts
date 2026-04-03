import { describe, expect, it } from "vitest"
import { normalizeCodex } from "../../src/normalize/codex.js"

describe(`normalizeCodex`, () => {
  it(`should normalize an app-server completed agent message`, () => {
    const raw = {
      method: `item/completed`,
      params: {
        threadId: `thread-1`,
        turnId: `turn-1`,
        item: {
          type: `agentMessage`,
          id: `item-1`,
          text: `Here is the fix.`,
        },
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `assistant_message`,
      content: [{ type: `text`, text: `Here is the fix.` }],
    })
  })

  it(`should normalize a legacy agent message`, () => {
    const raw = {
      type: `item`,
      item: {
        type: `agentMessage`,
        content: `Here is the fix.`,
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `assistant_message`,
      content: [{ type: `text`, text: `Here is the fix.` }],
    })
  })

  it(`should normalize an app-server reasoning item`, () => {
    const raw = {
      method: `item/completed`,
      params: {
        threadId: `thread-1`,
        turnId: `turn-1`,
        item: {
          type: `reasoning`,
          id: `reason-1`,
          content: [`Let me think about this...`],
          summary: [],
        },
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `assistant_message`,
      content: [{ type: `thinking`, text: `Let me think about this...` }],
    })
  })

  it(`should normalize a legacy reasoning item`, () => {
    const raw = {
      type: `item`,
      item: {
        type: `reasoning`,
        content: `Let me think about this...`,
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `assistant_message`,
      content: [{ type: `thinking`, text: `Let me think about this...` }],
    })
  })

  it(`should normalize an app-server command execution`, () => {
    const raw = {
      method: `item/completed`,
      params: {
        threadId: `thread-1`,
        turnId: `turn-1`,
        item: {
          type: `commandExecution`,
          command: `npm test`,
          id: `cmd-1`,
        },
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `tool_call`,
      id: `cmd-1`,
      tool: `terminal`,
      input: { command: `npm test` },
    })
  })

  it(`should normalize a file change`, () => {
    const raw = {
      method: `item/completed`,
      params: {
        threadId: `thread-1`,
        turnId: `turn-1`,
        item: {
          type: `fileChange`,
          id: `file-1`,
          changes: [{ path: `src/index.ts`, diff: `+const x = 1` }],
        },
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `tool_call`,
      id: `file-1`,
      tool: `file_edit`,
      input: { changes: [{ path: `src/index.ts`, diff: `+const x = 1` }] },
    })
  })

  it(`should normalize an app-server approval request`, () => {
    const raw = {
      id: `approval-1`,
      method: `item/commandExecution/requestApproval`,
      params: {
        threadId: `thread-1`,
        turnId: `turn-1`,
        itemId: `cmd-1`,
        command: `rm -rf node_modules`,
        cwd: `/repo`,
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `permission_request`,
      id: `approval-1`,
      tool: `terminal`,
      input: { command: `rm -rf node_modules`, cwd: `/repo` },
    })
  })

  it(`should normalize a permissions approval request`, () => {
    const raw = {
      id: `approval-2`,
      method: `item/permissions/requestApproval`,
      params: {
        threadId: `thread-1`,
        turnId: `turn-1`,
        itemId: `perm-1`,
        reason: `Need access to an extra path`,
        permissions: {
          fileSystem: {
            mode: `read-only`,
            roots: [`/tmp/extra`],
          },
        },
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `permission_request`,
      id: `approval-2`,
      tool: `permissions`,
      input: {
        fileSystem: {
          mode: `read-only`,
          roots: [`/tmp/extra`],
        },
      },
    })
  })

  it(`should normalize a request-user-input approval request`, () => {
    const raw = {
      id: `approval-3`,
      method: `item/tool/requestUserInput`,
      params: {
        threadId: `thread-1`,
        turnId: `turn-1`,
        itemId: `input-1`,
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
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `permission_request`,
      id: `approval-3`,
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
    })
  })

  it(`should normalize a turn completed notification`, () => {
    expect(
      normalizeCodex({
        method: `turn/completed`,
        params: {
          threadId: `thread-1`,
          turn: { id: `turn-1`, status: `completed`, items: [], error: null },
        },
      })
    ).toEqual({
      type: `turn_complete`,
      success: true,
    })
  })

  it(`should normalize thread status changes`, () => {
    expect(
      normalizeCodex({
        method: `thread/status/changed`,
        params: {
          threadId: `thread-1`,
          status: { type: `active`, activeFlags: [] },
        },
      })
    ).toEqual({
      type: `status_change`,
      status: `active`,
    })
  })

  it(`should ignore codex transport noise notifications`, () => {
    expect(
      normalizeCodex({
        method: `mcpServer/startupStatus/updated`,
        params: {
          name: `codex_apps`,
          status: `ready`,
          error: null,
        },
      })
    ).toBeNull()

    expect(
      normalizeCodex({
        method: `item/started`,
        params: {
          item: { type: `agentMessage`, id: `item-1`, text: `` },
        },
      })
    ).toBeNull()
  })

  it(`should normalize a legacy command execution`, () => {
    const raw = {
      type: `item`,
      item: {
        type: `commandExecution`,
        command: `npm test`,
        output: `All tests passed`,
        exitCode: 0,
        id: `cmd-1`,
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `tool_call`,
      id: `cmd-1`,
      tool: `terminal`,
      input: { command: `npm test` },
    })
  })

  it(`should normalize a legacy file change`, () => {
    const raw = {
      type: `item`,
      item: {
        type: `fileChange`,
        path: `src/index.ts`,
        diff: `+const x = 1`,
        id: `file-1`,
      },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `tool_call`,
      id: `file-1`,
      tool: `file_edit`,
      input: { path: `src/index.ts`, diff: `+const x = 1` },
    })
  })

  it(`should normalize a legacy approval request`, () => {
    const raw = {
      type: `approval_request`,
      id: `approval-1`,
      tool_name: `Bash`,
      tool_input: { command: `rm -rf node_modules` },
    }

    expect(normalizeCodex(raw)).toEqual({
      type: `permission_request`,
      id: `approval-1`,
      tool: `Bash`,
      input: { command: `rm -rf node_modules` },
    })
  })

  it(`should normalize a turn complete response`, () => {
    expect(
      normalizeCodex({
        jsonrpc: `2.0`,
        id: 1,
        result: { success: true },
      })
    ).toEqual({
      type: `turn_complete`,
      success: true,
    })
  })

  it(`should ignore non-turn app-server responses`, () => {
    expect(
      normalizeCodex({
        jsonrpc: `2.0`,
        id: 1,
        result: {
          userAgent: `probe/0.0.0`,
          codexHome: `/tmp/codex`,
        },
      })
    ).toBeNull()
  })

  it(`should normalize a turn error`, () => {
    expect(
      normalizeCodex({
        jsonrpc: `2.0`,
        id: 1,
        error: { code: -32000, message: `Something failed` },
      })
    ).toEqual({
      type: `turn_complete`,
      success: false,
    })
  })

  it(`should return unknown for unrecognized types`, () => {
    const raw = { type: `future_type`, data: true }
    expect(normalizeCodex(raw)).toEqual({
      type: `unknown`,
      rawType: `future_type`,
      raw,
    })
  })
})
