import { spawn } from "node:child_process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { getUsageText } from "../src/index"

describe(`CLI --help`, () => {
  it(`outputs expected usage text`, () => {
    const usage = getUsageText()
    expect(usage).toMatchSnapshot()
  })

  it(`includes --url option in usage`, () => {
    const usage = getUsageText()
    expect(usage).toContain(`--url <url>`)
    expect(usage).toContain(`Stream server URL`)
  })

  it(`includes --help option in usage`, () => {
    const usage = getUsageText()
    expect(usage).toContain(`--help, -h`)
  })

  it(`includes all commands in usage`, () => {
    const usage = getUsageText()
    expect(usage).toContain(`create <stream_id>`)
    expect(usage).toContain(`write <stream_id>`)
    expect(usage).toContain(`read <stream_id>`)
    expect(usage).toContain(`delete <stream_id>`)
  })

  it(`exits with code 0 when --help flag is passed`, async () => {
    const cliPath = new URL(`../dist/index.js`, import.meta.url).pathname
    const result = await new Promise<{
      stdout: string
      stderr: string
      exitCode: number
    }>((resolve) => {
      const child = spawn(process.execPath, [cliPath, `--help`], {
        env: { ...process.env },
      })

      let stdout = ``
      let stderr = ``

      child.stdout.on(`data`, (data) => {
        stdout += data.toString()
      })
      child.stderr.on(`data`, (data) => {
        stderr += data.toString()
      })

      child.on(`close`, (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      })
    })

    expect(result.exitCode).toBe(0)
    // --help should print to stdout, not stderr (POSIX convention)
    expect(result.stdout).toContain(`Usage:`)
    expect(result.stderr).toBe(``)
  })

  it(`exits with code 0 when -h flag is passed`, async () => {
    const cliPath = new URL(`../dist/index.js`, import.meta.url).pathname
    const result = await new Promise<{
      stdout: string
      stderr: string
      exitCode: number
    }>((resolve) => {
      const child = spawn(process.execPath, [cliPath, `-h`], {
        env: { ...process.env },
      })

      let stdout = ``
      let stderr = ``

      child.stdout.on(`data`, (data) => {
        stdout += data.toString()
      })
      child.stderr.on(`data`, (data) => {
        stderr += data.toString()
      })

      child.on(`close`, (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      })
    })

    expect(result.exitCode).toBe(0)
    // -h should print to stdout, not stderr (POSIX convention)
    expect(result.stdout).toContain(`Usage:`)
    expect(result.stderr).toBe(``)
  })
})

describe(`CLI commands with server`, () => {
  let server: DurableStreamTestServer
  let serverUrl: string

  async function runCli(
    args: Array<string>
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cliPath = new URL(`../dist/index.js`, import.meta.url).pathname
    const fullArgs = [`${cliPath}`, `--url`, serverUrl, ...args]

    return new Promise((resolve) => {
      const child = spawn(process.execPath, fullArgs, {
        env: { ...process.env },
      })

      let stdout = ``
      let stderr = ``

      child.stdout.on(`data`, (data) => {
        stdout += data.toString()
      })

      child.stderr.on(`data`, (data) => {
        stderr += data.toString()
      })

      const timeout = setTimeout(() => {
        child.kill(`SIGTERM`)
        resolve({
          stdout,
          stderr: `Command timed out\n` + stderr,
          exitCode: 124,
        })
      }, 10000)

      child.on(`close`, (code) => {
        clearTimeout(timeout)
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        })
      })

      child.on(`error`, (err) => {
        clearTimeout(timeout)
        resolve({
          stdout,
          stderr: err.message,
          exitCode: 1,
        })
      })
    })
  }

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0, host: `localhost` })
    serverUrl = await server.start()
    serverUrl = serverUrl.replace(`127.0.0.1`, `localhost`)
    console.log(`Test server started at: ${serverUrl}`)
  }, 30000)

  afterAll(async () => {
    await server.stop()
  }, 10000)

  it(`verifies server is accessible`, async () => {
    const response = await fetch(`${serverUrl}/v1/stream/test-health`)
    console.log(`Server health check: ${response.status}`)
  })

  it(`creates a stream with success message`, async () => {
    const streamId = `test-create-${Date.now()}`
    const result = await runCli([`create`, streamId])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      `Stream created successfully: "${streamId}"`
    )
  })

  it(`writes to a stream with success message`, async () => {
    const streamId = `test-write-${Date.now()}`

    await runCli([`create`, streamId])
    const result = await runCli([`write`, streamId, `Hello, world!`])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`Wrote`)
    expect(result.stdout).toContain(`to stream "${streamId}"`)
  })

  it(`writes multiple messages to a stream`, async () => {
    const streamId = `test-write-multi-${Date.now()}`

    await runCli([`create`, streamId])
    const result1 = await runCli([`write`, streamId, `message 1`])
    const result2 = await runCli([`write`, streamId, `message 2`])

    expect(result1.exitCode).toBe(0)
    expect(result1.stdout).toContain(`Wrote`)
    expect(result2.exitCode).toBe(0)
    expect(result2.stdout).toContain(`Wrote`)
  })

  it(`deletes a stream with success message`, async () => {
    const streamId = `test-delete-${Date.now()}`

    await runCli([`create`, streamId])
    const result = await runCli([`delete`, streamId])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      `Stream deleted successfully: "${streamId}"`
    )
  })

  it(`allows idempotent stream creation`, async () => {
    const streamId = `test-duplicate-${Date.now()}`

    const result1 = await runCli([`create`, streamId])
    const result2 = await runCli([`create`, streamId])

    // Creating the same stream twice should succeed (idempotent)
    expect(result1.exitCode).toBe(0)
    expect(result2.exitCode).toBe(0)
  })

  it(`shows error when writing to non-existent stream`, async () => {
    const result = await runCli([`write`, `non-existent-stream`, `hello`])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`Failed to write to stream`)
  })

  it(`shows error when deleting non-existent stream`, async () => {
    const result = await runCli([`delete`, `non-existent-stream`])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`Failed to delete stream`)
  })

  it(`shows error for unknown command`, async () => {
    const result = await runCli([`unknown-command`])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`Error: Unknown command`)
  })

  it(`shows error for unknown option (not unknown command)`, async () => {
    const result = await runCli([`--foobar`])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`Error: Unknown option`)
    expect(result.stderr).not.toContain(`Unknown command`)
  })

  it(`shows error when stream_id is missing`, async () => {
    const result = await runCli([`create`])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`Error: Missing stream_id`)
  })
})
