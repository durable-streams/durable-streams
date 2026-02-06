/**
 * Multi-Agent Convergence Tests
 *
 * Verifies that multiple filesystem instances sharing the same stream prefix
 * converge to consistent state (I8: Multi-Agent Eventual Consistency).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableFilesystem } from "../src/filesystem"
import { takeSnapshot } from "./dsl/scenario-builder"
import type { FilesystemSnapshot } from "./dsl/types"

describe(`Multi-Agent Convergence`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string
  let streamPrefix: string
  const agents: Array<DurableFilesystem> = []

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

  async function createAgent(): Promise<DurableFilesystem> {
    const agent = new DurableFilesystem({ baseUrl, streamPrefix })
    await agent.initialize()
    agents.push(agent)
    return agent
  }

  function snapshotsEqual(
    a: FilesystemSnapshot,
    b: FilesystemSnapshot
  ): boolean {
    // Compare directories
    if (a.directories.size !== b.directories.size) return false
    for (const dir of a.directories) {
      if (!b.directories.has(dir)) return false
    }

    // Compare files
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
    it(`agents converge after sequential writes + refresh`, async () => {
      const agent1 = await createAgent()
      const agent2 = await createAgent()

      // Agent 1 creates a file
      await agent1.createFile(`/from-agent1.txt`, `Hello from Agent 1`)

      // Agent 2 doesn't see it yet (stale local state)
      expect(agent2.exists(`/from-agent1.txt`)).toBe(false)

      // Agent 2 refreshes
      await agent2.refresh()

      // Now Agent 2 sees the file
      expect(agent2.exists(`/from-agent1.txt`)).toBe(true)
      const content = await agent2.readTextFile(`/from-agent1.txt`)
      expect(content).toBe(`Hello from Agent 1`)
    })

    it(`agents converge after concurrent writes + refresh`, async () => {
      const agent1 = await createAgent()
      const agent2 = await createAgent()

      // Both agents write concurrently
      await Promise.all([
        agent1.createFile(`/file1.txt`, `from agent 1`),
        agent2.createFile(`/file2.txt`, `from agent 2`),
      ])

      // Refresh both
      await Promise.all([agent1.refresh(), agent2.refresh()])

      // Both should see both files
      expect(agent1.exists(`/file1.txt`)).toBe(true)
      expect(agent1.exists(`/file2.txt`)).toBe(true)
      expect(agent2.exists(`/file1.txt`)).toBe(true)
      expect(agent2.exists(`/file2.txt`)).toBe(true)

      // Snapshots should be identical
      const snapshot1 = await takeSnapshot(agent1)
      const snapshot2 = await takeSnapshot(agent2)
      expect(snapshotsEqual(snapshot1, snapshot2)).toBe(true)
    })

    it(`handles write conflicts with last-writer-wins`, async () => {
      const agent1 = await createAgent()
      const agent2 = await createAgent()

      // Agent 1 creates file
      await agent1.createFile(`/shared.txt`, `version 1`)

      // Agent 2 refreshes to see it
      await agent2.refresh()

      // Both agents write to the same file
      await agent1.writeFile(`/shared.txt`, `agent1 update`)
      await agent2.writeFile(`/shared.txt`, `agent2 update`)

      // Refresh both
      await agent1.refresh()
      await agent2.refresh()

      // Both should see the same content (last writer wins)
      const content1 = await agent1.readTextFile(`/shared.txt`)
      const content2 = await agent2.readTextFile(`/shared.txt`)
      expect(content1).toBe(content2)
    })

    it(`handles directory creation by multiple agents`, async () => {
      const agent1 = await createAgent()
      const agent2 = await createAgent()

      // Agent 1 creates directory structure
      await agent1.mkdir(`/shared`)
      await agent1.mkdir(`/shared/subdir1`)

      // Agent 2 refreshes and adds to it
      await agent2.refresh()
      await agent2.mkdir(`/shared/subdir2`)

      // Refresh agent 1
      await agent1.refresh()

      // Both see complete structure
      expect(agent1.isDirectory(`/shared/subdir1`)).toBe(true)
      expect(agent1.isDirectory(`/shared/subdir2`)).toBe(true)
      expect(agent2.isDirectory(`/shared/subdir1`)).toBe(true)
      expect(agent2.isDirectory(`/shared/subdir2`)).toBe(true)
    })
  })

  describe(`N-Agent Scenarios`, () => {
    it(`3 agents converge on shared state`, async () => {
      const threeAgents = await Promise.all([
        createAgent(),
        createAgent(),
        createAgent(),
      ])

      // Each agent creates a file
      await Promise.all(
        threeAgents.map((agent, i) =>
          agent.createFile(`/agent-${i}.txt`, `content from agent ${i}`)
        )
      )

      // All refresh
      await Promise.all(threeAgents.map((a) => a.refresh()))

      // All should see all files
      for (const agent of threeAgents) {
        for (let i = 0; i < 3; i++) {
          expect(agent.exists(`/agent-${i}.txt`)).toBe(true)
        }
      }

      // All snapshots should be identical
      const snapshots = await Promise.all(threeAgents.map(takeSnapshot))
      for (let i = 1; i < snapshots.length; i++) {
        expect(snapshotsEqual(snapshots[i]!, snapshots[0]!)).toBe(true)
      }
    })

    it(`5 agents with interleaved operations`, async () => {
      const N = 5
      const fiveAgents = await Promise.all(
        Array.from({ length: N }, () => createAgent())
      )

      // Interleaved operations: agent i creates file, then agent (i+1) creates dir
      for (let i = 0; i < N; i++) {
        await fiveAgents[i]!.createFile(`/file-${i}.txt`, `from ${i}`)
        await fiveAgents[(i + 1) % N]!.mkdir(`/dir-${i}`)
      }

      // All refresh
      await Promise.all(fiveAgents.map((a) => a.refresh()))

      // Verify all agents converge
      const snapshots = await Promise.all(fiveAgents.map(takeSnapshot))
      for (let i = 1; i < N; i++) {
        expect(snapshotsEqual(snapshots[i]!, snapshots[0]!)).toBe(true)
      }

      // Verify expected state
      for (const agent of fiveAgents) {
        expect(agent.list(`/`).length).toBe(N * 2) // N files + N dirs
      }
    })
  })

  describe(`Late-Joining Agent`, () => {
    it(`new agent sees complete history on initialize`, async () => {
      const agent1 = await createAgent()

      // Agent 1 creates several files
      await agent1.mkdir(`/docs`)
      await agent1.createFile(`/readme.txt`, `Welcome`)
      await agent1.createFile(`/docs/guide.md`, `# Guide`)

      // New agent joins later
      const agent2 = await createAgent()

      // Agent 2 should see everything immediately
      expect(agent2.exists(`/readme.txt`)).toBe(true)
      expect(agent2.exists(`/docs`)).toBe(true)
      expect(agent2.exists(`/docs/guide.md`)).toBe(true)

      const content = await agent2.readTextFile(`/docs/guide.md`)
      expect(content).toBe(`# Guide`)
    })
  })

  describe(`Delete Propagation`, () => {
    it(`deleted files disappear from all agents after refresh`, async () => {
      const agent1 = await createAgent()
      const agent2 = await createAgent()

      // Agent 1 creates and agent 2 sees it
      await agent1.createFile(`/to-delete.txt`, `temporary`)
      await agent2.refresh()
      expect(agent2.exists(`/to-delete.txt`)).toBe(true)

      // Agent 1 deletes
      await agent1.deleteFile(`/to-delete.txt`)

      // Agent 2 refreshes
      await agent2.refresh()
      expect(agent2.exists(`/to-delete.txt`)).toBe(false)
    })

    it(`deleted directories disappear from all agents`, async () => {
      const agent1 = await createAgent()
      const agent2 = await createAgent()

      await agent1.mkdir(`/temp-dir`)
      await agent2.refresh()
      expect(agent2.isDirectory(`/temp-dir`)).toBe(true)

      await agent1.rmdir(`/temp-dir`)
      await agent2.refresh()
      expect(agent2.exists(`/temp-dir`)).toBe(false)
    })
  })

  describe(`Content Consistency`, () => {
    it(`patch-based writes propagate correctly`, async () => {
      const agent1 = await createAgent()
      const agent2 = await createAgent()

      // Create initial content
      await agent1.createFile(`/doc.md`, `# Title\n\nOriginal content here.`)
      await agent2.refresh()

      // Agent 1 makes small edit (triggers patch)
      await agent1.writeFile(`/doc.md`, `# Title\n\nUpdated content here.`)

      // Agent 2 refreshes and reads
      await agent2.refresh()
      const content = await agent2.readTextFile(`/doc.md`)
      expect(content).toBe(`# Title\n\nUpdated content here.`)
    })

    it(`multiple sequential edits propagate correctly`, async () => {
      const agent1 = await createAgent()
      const agent2 = await createAgent()

      await agent1.createFile(`/evolving.txt`, `v1`)

      for (let v = 2; v <= 5; v++) {
        await agent1.writeFile(`/evolving.txt`, `v${v}`)
      }

      await agent2.refresh()
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

      // Each agent creates 5 files
      for (let a = 0; a < N; a++) {
        for (let f = 0; f < 5; f++) {
          await tenAgents[a]!.createFile(`/agent${a}-file${f}.txt`, `content`)
        }
      }

      // All refresh
      await Promise.all(tenAgents.map((a) => a.refresh()))

      // All should see 50 files
      for (const agent of tenAgents) {
        const entries = agent.list(`/`)
        expect(entries.length).toBe(50)
      }

      // All snapshots identical
      const snapshots = await Promise.all(tenAgents.map(takeSnapshot))
      for (let i = 1; i < N; i++) {
        expect(snapshotsEqual(snapshots[i]!, snapshots[0]!)).toBe(true)
      }
    })
  })
})
