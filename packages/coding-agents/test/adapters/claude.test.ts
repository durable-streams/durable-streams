import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ClaudeAdapter } from "../../src/adapters/claude.js"
import type { AgentConnection, SpawnOptions } from "../../src/adapters/types.js"

describe(`ClaudeAdapter`, () => {
  const adapter = new ClaudeAdapter()

  it(`should expose the claude agent type`, () => {
    expect(adapter.agentType).toBe(`claude`)
  })

  describe(`parseDirection`, () => {
    it(`should classify a control_request as a request`, () => {
      expect(
        adapter.parseDirection({
          type: `control_request`,
          request_id: `req-1`,
          request: { subtype: `can_use_tool` },
        })
      ).toEqual({ type: `request`, id: `req-1` })
    })

    it(`should classify a control_response as a response`, () => {
      expect(
        adapter.parseDirection({
          type: `control_response`,
          response: { request_id: `req-1`, subtype: `success` },
        })
      ).toEqual({ type: `response`, id: `req-1` })
    })

    it(`should classify assistant messages as notifications`, () => {
      expect(
        adapter.parseDirection({
          type: `assistant`,
          message: { content: [] },
        })
      ).toEqual({ type: `notification` })
    })
  })

  describe(`isTurnComplete`, () => {
    it(`should return true for result messages`, () => {
      expect(
        adapter.isTurnComplete({ type: `result`, subtype: `success` })
      ).toBe(true)
      expect(
        adapter.isTurnComplete({
          type: `result`,
          subtype: `error_during_execution`,
        })
      ).toBe(true)
    })

    it(`should return false for other messages`, () => {
      expect(adapter.isTurnComplete({ type: `assistant` })).toBe(false)
      expect(adapter.isTurnComplete({ type: `stream_event` })).toBe(false)
      expect(adapter.isTurnComplete({ type: `control_request` })).toBe(false)
    })
  })

  it(`should translate prompts into Claude stream-json user messages`, () => {
    expect(
      adapter.translateClientIntent({ type: `user_message`, text: `hello` })
    ).toEqual({
      type: `user`,
      message: {
        role: `user`,
        content: `hello`,
      },
      parent_tool_use_id: null,
      session_id: ``,
    })
  })

  it(`should pass through non-prompt client intents unchanged`, () => {
    const raw = {
      type: `control_response`,
      response: {
        request_id: `req-1`,
        subtype: `success`,
        response: { behavior: `allow` },
      },
    } as const

    expect(adapter.translateClientIntent(raw)).toBe(raw)
  })

  it(`should rewrite serialized paths when preparing a resume transcript`, async () => {
    const oldPath = `/tmp/old-workspace`
    const rewrittenPath = `/tmp/new-workspace`
    const cwd = await mkdtemp(join(tmpdir(), `claude-rewrite-cwd-`))
    const canonicalCwd = await realpath(cwd)
    const resumeId = `resume-rewrite-${Date.now()}`
    const sessionDir = join(
      homedir(),
      `.claude`,
      `projects`,
      canonicalCwd.replace(/[^a-zA-Z0-9.-]/g, `-`) || `project`
    )
    const transcriptPath = join(sessionDir, `${resumeId}.jsonl`)

    try {
      const prepared = await adapter.prepareResume(
        [
          {
            agent: `claude`,
            direction: `agent`,
            timestamp: Date.now(),
            raw: {
              type: `system`,
              session_id: resumeId,
              cwd: oldPath,
            },
          },
          {
            agent: `claude`,
            direction: `user`,
            timestamp: Date.now() + 1,
            user: { name: `Test`, email: `test@test.com` },
            raw: {
              type: `user_message`,
              text: `Look at ${oldPath}/src/index.ts`,
            },
          },
        ],
        {
          cwd,
          rewritePaths: {
            [oldPath]: rewrittenPath,
          },
        }
      )

      expect(prepared.resumeId).toBe(resumeId)

      const transcript = await readFile(transcriptPath, `utf8`)
      expect(transcript).toContain(rewrittenPath)
      expect(transcript).not.toContain(oldPath)
      expect(transcript).toContain(`"type":"user"`)
      expect(transcript).not.toContain(`"type":"user_message"`)
      expect(transcript).toContain(`"session_id":"${resumeId}"`)
    } finally {
      await rm(transcriptPath, { force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it(`should fall back to a seeded Claude session when resume is not registered in the workspace`, async () => {
    const mockConnection: AgentConnection = {
      onMessage() {},
      send() {},
      kill() {},
      on() {},
    }

    class TestClaudeAdapter extends ClaudeAdapter {
      readonly resumeAttempts: Array<string | undefined> = []
      spawnBridgeConnection(options: SpawnOptions): Promise<AgentConnection> {
        this.resumeAttempts.push(options.resume)
        if (options.resume === `synthetic-session`) {
          throw new Error(
            `Claude Code exited before connecting: No conversation found with session ID: synthetic-session`
          )
        }

        return Promise.resolve(mockConnection)
      }

      seedSyntheticResumeSession(): Promise<string> {
        return Promise.resolve(`seeded-session`)
      }
    }

    const testAdapter = new TestClaudeAdapter()
    const connection = await testAdapter.spawn({
      cwd: `/tmp/claude-seed-fallback`,
      resume: `synthetic-session`,
      permissionMode: `plan`,
    })

    expect(connection).toBe(mockConnection)
    expect(testAdapter.resumeAttempts).toEqual([
      `synthetic-session`,
      `seeded-session`,
    ])
  })
})
