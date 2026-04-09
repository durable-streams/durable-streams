import { describe, expect, it } from "vitest"
import {
  createAgentDBMaterializerState,
  materializeAgentDBEnvelope,
  materializeAgentDBEnvelopeWithState,
} from "../../src/agent-db-materializer.js"
import type { StreamEnvelope } from "../../src/types.js"

describe(`materializeAgentDBEnvelope`, () => {
  it(`materializes participants and user messages`, () => {
    const envelope: StreamEnvelope = {
      agent: `claude`,
      direction: `user`,
      timestamp: 1_700_000_000_000,
      user: {
        name: `Alice`,
        email: `alice@example.com`,
      },
      raw: {
        type: `user_message`,
        text: `hello`,
      },
    }

    const mutations = materializeAgentDBEnvelope({
      streamId: `session-1`,
      envelope,
      sequence: 1,
    })

    expect(mutations.map((mutation) => mutation.collection)).toEqual([
      `sessions`,
      `participants`,
      `messages`,
      `message_parts`,
      `turns`,
    ])
    expect(mutations[1]?.value).toMatchObject({
      id: `Alice<alice@example.com>`,
      sessionId: `session-1`,
    })
    expect(mutations[2]?.value).toMatchObject({
      role: `user`,
      kind: `user_message`,
      participantId: `Alice<alice@example.com>`,
    })
    expect(mutations[3]?.value).toMatchObject({
      kind: `text`,
      text: `hello`,
    })
    expect(mutations[4]?.value).toMatchObject({
      status: `queued`,
      promptMessageId: `row:1:message`,
    })
  })

  it(`materializes bridge lifecycle events as session events`, () => {
    const envelope: StreamEnvelope = {
      agent: `claude`,
      direction: `bridge`,
      timestamp: 1_700_000_000_000,
      type: `session_started`,
    }

    const mutations = materializeAgentDBEnvelope({
      streamId: `session-1`,
      envelope,
      sequence: 2,
    })

    expect(mutations.map((mutation) => mutation.collection)).toEqual([
      `sessions`,
      `session_events`,
    ])
    expect(mutations[1]?.value).toMatchObject({
      kind: `session_started`,
      sessionId: `session-1`,
    })
  })

  it(`materializes claude init and assistant messages`, () => {
    const initEnvelope: StreamEnvelope = {
      agent: `claude`,
      direction: `agent`,
      timestamp: 1_700_000_000_000,
      raw: {
        type: `system`,
        subtype: `init`,
        session_id: `claude-session-1`,
        model: `claude-opus-4-6`,
      },
    }

    const assistantEnvelope: StreamEnvelope = {
      agent: `claude`,
      direction: `agent`,
      timestamp: 1_700_000_000_100,
      raw: {
        type: `assistant`,
        message: {
          content: [
            {
              type: `text`,
              text: `hello world`,
            },
          ],
        },
      },
    }

    const initMutations = materializeAgentDBEnvelope({
      streamId: `session-1`,
      envelope: initEnvelope,
      sequence: 3,
    })
    const assistantMutations = materializeAgentDBEnvelope({
      streamId: `session-1`,
      envelope: assistantEnvelope,
      sequence: 4,
    })

    expect(initMutations[0]?.collection).toBe(`sessions`)
    expect(initMutations[0]?.value).toMatchObject({
      id: `session-1`,
      agent: `claude`,
      model: `claude-opus-4-6`,
      status: `initialized`,
    })
    expect(assistantMutations.map((mutation) => mutation.collection)).toEqual([
      `sessions`,
      `messages`,
      `message_parts`,
    ])
    expect(assistantMutations[1]?.value).toMatchObject({
      role: `assistant`,
      kind: `assistant_message`,
    })
    expect(assistantMutations[2]?.value).toMatchObject({
      kind: `text`,
      text: `hello world`,
    })
  })

  it(`accumulates stream deltas into an active assistant message and completes the turn`, () => {
    const state = createAgentDBMaterializerState()

    const promptEnvelope: StreamEnvelope = {
      agent: `claude`,
      direction: `user`,
      timestamp: 1_700_000_000_000,
      user: {
        name: `Alice`,
        email: `alice@example.com`,
      },
      raw: {
        type: `user_message`,
        text: `Explain the repo`,
      },
    }

    const deltaEnvelope: StreamEnvelope = {
      agent: `claude`,
      direction: `agent`,
      timestamp: 1_700_000_000_100,
      raw: {
        type: `stream_event`,
        event: {
          type: `content_block_delta`,
          delta: {
            type: `text_delta`,
            text: `Hello `,
          },
        },
      },
    }

    const completeEnvelope: StreamEnvelope = {
      agent: `claude`,
      direction: `agent`,
      timestamp: 1_700_000_000_200,
      raw: {
        type: `result`,
        subtype: `success`,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      },
    }

    const promptMutations = materializeAgentDBEnvelopeWithState(state, {
      streamId: `session-1`,
      envelope: promptEnvelope,
      sequence: 10,
    })
    const deltaMutations = materializeAgentDBEnvelopeWithState(state, {
      streamId: `session-1`,
      envelope: deltaEnvelope,
      sequence: 11,
    })
    const completeMutations = materializeAgentDBEnvelopeWithState(state, {
      streamId: `session-1`,
      envelope: completeEnvelope,
      sequence: 12,
    })

    expect(promptMutations.at(-1)?.collection).toBe(`turns`)
    expect(deltaMutations.map((mutation) => mutation.collection)).toEqual([
      `sessions`,
      `turns`,
      `messages`,
      `message_parts`,
    ])
    expect(deltaMutations[1]?.value).toMatchObject({
      id: `row:10:turn`,
      status: `active`,
    })
    expect(deltaMutations[2]?.value).toMatchObject({
      role: `assistant`,
      status: `streaming`,
      turnId: `row:10:turn`,
    })
    expect(deltaMutations[3]?.value).toMatchObject({
      kind: `text`,
      text: `Hello `,
      deltaIndex: 0,
    })
    expect(completeMutations.map((mutation) => mutation.collection)).toEqual([
      `sessions`,
      `messages`,
      `turns`,
    ])
    expect(completeMutations[1]?.value).toMatchObject({
      id: `row:11:assistant`,
      status: `completed`,
    })
    expect(completeMutations[2]?.value).toMatchObject({
      id: `row:10:turn`,
      status: `completed`,
      inputTokens: 10,
      outputTokens: 20,
    })
  })

  it(`tracks tool calls, permission requests, and tool progress across events`, () => {
    const state = createAgentDBMaterializerState()

    materializeAgentDBEnvelopeWithState(state, {
      streamId: `session-1`,
      envelope: {
        agent: `codex`,
        direction: `user`,
        timestamp: 1_700_000_000_000,
        user: {
          name: `Bob`,
          email: `bob@example.com`,
        },
        raw: {
          type: `user_message`,
          text: `Run ls`,
        },
      },
      sequence: 20,
    })

    const toolCallMutations = materializeAgentDBEnvelopeWithState(state, {
      streamId: `session-1`,
      envelope: {
        agent: `codex`,
        direction: `agent`,
        timestamp: 1_700_000_000_100,
        raw: {
          method: `item/completed`,
          params: {
            item: {
              type: `commandExecution`,
              id: `cmd-1`,
              command: `ls`,
            },
          },
        },
      },
      sequence: 21,
    })

    const permissionMutations = materializeAgentDBEnvelopeWithState(state, {
      streamId: `session-1`,
      envelope: {
        agent: `codex`,
        direction: `agent`,
        timestamp: 1_700_000_000_200,
        raw: {
          id: `perm-1`,
          method: `item/commandExecution/requestApproval`,
          params: {
            command: `ls`,
            cwd: `/tmp`,
          },
        },
      },
      sequence: 22,
    })

    expect(toolCallMutations.map((mutation) => mutation.collection)).toEqual([
      `sessions`,
      `turns`,
      `tool_calls`,
    ])
    expect(toolCallMutations[2]?.value).toMatchObject({
      toolName: `terminal`,
      status: `completed`,
      turnId: `row:20:turn`,
    })
    expect(permissionMutations.map((mutation) => mutation.collection)).toEqual([
      `sessions`,
      `permission_requests`,
    ])
    expect(permissionMutations[1]?.value).toMatchObject({
      id: `perm-1`,
      toolCallId: `row:21:tool-call`,
      status: `pending`,
    })
  })

  it(`materializes approval responses and resolves the first matching request`, () => {
    const state = createAgentDBMaterializerState()

    materializeAgentDBEnvelopeWithState(state, {
      streamId: `session-1`,
      envelope: {
        agent: `claude`,
        direction: `agent`,
        timestamp: 1_700_000_000_000,
        raw: {
          type: `control_request`,
          request_id: `perm-1`,
          tool: `Bash`,
          input: {
            command: `ls`,
          },
        },
      },
      sequence: 30,
    })

    const allowMutations = materializeAgentDBEnvelopeWithState(state, {
      streamId: `session-1`,
      envelope: {
        agent: `claude`,
        direction: `user`,
        timestamp: 1_700_000_000_100,
        user: {
          name: `Alice`,
          email: `alice@example.com`,
        },
        raw: {
          type: `control_response`,
          response: {
            request_id: `perm-1`,
            subtype: `success`,
            response: {
              behavior: `allow`,
              updatedInput: {
                command: `ls`,
              },
            },
          },
        },
      },
      sequence: 31,
    })

    expect(allowMutations.map((mutation) => mutation.collection)).toEqual([
      `sessions`,
      `participants`,
      `approval_responses`,
      `permission_requests`,
    ])
    expect(allowMutations[2]?.value).toMatchObject({
      requestId: `perm-1`,
      participantId: `Alice<alice@example.com>`,
      decision: `approved`,
      effective: true,
    })
    expect(allowMutations[3]?.value).toMatchObject({
      id: `perm-1`,
      status: `approved`,
      resolvedByParticipantId: `Alice<alice@example.com>`,
      effectiveResponseId: `row:31:approval-response`,
    })

    const duplicateMutations = materializeAgentDBEnvelopeWithState(state, {
      streamId: `session-1`,
      envelope: {
        agent: `claude`,
        direction: `user`,
        timestamp: 1_700_000_000_200,
        user: {
          name: `Bob`,
          email: `bob@example.com`,
        },
        raw: {
          type: `control_response`,
          response: {
            request_id: `perm-1`,
            subtype: `cancelled`,
            response: {},
          },
        },
      },
      sequence: 32,
    })

    expect(duplicateMutations.map((mutation) => mutation.collection)).toEqual([
      `sessions`,
      `participants`,
      `approval_responses`,
    ])
    expect(duplicateMutations[2]?.value).toMatchObject({
      requestId: `perm-1`,
      participantId: `Bob<bob@example.com>`,
      decision: `cancelled`,
      effective: false,
      ignoredReason: `request_already_resolved`,
    })
  })
})
