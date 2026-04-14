import { describe, expect, it } from "vitest"
import { normalizeToolName, denormalizeToolName } from "../src/tools.js"

describe(`normalizeToolName`, () => {
  describe(`claude`, () => {
    it(`maps Read to file_read`, () => {
      const result = normalizeToolName(`Read`, `claude`)
      expect(result.normalized).toBe(`file_read`)
      expect(result.originalTool).toBe(`Read`)
      expect(result.originalAgent).toBe(`claude`)
    })

    it(`maps Bash to terminal`, () => {
      expect(normalizeToolName(`Bash`, `claude`).normalized).toBe(`terminal`)
    })

    it(`maps Edit to file_edit`, () => {
      expect(normalizeToolName(`Edit`, `claude`).normalized).toBe(`file_edit`)
    })

    it(`maps Grep to content_search`, () => {
      expect(normalizeToolName(`Grep`, `claude`).normalized).toBe(
        `content_search`
      )
    })

    it(`preserves unknown tools`, () => {
      const result = normalizeToolName(`CustomMcpTool`, `claude`)
      expect(result.normalized).toBe(`CustomMcpTool`)
      expect(result.originalTool).toBe(`CustomMcpTool`)
    })
  })

  describe(`codex exec_command classification`, () => {
    it(`classifies cat as file_read`, () => {
      const result = normalizeToolName(`exec_command`, `codex`, {
        cmd: `cat /tmp/foo.ts`,
      })
      expect(result.normalized).toBe(`file_read`)
    })

    it(`classifies head as file_read`, () => {
      const result = normalizeToolName(`exec_command`, `codex`, {
        cmd: `head -50 /tmp/foo.ts`,
      })
      expect(result.normalized).toBe(`file_read`)
    })

    it(`classifies rg as content_search`, () => {
      const result = normalizeToolName(`exec_command`, `codex`, {
        cmd: `rg "function main" src/`,
      })
      expect(result.normalized).toBe(`content_search`)
    })

    it(`classifies rg --files as file_search`, () => {
      const result = normalizeToolName(`exec_command`, `codex`, {
        cmd: `rg --files src/`,
      })
      expect(result.normalized).toBe(`file_search`)
    })

    it(`classifies find as file_search`, () => {
      const result = normalizeToolName(`exec_command`, `codex`, {
        cmd: `find . -name "*.ts"`,
      })
      expect(result.normalized).toBe(`file_search`)
    })

    it(`classifies ls as file_search`, () => {
      const result = normalizeToolName(`exec_command`, `codex`, {
        cmd: `ls -la src/`,
      })
      expect(result.normalized).toBe(`file_search`)
    })

    it(`classifies grep as content_search`, () => {
      const result = normalizeToolName(`exec_command`, `codex`, {
        cmd: `grep -rn "TODO" .`,
      })
      expect(result.normalized).toBe(`content_search`)
    })

    it(`defaults to terminal for git commands`, () => {
      const result = normalizeToolName(`exec_command`, `codex`, {
        cmd: `git status`,
      })
      expect(result.normalized).toBe(`terminal`)
    })

    it(`defaults to terminal for npm commands`, () => {
      const result = normalizeToolName(`exec_command`, `codex`, {
        cmd: `npm test`,
      })
      expect(result.normalized).toBe(`terminal`)
    })
  })

  describe(`codex apply_patch`, () => {
    it(`classifies new file as file_write`, () => {
      const result = normalizeToolName(`apply_patch`, `codex`, {
        input: `*** Begin Patch\n*** Add File: /tmp/foo.ts\n+const x = 1`,
      })
      expect(result.normalized).toBe(`file_write`)
    })

    it(`classifies update as file_edit`, () => {
      const result = normalizeToolName(`apply_patch`, `codex`, {
        input: `*** Begin Patch\n*** Update File: /tmp/foo.ts`,
      })
      expect(result.normalized).toBe(`file_edit`)
    })
  })
})

describe(`denormalizeToolName`, () => {
  it(`maps terminal to Bash for claude`, () => {
    expect(denormalizeToolName(`terminal`, `claude`)).toBe(`Bash`)
  })

  it(`maps file_read to Read for claude`, () => {
    expect(denormalizeToolName(`file_read`, `claude`)).toBe(`Read`)
  })

  it(`maps terminal to exec_command for codex`, () => {
    expect(denormalizeToolName(`terminal`, `codex`)).toBe(`exec_command`)
  })

  it(`maps file_edit to apply_patch for codex`, () => {
    expect(denormalizeToolName(`file_edit`, `codex`)).toBe(`apply_patch`)
  })

  it(`passes through unknown tools`, () => {
    expect(denormalizeToolName(`unknown_tool`, `claude`)).toBe(`unknown_tool`)
  })
})
