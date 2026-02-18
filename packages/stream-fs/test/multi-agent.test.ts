/**
 * Multi-Agent Convergence Tests
 *
 * Verifies that multiple filesystem instances sharing the same stream prefix
 * converge to consistent state (I8: Multi-Agent Eventual Consistency).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { StreamFilesystem } from "../src/filesystem"
import { takeSnapshot } from "./dsl/scenario-builder"
import type { FilesystemSnapshot } from "./dsl/types"

describe(`Multi-Agent Convergence`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string
  let streamPrefix: string
  const agents: Array<StreamFilesystem> = []

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url
    streamPrefix = `/fs/multi-${Date.now()}-${Math.random().toString(36).slice(2)}`
  })

  afterEach(async () => {
    for (const agent of agents) {
      agent.close()
    }
    agents.length = 0
    await server.stop()
  })

  async function createAgent(): Promise<StreamFilesystem> {
    const agent = new StreamFilesystem({ baseUrl, streamPrefix })
    await agent.initialize()
    agents.push(agent)
    return agent
  }

  function snapshotsEqual(
    a: FilesystemSnapshot,
    b: FilesystemSnapshot
  ): boolean {
    if (a.directories.size !== b.directories.size) return false
    for (const dir of a.directories) {
      if (!b.directories.has(dir)) return false
    }

    if (a.files.size !== b.files.size) return false
    for (const [path, fileA] of a.files) {
      const fileB = b.files.get(path)
      if (!fileB) return false
      if (fileA.content !== fileB.content) return false
      if (fileA.size !== fileB.size) return false
    }

    return true
  }

  describe(`Two-Agent Scenarios`, () => {
    it(`fresh agent sees writes from earlier agent`, async () => {
      const agent1 = await createAgent()

      await agent1.createFile(`/from-agent1.txt`, `Hello from Agent 1`)

      // Fresh agent sees writes via initialize
      const agent2 = await createAgent()
      expect(agent2.exists(`/from-agent1.txt`)).toBe(true)
      const content = await agent2.readTextFile(`/from-agent1.txt`)
      expect(content).toBe(`Hello from Agent 1`)
    })

    it(`agents converge after concurrent writes`, async () => {
      const agent1 = await createAgent()
      const agent2 = await createAgent()

      await Promise.all([
        agent1.createFile(`/file1.txt`, `from agent 1`),
        agent2.createFile(`/file2.txt`, `from agent 2`),
      ])

      // Fresh agents verify convergence
      const verifier1 = await createAgent()
      const verifier2 = await createAgent()

      expect(verifier1.exists(`/file1.txt`)).toBe(true)
      expect(verifier1.exists(`/file2.txt`)).toBe(true)
      expect(verifier2.exists(`/file1.txt`)).toBe(true)
      expect(verifier2.exists(`/file2.txt`)).toBe(true)

      const snapshot1 = await takeSnapshot(verifier1)
      const snapshot2 = await takeSnapshot(verifier2)
      expect(snapshotsEqual(snapshot1, snapshot2)).toBe(true)
    })

    it(`handles write conflicts with last-writer-wins`, async () => {
      const agent1 = await createAgent()

      await agent1.createFile(`/shared.txt`, `version 1`)

      // agent2 sees the file via fresh initialize
      const agent2 = await createAgent()

      await agent1.writeFile(`/shared.txt`, `agent1 update`)
      await agent2.writeFile(`/shared.txt`, `agent2 update`)

      // Both fresh views should see the same content (last writer wins)
      const verifier1 = await createAgent()
      const verifier2 = await createAgent()
      const content1 = await verifier1.readTextFile(`/shared.txt`)
      const content2 = await verifier2.readTextFile(`/shared.txt`)
      expect(content1).toBe(content2)
    })

    it(`handles directory creation by multiple agents`, async () => {
      const agent1 = await createAgent()

      await agent1.mkdir(`/shared`)
      await agent1.mkdir(`/shared/subdir1`)

      // agent2 sees directories via fresh initialize
      const agent2 = await createAgent()
      await agent2.mkdir(`/shared/subdir2`)

      // Verify both see the complete structure
      const verifier = await createAgent()
      expect(verifier.isDirectory(`/shared/subdir1`)).toBe(true)
      expect(verifier.isDirectory(`/shared/subdir2`)).toBe(true)
    })
  })

  describe(`N-Agent Scenarios`, () => {
    it(`3 agents converge on shared state`, async () => {
      const threeAgents = await Promise.all([
        createAgent(),
        createAgent(),
        createAgent(),
      ])

      await Promise.all(
        threeAgents.map((agent, i) =>
          agent.createFile(`/agent-${i}.txt`, `content from agent ${i}`)
        )
      )

      // Fresh agents verify convergence
      const verifiers = await Promise.all([
        createAgent(),
        createAgent(),
        createAgent(),
      ])

      for (const agent of verifiers) {
        for (let i = 0; i < 3; i++) {
          expect(agent.exists(`/agent-${i}.txt`)).toBe(true)
        }
      }

      const snapshots = await Promise.all(verifiers.map(takeSnapshot))
      for (let i = 1; i < snapshots.length; i++) {
        expect(snapshotsEqual(snapshots[i]!, snapshots[0]!)).toBe(true)
      }
    })

    it(`5 agents with interleaved operations`, async () => {
      const N = 5
      const fiveAgents = await Promise.all(
        Array.from({ length: N }, () => createAgent())
      )

      for (let i = 0; i < N; i++) {
        await fiveAgents[i]!.createFile(`/file-${i}.txt`, `from ${i}`)
        await fiveAgents[(i + 1) % N]!.mkdir(`/dir-${i}`)
      }

      // Fresh agents verify convergence
      const verifiers = await Promise.all(
        Array.from({ length: N }, () => createAgent())
      )

      const snapshots = await Promise.all(verifiers.map(takeSnapshot))
      for (let i = 1; i < N; i++) {
        expect(snapshotsEqual(snapshots[i]!, snapshots[0]!)).toBe(true)
      }

      for (const agent of verifiers) {
        expect(agent.list(`/`).length).toBe(N * 2)
      }
    })
  })

  describe(`Late-Joining Agent`, () => {
    it(`new agent sees complete history on initialize`, async () => {
      const agent1 = await createAgent()

      await agent1.mkdir(`/docs`)
      await agent1.createFile(`/readme.txt`, `Welcome`)
      await agent1.createFile(`/docs/guide.md`, `# Guide`)

      const agent2 = await createAgent()

      expect(agent2.exists(`/readme.txt`)).toBe(true)
      expect(agent2.exists(`/docs`)).toBe(true)
      expect(agent2.exists(`/docs/guide.md`)).toBe(true)

      const content = await agent2.readTextFile(`/docs/guide.md`)
      expect(content).toBe(`# Guide`)
    })
  })

  describe(`Delete Propagation`, () => {
    it(`deleted files disappear from all agents after re-initialization`, async () => {
      const agent1 = await createAgent()

      await agent1.createFile(`/to-delete.txt`, `temporary`)

      // agent2 sees the file
      const agent2 = await createAgent()
      expect(agent2.exists(`/to-delete.txt`)).toBe(true)

      await agent1.deleteFile(`/to-delete.txt`)

      // Fresh view confirms deletion
      const agent3 = await createAgent()
      expect(agent3.exists(`/to-delete.txt`)).toBe(false)
    })

    it(`deleted directories disappear from all agents`, async () => {
      const agent1 = await createAgent()

      await agent1.mkdir(`/temp-dir`)

      const agent2 = await createAgent()
      expect(agent2.isDirectory(`/temp-dir`)).toBe(true)

      await agent1.rmdir(`/temp-dir`)

      const agent3 = await createAgent()
      expect(agent3.exists(`/temp-dir`)).toBe(false)
    })
  })

  describe(`Content Consistency`, () => {
    it(`patch-based writes propagate correctly`, async () => {
      const agent1 = await createAgent()

      await agent1.createFile(`/doc.md`, `# Title\n\nOriginal content here.`)
      await agent1.writeFile(`/doc.md`, `# Title\n\nUpdated content here.`)

      const agent2 = await createAgent()
      const content = await agent2.readTextFile(`/doc.md`)
      expect(content).toBe(`# Title\n\nUpdated content here.`)
    })

    it(`multiple sequential edits propagate correctly`, async () => {
      const agent1 = await createAgent()

      await agent1.createFile(`/evolving.txt`, `v1`)

      for (let v = 2; v <= 5; v++) {
        await agent1.writeFile(`/evolving.txt`, `v${v}`)
      }

      const agent2 = await createAgent()
      const content = await agent2.readTextFile(`/evolving.txt`)
      expect(content).toBe(`v5`)
    })
  })

  describe(`Stress Tests`, () => {
    it(`10 agents with 5 operations each converge`, async () => {
      const N = 10
      const tenAgents = await Promise.all(
        Array.from({ length: N }, () => createAgent())
      )

      for (let a = 0; a < N; a++) {
        for (let f = 0; f < 5; f++) {
          await tenAgents[a]!.createFile(`/agent${a}-file${f}.txt`, `content`)
        }
      }

      // Fresh agents verify convergence
      const verifiers = await Promise.all(
        Array.from({ length: N }, () => createAgent())
      )

      for (const agent of verifiers) {
        const entries = agent.list(`/`)
        expect(entries.length).toBe(50)
      }

      const snapshots = await Promise.all(verifiers.map(takeSnapshot))
      for (let i = 1; i < N; i++) {
        expect(snapshotsEqual(snapshots[i]!, snapshots[0]!)).toBe(true)
      }
    })
  })
})
