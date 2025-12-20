/**
 * Test runner for client conformance tests.
 *
 * Orchestrates:
 * - Reference server lifecycle
 * - Client adapter process spawning
 * - Test case execution
 * - Result validation
 */

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { DurableStreamTestServer } from "@durable-streams/server"
import { parseResult, serializeCommand } from "./protocol.js"
import {
  countTests,
  filterByCategory,
  loadEmbeddedTestSuites,
} from "./test-cases.js"
import type { Interface as ReadlineInterface } from "node:readline"
import type {
  ErrorResult,
  HeadResult,
  ReadResult,
  TestCommand,
  TestResult,
} from "./protocol.js"
import type { ChildProcess } from "node:child_process"
import type { TestCase, TestOperation } from "./test-cases.js"

// =============================================================================
// Types
// =============================================================================

export interface RunnerOptions {
  /** Path to client adapter executable, or "ts" for built-in TypeScript adapter */
  clientAdapter: string
  /** Arguments to pass to client adapter */
  clientArgs?: Array<string>
  /** Test suites to run (default: all) */
  suites?: Array<`producer` | `consumer` | `lifecycle`>
  /** Tags to filter tests */
  tags?: Array<string>
  /** Verbose output */
  verbose?: boolean
  /** Stop on first failure */
  failFast?: boolean
  /** Timeout for each test in ms */
  testTimeout?: number
  /** Port for reference server (0 for random) */
  serverPort?: number
}

export interface TestRunResult {
  suite: string
  test: string
  passed: boolean
  duration: number
  error?: string
  skipped?: boolean
  skipReason?: string
}

export interface RunSummary {
  total: number
  passed: number
  failed: number
  skipped: number
  duration: number
  results: Array<TestRunResult>
}

interface ExecutionContext {
  serverUrl: string
  variables: Map<string, unknown>
  client: ClientAdapter
  verbose: boolean
}

// =============================================================================
// Client Adapter Communication
// =============================================================================

class ClientAdapter {
  private process: ChildProcess
  private readline: ReadlineInterface
  private pendingResponse: {
    resolve: (result: TestResult) => void
    reject: (error: Error) => void
  } | null = null
  private initialized = false

  constructor(executable: string, args: Array<string> = []) {
    this.process = spawn(executable, args, {
      stdio: [`pipe`, `pipe`, `pipe`],
    })

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to create client adapter process`)
    }

    this.readline = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    })

    this.readline.on(`line`, (line) => {
      if (this.pendingResponse) {
        try {
          const result = parseResult(line)
          this.pendingResponse.resolve(result)
        } catch {
          this.pendingResponse.reject(
            new Error(`Failed to parse client response: ${line}`)
          )
        }
        this.pendingResponse = null
      }
    })

    this.process.stderr?.on(`data`, (data) => {
      console.error(`[client stderr] ${data.toString().trim()}`)
    })

    this.process.on(`error`, (err) => {
      if (this.pendingResponse) {
        this.pendingResponse.reject(err)
        this.pendingResponse = null
      }
    })

    this.process.on(`exit`, (code) => {
      if (this.pendingResponse) {
        this.pendingResponse.reject(
          new Error(`Client adapter exited with code ${code}`)
        )
        this.pendingResponse = null
      }
    })
  }

  async send(command: TestCommand, timeoutMs = 30000): Promise<TestResult> {
    if (!this.process.stdin) {
      throw new Error(`Client adapter stdin not available`)
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponse = null
        reject(
          new Error(`Command timed out after ${timeoutMs}ms: ${command.type}`)
        )
      }, timeoutMs)

      this.pendingResponse = {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      }

      const line = serializeCommand(command) + `\n`
      this.process.stdin!.write(line)
    })
  }

  async init(serverUrl: string): Promise<TestResult> {
    const result = await this.send({ type: `init`, serverUrl })
    if (result.success) {
      this.initialized = true
    }
    return result
  }

  async shutdown(): Promise<void> {
    if (this.initialized) {
      try {
        await this.send({ type: `shutdown` }, 5000)
      } catch {
        // Ignore shutdown errors
      }
    }
    this.process.kill()
    this.readline.close()
  }

  isInitialized(): boolean {
    return this.initialized
  }
}

// =============================================================================
// Test Execution
// =============================================================================

function resolveVariables(
  value: string,
  variables: Map<string, unknown>
): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    // Handle property access like ${result.offset}
    const parts = expr.split(`.`)
    let current: unknown = variables.get(parts[0])

    for (let i = 1; i < parts.length && current != null; i++) {
      current = (current as Record<string, unknown>)[parts[i]!]
    }

    return String(current ?? ``)
  })
}

function generateStreamPath(): string {
  return `/test-stream-${randomUUID()}`
}

async function executeOperation(
  op: TestOperation,
  ctx: ExecutionContext
): Promise<{ result?: TestResult; error?: string }> {
  const { client, variables, verbose } = ctx

  switch (op.action) {
    case `create`: {
      const path = op.path
        ? resolveVariables(op.path, variables)
        : generateStreamPath()

      if (op.as) {
        variables.set(op.as, path)
      }

      const result = await client.send({
        type: `create`,
        path,
        contentType: op.contentType,
        ttlSeconds: op.ttlSeconds,
        expiresAt: op.expiresAt,
        headers: op.headers,
      })

      if (verbose) {
        console.log(`  create ${path}: ${result.success ? `ok` : `failed`}`)
      }

      return { result }
    }

    case `connect`: {
      const path = resolveVariables(op.path, variables)
      const result = await client.send({
        type: `connect`,
        path,
        headers: op.headers,
      })

      if (verbose) {
        console.log(`  connect ${path}: ${result.success ? `ok` : `failed`}`)
      }

      return { result }
    }

    case `append`: {
      const path = resolveVariables(op.path, variables)
      const data = op.data ? resolveVariables(op.data, variables) : ``

      const result = await client.send({
        type: `append`,
        path,
        data: op.binaryData ?? data,
        binary: !!op.binaryData,
        seq: op.seq,
        headers: op.headers,
      })

      if (verbose) {
        console.log(`  append ${path}: ${result.success ? `ok` : `failed`}`)
      }

      if (
        result.success &&
        result.type === `append` &&
        op.expect?.storeOffsetAs
      ) {
        variables.set(op.expect.storeOffsetAs, result.offset)
      }

      return { result }
    }

    case `append-batch`: {
      const path = resolveVariables(op.path, variables)
      // For batch, we send multiple append commands concurrently
      const promises = op.items.map((item) =>
        client.send({
          type: `append`,
          path,
          data: item.binaryData ?? item.data ?? ``,
          binary: !!item.binaryData,
          seq: item.seq,
          headers: op.headers,
        })
      )

      const results = await Promise.all(promises)

      if (verbose) {
        const succeeded = results.filter((r) => r.success).length
        console.log(
          `  append-batch ${path}: ${succeeded}/${results.length} succeeded`
        )
      }

      // Return composite result
      const allSucceeded = results.every((r) => r.success)
      return {
        result: {
          type: `append`,
          success: allSucceeded,
          status: allSucceeded ? 200 : 207, // Multi-status
        } as TestResult,
      }
    }

    case `read`: {
      const path = resolveVariables(op.path, variables)
      const offset = op.offset
        ? resolveVariables(op.offset, variables)
        : undefined

      const result = await client.send({
        type: `read`,
        path,
        offset,
        live: op.live,
        timeoutMs: op.timeoutMs,
        maxChunks: op.maxChunks,
        waitForUpToDate: op.waitForUpToDate,
        headers: op.headers,
      })

      if (verbose) {
        console.log(`  read ${path}: ${result.success ? `ok` : `failed`}`)
      }

      if (result.success && result.type === `read`) {
        if (op.expect?.storeOffsetAs) {
          variables.set(op.expect.storeOffsetAs, result.offset)
        }
        if (op.expect?.storeDataAs) {
          const data = result.chunks.map((c) => c.data).join(``)
          variables.set(op.expect.storeDataAs, data)
        }
      }

      return { result }
    }

    case `head`: {
      const path = resolveVariables(op.path, variables)

      const result = await client.send({
        type: `head`,
        path,
        headers: op.headers,
      })

      if (verbose) {
        console.log(`  head ${path}: ${result.success ? `ok` : `failed`}`)
      }

      if (result.success && op.expect?.storeAs) {
        variables.set(op.expect.storeAs, result)
      }

      return { result }
    }

    case `delete`: {
      const path = resolveVariables(op.path, variables)

      const result = await client.send({
        type: `delete`,
        path,
        headers: op.headers,
      })

      if (verbose) {
        console.log(`  delete ${path}: ${result.success ? `ok` : `failed`}`)
      }

      return { result }
    }

    case `wait`: {
      await new Promise((resolve) => setTimeout(resolve, op.ms))
      return {}
    }

    case `set`: {
      const value = resolveVariables(op.value, variables)
      variables.set(op.name, value)
      return {}
    }

    case `assert`: {
      const condition = resolveVariables(op.condition, variables)
      // Simple evaluation - in production would need safer evaluation
      try {
        const result = eval(condition)
        if (!result) {
          return { error: op.message ?? `Assertion failed: ${op.condition}` }
        }
      } catch (err) {
        return { error: `Assertion error: ${err}` }
      }
      return {}
    }

    default:
      return { error: `Unknown operation: ${(op as TestOperation).action}` }
  }
}

function isReadResult(result: TestResult): result is ReadResult {
  return result.type === `read` && result.success
}

function isHeadResult(result: TestResult): result is HeadResult {
  return result.type === `head` && result.success
}

function isErrorResult(result: TestResult): result is ErrorResult {
  return result.type === `error` && !result.success
}

function validateExpectation(
  result: TestResult,
  expect: Record<string, unknown> | undefined
): string | null {
  if (!expect) return null

  // Check status
  if (expect.status !== undefined && `status` in result) {
    if (result.status !== expect.status) {
      return `Expected status ${expect.status}, got ${result.status}`
    }
  }

  // Check error code
  if (expect.errorCode !== undefined) {
    if (result.success) {
      return `Expected error ${expect.errorCode}, but operation succeeded`
    }
    if (isErrorResult(result) && result.errorCode !== expect.errorCode) {
      return `Expected error code ${expect.errorCode}, got ${result.errorCode}`
    }
  }

  // Check data (for read results)
  if (expect.data !== undefined && isReadResult(result)) {
    const actualData = result.chunks.map((c) => c.data).join(``)
    if (actualData !== expect.data) {
      return `Expected data "${expect.data}", got "${actualData}"`
    }
  }

  // Check dataContains
  if (expect.dataContains !== undefined && isReadResult(result)) {
    const actualData = result.chunks.map((c) => c.data).join(``)
    if (!actualData.includes(expect.dataContains as string)) {
      return `Expected data to contain "${expect.dataContains}", got "${actualData}"`
    }
  }

  // Check dataContainsAll
  if (expect.dataContainsAll !== undefined && isReadResult(result)) {
    const actualData = result.chunks.map((c) => c.data).join(``)
    const missing = (expect.dataContainsAll as Array<string>).filter(
      (s) => !actualData.includes(s)
    )
    if (missing.length > 0) {
      return `Expected data to contain all of [${(expect.dataContainsAll as Array<string>).join(`, `)}], missing: [${missing.join(`, `)}]`
    }
  }

  // Check upToDate
  if (expect.upToDate !== undefined && isReadResult(result)) {
    if (result.upToDate !== expect.upToDate) {
      return `Expected upToDate=${expect.upToDate}, got ${result.upToDate}`
    }
  }

  // Check chunkCount
  if (expect.chunkCount !== undefined && isReadResult(result)) {
    if (result.chunks.length !== expect.chunkCount) {
      return `Expected ${expect.chunkCount} chunks, got ${result.chunks.length}`
    }
  }

  // Check minChunks
  if (expect.minChunks !== undefined && isReadResult(result)) {
    if (result.chunks.length < (expect.minChunks as number)) {
      return `Expected at least ${expect.minChunks} chunks, got ${result.chunks.length}`
    }
  }

  // Check contentType
  if (expect.contentType !== undefined && isHeadResult(result)) {
    if (result.contentType !== expect.contentType) {
      return `Expected contentType "${expect.contentType}", got "${result.contentType}"`
    }
  }

  // Check hasOffset
  if (expect.hasOffset !== undefined && isHeadResult(result)) {
    const hasOffset = result.offset !== undefined && result.offset !== ``
    if (hasOffset !== expect.hasOffset) {
      return `Expected hasOffset=${expect.hasOffset}, got ${hasOffset}`
    }
  }

  return null
}

async function runTestCase(
  test: TestCase,
  ctx: ExecutionContext
): Promise<TestRunResult> {
  const startTime = Date.now()

  // Check if test should be skipped
  if (test.skip) {
    return {
      suite: ``,
      test: test.id,
      passed: true,
      duration: 0,
      skipped: true,
      skipReason: typeof test.skip === `string` ? test.skip : undefined,
    }
  }

  // Clear variables for this test
  ctx.variables.clear()

  try {
    // Run setup operations
    if (test.setup) {
      for (const op of test.setup) {
        const { error } = await executeOperation(op, ctx)
        if (error) {
          return {
            suite: ``,
            test: test.id,
            passed: false,
            duration: Date.now() - startTime,
            error: `Setup failed: ${error}`,
          }
        }
      }
    }

    // Run test operations
    for (const op of test.operations) {
      const { result, error } = await executeOperation(op, ctx)

      if (error) {
        return {
          suite: ``,
          test: test.id,
          passed: false,
          duration: Date.now() - startTime,
          error,
        }
      }

      // Validate expectations
      if (result && `expect` in op && op.expect) {
        const validationError = validateExpectation(
          result,
          op.expect as Record<string, unknown>
        )
        if (validationError) {
          return {
            suite: ``,
            test: test.id,
            passed: false,
            duration: Date.now() - startTime,
            error: validationError,
          }
        }
      }
    }

    // Run cleanup operations (best effort)
    if (test.cleanup) {
      for (const op of test.cleanup) {
        try {
          await executeOperation(op, ctx)
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    return {
      suite: ``,
      test: test.id,
      passed: true,
      duration: Date.now() - startTime,
    }
  } catch (err) {
    return {
      suite: ``,
      test: test.id,
      passed: false,
      duration: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// =============================================================================
// Public API
// =============================================================================

export async function runConformanceTests(
  options: RunnerOptions
): Promise<RunSummary> {
  const startTime = Date.now()
  const results: Array<TestRunResult> = []

  // Load test suites
  let suites = loadEmbeddedTestSuites()

  // Filter by category
  if (options.suites) {
    suites = suites.filter((s) => options.suites!.includes(s.category))
  }

  // Filter by tags
  if (options.tags) {
    suites = suites
      .map((suite) => ({
        ...suite,
        tests: suite.tests.filter(
          (test) =>
            test.tags?.some((t) => options.tags!.includes(t)) ||
            suite.tags?.some((t) => options.tags!.includes(t))
        ),
      }))
      .filter((suite) => suite.tests.length > 0)
  }

  const totalTests = countTests(suites)
  console.log(`\nRunning ${totalTests} client conformance tests...\n`)

  // Start reference server
  const server = new DurableStreamTestServer({ port: options.serverPort ?? 0 })
  await server.start()
  const serverUrl = server.url

  console.log(`Reference server started at ${serverUrl}\n`)

  // Resolve client adapter path
  let adapterPath = options.clientAdapter
  let adapterArgs = options.clientArgs ?? []

  if (adapterPath === `ts` || adapterPath === `typescript`) {
    // Use built-in TypeScript adapter via tsx
    adapterPath = `npx`
    adapterArgs = [
      `tsx`,
      new URL(`./adapters/typescript-adapter.ts`, import.meta.url).pathname,
    ]
  }

  // Start client adapter
  const client = new ClientAdapter(adapterPath, adapterArgs)

  try {
    // Initialize client
    const initResult = await client.init(serverUrl)
    if (!initResult.success) {
      throw new Error(
        `Failed to initialize client adapter: ${(initResult as { message?: string }).message}`
      )
    }

    if (initResult.type === `init`) {
      console.log(
        `Client: ${initResult.clientName} v${initResult.clientVersion}`
      )
      if (initResult.features) {
        const features = Object.entries(initResult.features)
          .filter(([, v]) => v)
          .map(([k]) => k)
        console.log(`Features: ${features.join(`, `) || `none`}\n`)
      }
    }

    const ctx: ExecutionContext = {
      serverUrl,
      variables: new Map(),
      client,
      verbose: options.verbose ?? false,
    }

    // Run test suites
    for (const suite of suites) {
      console.log(`\n${suite.name}`)
      console.log(`─`.repeat(suite.name.length))

      for (const test of suite.tests) {
        const result = await runTestCase(test, ctx)
        result.suite = suite.id
        results.push(result)

        const icon = result.passed ? (result.skipped ? `○` : `✓`) : `✗`
        const status = result.skipped
          ? `skipped${result.skipReason ? `: ${result.skipReason}` : ``}`
          : result.passed
            ? `${result.duration}ms`
            : result.error

        console.log(`  ${icon} ${test.name} (${status})`)

        if (options.failFast && !result.passed && !result.skipped) {
          break
        }
      }

      if (options.failFast && results.some((r) => !r.passed && !r.skipped)) {
        break
      }
    }
  } finally {
    await client.shutdown()
    await server.stop()
  }

  // Calculate summary
  const passed = results.filter((r) => r.passed && !r.skipped).length
  const failed = results.filter((r) => !r.passed).length
  const skipped = results.filter((r) => r.skipped).length

  const summary: RunSummary = {
    total: results.length,
    passed,
    failed,
    skipped,
    duration: Date.now() - startTime,
    results,
  }

  // Print summary
  console.log(`\n` + `═`.repeat(40))
  console.log(`Total: ${summary.total} tests`)
  console.log(`Passed: ${summary.passed}`)
  console.log(`Failed: ${summary.failed}`)
  console.log(`Skipped: ${summary.skipped}`)
  console.log(`Duration: ${(summary.duration / 1000).toFixed(2)}s`)
  console.log(`═`.repeat(40) + `\n`)

  if (failed > 0) {
    console.log(`Failed tests:`)
    for (const result of results.filter((r) => !r.passed)) {
      console.log(`  - ${result.suite}/${result.test}: ${result.error}`)
    }
    console.log()
  }

  return summary
}

export { loadEmbeddedTestSuites, filterByCategory, countTests }
