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
  AppendResult,
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

/** Client feature flags reported by the adapter */
interface ClientFeatures {
  batching?: boolean
  sse?: boolean
  longPoll?: boolean
  auto?: boolean
  streaming?: boolean
  dynamicHeaders?: boolean
  retryOptions?: boolean
  batchItems?: boolean
  strictZeroValidation?: boolean
}

interface ExecutionContext {
  serverUrl: string
  variables: Map<string, unknown>
  client: ClientAdapter
  verbose: boolean
  /** Features supported by the client adapter */
  clientFeatures: ClientFeatures
  /** Background operations pending completion */
  backgroundOps: Map<string, Promise<TestResult>>
  /** Timeout for adapter commands in ms */
  commandTimeout: number
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
  return value.replace(/\$\{([^}]+)\}/g, (match, expr) => {
    // Handle special built-in variables
    if (expr === `randomUUID`) {
      return randomUUID()
    }

    // Handle property access like ${result.offset}
    const parts = expr.split(`.`)
    let current: unknown = variables.get(parts[0])

    // Throw on missing variables to catch typos and configuration errors
    if (current === undefined) {
      throw new Error(`Undefined variable: ${parts[0]} (in ${match})`)
    }

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
  const { client, variables, verbose, commandTimeout } = ctx

  switch (op.action) {
    case `create`: {
      const path = op.path
        ? resolveVariables(op.path, variables)
        : generateStreamPath()

      if (op.as) {
        variables.set(op.as, path)
      }

      const result = await client.send(
        {
          type: `create`,
          path,
          contentType: op.contentType,
          ttlSeconds: op.ttlSeconds,
          expiresAt: op.expiresAt,
          headers: op.headers,
        },
        commandTimeout
      )

      if (verbose) {
        console.log(`  create ${path}: ${result.success ? `ok` : `failed`}`)
      }

      return { result }
    }

    case `connect`: {
      const path = resolveVariables(op.path, variables)
      const result = await client.send(
        {
          type: `connect`,
          path,
          headers: op.headers,
        },
        commandTimeout
      )

      if (verbose) {
        console.log(`  connect ${path}: ${result.success ? `ok` : `failed`}`)
      }

      return { result }
    }

    case `append`: {
      const path = resolveVariables(op.path, variables)
      const data = op.data ? resolveVariables(op.data, variables) : ``

      const result = await client.send(
        {
          type: `append`,
          path,
          data: op.binaryData ?? data,
          binary: !!op.binaryData,
          seq: op.seq,
          headers: op.headers,
        },
        commandTimeout
      )

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
      // Send appends sequentially (adapter processes one command at a time)
      const results: Array<TestResult> = []
      for (const item of op.items) {
        const result = await client.send(
          {
            type: `append`,
            path,
            data: item.binaryData ?? item.data ?? ``,
            binary: !!item.binaryData,
            seq: item.seq,
            headers: op.headers,
          },
          commandTimeout
        )
        results.push(result)
      }

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

    case `idempotent-append`: {
      const path = resolveVariables(op.path, variables)
      const data = resolveVariables(op.data, variables)

      const result = await client.send(
        {
          type: `idempotent-append`,
          path,
          data,
          producerId: op.producerId,
          epoch: op.epoch ?? 0,
          autoClaim: op.autoClaim ?? false,
          headers: op.headers,
        },
        commandTimeout
      )

      if (verbose) {
        console.log(
          `  idempotent-append ${path}: ${result.success ? `ok` : `failed`}`
        )
      }

      if (
        result.success &&
        result.type === `idempotent-append` &&
        op.expect?.storeOffsetAs
      ) {
        variables.set(op.expect.storeOffsetAs, result.offset ?? ``)
      }

      return { result }
    }

    case `idempotent-append-batch`: {
      const path = resolveVariables(op.path, variables)

      // Send items to client which will batch them internally
      const items = op.items.map((item) =>
        resolveVariables(item.data, variables)
      )

      const result = await client.send(
        {
          type: `idempotent-append-batch`,
          path,
          items,
          producerId: op.producerId,
          epoch: op.epoch ?? 0,
          autoClaim: op.autoClaim ?? false,
          maxInFlight: op.maxInFlight,
          headers: op.headers,
        },
        commandTimeout
      )

      if (verbose) {
        console.log(
          `  idempotent-append-batch ${path}: ${result.success ? `ok` : `failed`}`
        )
      }

      return { result }
    }

    case `read`: {
      const path = resolveVariables(op.path, variables)
      const offset = op.offset
        ? resolveVariables(op.offset, variables)
        : undefined

      // For background operations, send command but don't wait
      if (op.background && op.as) {
        const resultPromise = client.send(
          {
            type: `read`,
            path,
            offset,
            live: op.live,
            timeoutMs: op.timeoutMs,
            maxChunks: op.maxChunks,
            waitForUpToDate: op.waitForUpToDate,
            headers: op.headers,
          },
          commandTimeout
        )

        // Store the promise for later await
        ctx.backgroundOps.set(op.as, resultPromise)

        if (verbose) {
          console.log(`  read ${path}: started in background as ${op.as}`)
        }

        return {} // No result yet - will be retrieved via await
      }

      const result = await client.send(
        {
          type: `read`,
          path,
          offset,
          live: op.live,
          timeoutMs: op.timeoutMs,
          maxChunks: op.maxChunks,
          waitForUpToDate: op.waitForUpToDate,
          headers: op.headers,
        },
        commandTimeout
      )

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

      const result = await client.send(
        {
          type: `head`,
          path,
          headers: op.headers,
        },
        commandTimeout
      )

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

      const result = await client.send(
        {
          type: `delete`,
          path,
          headers: op.headers,
        },
        commandTimeout
      )

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
      // Structured assertions - no eval for safety
      if (op.equals) {
        const left = resolveVariables(op.equals.left, variables)
        const right = resolveVariables(op.equals.right, variables)
        if (left !== right) {
          return {
            error:
              op.message ??
              `Assertion failed: expected "${left}" to equal "${right}"`,
          }
        }
      }
      if (op.notEquals) {
        const left = resolveVariables(op.notEquals.left, variables)
        const right = resolveVariables(op.notEquals.right, variables)
        if (left === right) {
          return {
            error:
              op.message ??
              `Assertion failed: expected "${left}" to not equal "${right}"`,
          }
        }
      }
      if (op.contains) {
        const value = resolveVariables(op.contains.value, variables)
        const substring = resolveVariables(op.contains.substring, variables)
        if (!value.includes(substring)) {
          return {
            error:
              op.message ??
              `Assertion failed: expected "${value}" to contain "${substring}"`,
          }
        }
      }
      if (op.matches) {
        const value = resolveVariables(op.matches.value, variables)
        const pattern = op.matches.pattern
        try {
          const regex = new RegExp(pattern)
          if (!regex.test(value)) {
            return {
              error:
                op.message ??
                `Assertion failed: expected "${value}" to match /${pattern}/`,
            }
          }
        } catch {
          return { error: `Invalid regex pattern: ${pattern}` }
        }
      }
      return {}
    }

    case `server-append`: {
      // Direct HTTP append to server, bypassing client adapter
      // Used for concurrent operations when adapter is blocked on a read,
      // and for testing protocol-level behavior like idempotent producers
      const path = resolveVariables(op.path, variables)
      const data = resolveVariables(op.data, variables)

      try {
        // First, get the stream's content-type via HEAD
        const headResponse = await fetch(`${ctx.serverUrl}${path}`, {
          method: `HEAD`,
        })
        const contentType =
          headResponse.headers.get(`content-type`) ?? `application/octet-stream`

        // Build headers, including producer headers if present
        const headers: Record<string, string> = {
          "content-type": contentType,
          ...op.headers,
        }
        if (op.producerId !== undefined) {
          headers[`Producer-Id`] = op.producerId
        }
        if (op.producerEpoch !== undefined) {
          headers[`Producer-Epoch`] = op.producerEpoch.toString()
        }
        if (op.producerSeq !== undefined) {
          headers[`Producer-Seq`] = op.producerSeq.toString()
        }

        const response = await fetch(`${ctx.serverUrl}${path}`, {
          method: `POST`,
          body: data,
          headers,
        })

        const status = response.status
        const offset = response.headers.get(`Stream-Next-Offset`) ?? undefined
        const duplicate = status === 204
        const producerEpoch = response.headers.get(`Producer-Epoch`)
        const producerSeq = response.headers.get(`Producer-Seq`)
        const producerExpectedSeq = response.headers.get(
          `Producer-Expected-Seq`
        )
        const producerReceivedSeq = response.headers.get(
          `Producer-Received-Seq`
        )

        if (verbose) {
          console.log(
            `  server-append ${path}: status=${status}${duplicate ? ` (duplicate)` : ``}`
          )
        }

        // Build result for expectation verification
        // success: true means we got a valid protocol response (even 403/409)
        // The status field indicates the actual operation result
        const result: TestResult = {
          type: `append`,
          success: true,
          status,
          offset,
          duplicate,
          producerEpoch: producerEpoch
            ? parseInt(producerEpoch, 10)
            : undefined,
          producerSeq: producerSeq ? parseInt(producerSeq, 10) : undefined,
          producerExpectedSeq: producerExpectedSeq
            ? parseInt(producerExpectedSeq, 10)
            : undefined,
          producerReceivedSeq: producerReceivedSeq
            ? parseInt(producerReceivedSeq, 10)
            : undefined,
        }

        // Store offset if requested
        if (op.expect?.storeOffsetAs && offset) {
          variables.set(op.expect.storeOffsetAs, offset)
        }

        return { result }
      } catch (err) {
        return {
          error: `Server append failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    case `await`: {
      // Wait for a background operation to complete
      const ref = op.ref
      const promise = ctx.backgroundOps.get(ref)

      if (!promise) {
        return { error: `No background operation found with ref: ${ref}` }
      }

      const result = await promise
      ctx.backgroundOps.delete(ref) // Clean up

      if (verbose) {
        console.log(`  await ${ref}: ${result.success ? `ok` : `failed`}`)
      }

      return { result }
    }

    case `inject-error`: {
      // Inject a fault via the test server's control endpoint
      const path = resolveVariables(op.path, variables)

      try {
        const response = await fetch(`${ctx.serverUrl}/_test/inject-error`, {
          method: `POST`,
          headers: { "content-type": `application/json` },
          body: JSON.stringify({
            path,
            status: op.status,
            count: op.count ?? 1,
            retryAfter: op.retryAfter,
            // New fault injection parameters
            delayMs: op.delayMs,
            dropConnection: op.dropConnection,
            truncateBodyBytes: op.truncateBodyBytes,
            probability: op.probability,
            method: op.method,
            corruptBody: op.corruptBody,
            jitterMs: op.jitterMs,
          }),
        })

        // Build descriptive log message
        const faultTypes = []
        if (op.status != null) faultTypes.push(`status=${op.status}`)
        if (op.delayMs != null) faultTypes.push(`delay=${op.delayMs}ms`)
        if (op.jitterMs != null) faultTypes.push(`jitter=${op.jitterMs}ms`)
        if (op.dropConnection) faultTypes.push(`dropConnection`)
        if (op.truncateBodyBytes != null)
          faultTypes.push(`truncate=${op.truncateBodyBytes}b`)
        if (op.corruptBody) faultTypes.push(`corrupt`)
        if (op.probability != null) faultTypes.push(`p=${op.probability}`)
        const faultDesc = faultTypes.join(`,`) || `unknown`

        if (verbose) {
          console.log(
            `  inject-error ${path} [${faultDesc}]x${op.count ?? 1}: ${response.ok ? `ok` : `failed`}`
          )
        }

        if (!response.ok) {
          return { error: `Failed to inject fault: ${response.status}` }
        }

        return {}
      } catch (err) {
        return {
          error: `Failed to inject fault: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    case `clear-errors`: {
      // Clear all injected errors via the test server's control endpoint
      try {
        const response = await fetch(`${ctx.serverUrl}/_test/inject-error`, {
          method: `DELETE`,
        })

        if (verbose) {
          console.log(`  clear-errors: ${response.ok ? `ok` : `failed`}`)
        }

        return {}
      } catch (err) {
        return {
          error: `Failed to clear errors: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    case `set-dynamic-header`: {
      const result = await client.send(
        {
          type: `set-dynamic-header`,
          name: op.name,
          valueType: op.valueType,
          initialValue: op.initialValue,
        },
        commandTimeout
      )

      if (verbose) {
        console.log(
          `  set-dynamic-header ${op.name}: ${result.success ? `ok` : `failed`}`
        )
      }

      return { result }
    }

    case `set-dynamic-param`: {
      const result = await client.send(
        {
          type: `set-dynamic-param`,
          name: op.name,
          valueType: op.valueType,
        },
        commandTimeout
      )

      if (verbose) {
        console.log(
          `  set-dynamic-param ${op.name}: ${result.success ? `ok` : `failed`}`
        )
      }

      return { result }
    }

    case `clear-dynamic`: {
      const result = await client.send(
        {
          type: `clear-dynamic`,
        },
        commandTimeout
      )

      if (verbose) {
        console.log(`  clear-dynamic: ${result.success ? `ok` : `failed`}`)
      }

      return { result }
    }

    case `validate`: {
      const result = await client.send(
        {
          type: `validate`,
          target: op.target,
        },
        commandTimeout
      )

      if (verbose) {
        const targetType = op.target.target
        console.log(
          `  validate ${targetType}: ${result.success ? `ok` : `failed`}`
        )
      }

      return { result }
    }

    default:
      return { error: `Unknown operation: ${(op as TestOperation).action}` }
  }
}

function isReadResult(result: TestResult): result is ReadResult {
  return result.type === `read` && result.success
}

function isAppendResult(result: TestResult): result is AppendResult {
  return result.type === `append` && result.success
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

  // Check error message contains expected strings
  if (expect.messageContains !== undefined) {
    if (result.success) {
      return `Expected error with message containing ${JSON.stringify(expect.messageContains)}, but operation succeeded`
    }
    if (isErrorResult(result)) {
      const missing = (expect.messageContains as Array<string>).filter(
        (s) => !result.message.toLowerCase().includes(s.toLowerCase())
      )
      if (missing.length > 0) {
        return `Expected error message to contain [${(expect.messageContains as Array<string>).join(`, `)}], missing: [${missing.join(`, `)}]. Actual message: "${result.message}"`
      }
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

  // Check dataExact - verifies exact messages in order
  if (expect.dataExact !== undefined && isReadResult(result)) {
    const expectedMessages = expect.dataExact as Array<string>
    const actualMessages = result.chunks.map((c) => c.data)

    if (actualMessages.length !== expectedMessages.length) {
      return `Expected ${expectedMessages.length} messages, got ${actualMessages.length}. Expected: [${expectedMessages.join(`, `)}], got: [${actualMessages.join(`, `)}]`
    }

    for (let i = 0; i < expectedMessages.length; i++) {
      if (actualMessages[i] !== expectedMessages[i]) {
        return `Message ${i} mismatch: expected "${expectedMessages[i]}", got "${actualMessages[i]}"`
      }
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

  // Check headersSent (for append or read results with dynamic headers)
  if (expect.headersSent !== undefined) {
    const expectedHeaders = expect.headersSent as Record<string, string>
    let actualHeaders: Record<string, string> | undefined

    if (isAppendResult(result)) {
      actualHeaders = result.headersSent
    } else if (isReadResult(result)) {
      actualHeaders = result.headersSent
    }

    if (!actualHeaders) {
      return `Expected headersSent but result does not contain headersSent`
    }

    for (const [key, expectedValue] of Object.entries(expectedHeaders)) {
      const actualValue = actualHeaders[key]
      if (actualValue !== expectedValue) {
        return `Expected headersSent[${key}]="${expectedValue}", got "${actualValue ?? `undefined`}"`
      }
    }
  }

  // Check paramsSent (for append or read results with dynamic params)
  if (expect.paramsSent !== undefined) {
    const expectedParams = expect.paramsSent as Record<string, string>
    let actualParams: Record<string, string> | undefined

    if (isAppendResult(result)) {
      actualParams = result.paramsSent
    } else if (isReadResult(result)) {
      actualParams = result.paramsSent
    }

    if (!actualParams) {
      return `Expected paramsSent but result does not contain paramsSent`
    }

    for (const [key, expectedValue] of Object.entries(expectedParams)) {
      const actualValue = actualParams[key]
      if (actualValue !== expectedValue) {
        return `Expected paramsSent[${key}]="${expectedValue}", got "${actualValue ?? `undefined`}"`
      }
    }
  }

  // Check duplicate (for idempotent producer 204 responses)
  if (expect.duplicate !== undefined && isAppendResult(result)) {
    if (result.duplicate !== expect.duplicate) {
      return `Expected duplicate=${expect.duplicate}, got ${result.duplicate}`
    }
  }

  // Check producerEpoch (returned on 200/403)
  if (expect.producerEpoch !== undefined && isAppendResult(result)) {
    if (result.producerEpoch !== expect.producerEpoch) {
      return `Expected producerEpoch=${expect.producerEpoch}, got ${result.producerEpoch}`
    }
  }

  // Check producerSeq (returned on 200/204 - highest accepted sequence)
  if (expect.producerSeq !== undefined && isAppendResult(result)) {
    if (result.producerSeq !== expect.producerSeq) {
      return `Expected producerSeq=${expect.producerSeq}, got ${result.producerSeq}`
    }
  }

  // Check producerExpectedSeq (returned on 409 sequence gap)
  if (expect.producerExpectedSeq !== undefined && isAppendResult(result)) {
    if (result.producerExpectedSeq !== expect.producerExpectedSeq) {
      return `Expected producerExpectedSeq=${expect.producerExpectedSeq}, got ${result.producerExpectedSeq}`
    }
  }

  // Check producerReceivedSeq (returned on 409 sequence gap)
  if (expect.producerReceivedSeq !== undefined && isAppendResult(result)) {
    if (result.producerReceivedSeq !== expect.producerReceivedSeq) {
      return `Expected producerReceivedSeq=${expect.producerReceivedSeq}, got ${result.producerReceivedSeq}`
    }
  }

  // Check valid (for validation operations)
  if (expect.valid !== undefined) {
    if (expect.valid === true && !result.success) {
      return `Expected validation to pass, but it failed`
    }
    if (expect.valid === false && result.success) {
      return `Expected validation to fail, but it passed`
    }
  }

  // Check errorContains (for validation operations with error message substring)
  if (expect.errorContains !== undefined && isErrorResult(result)) {
    if (!result.message.includes(expect.errorContains as string)) {
      return `Expected error message to contain "${expect.errorContains}", got "${result.message}"`
    }
  }

  return null
}

/**
 * Map feature names from YAML (kebab-case) to client feature property names (camelCase).
 */
function featureToProperty(feature: string): keyof ClientFeatures | undefined {
  const map: Record<string, keyof ClientFeatures> = {
    batching: `batching`,
    sse: `sse`,
    "long-poll": `longPoll`,
    longPoll: `longPoll`,
    auto: `auto`,
    streaming: `streaming`,
    dynamicHeaders: `dynamicHeaders`,
    "dynamic-headers": `dynamicHeaders`,
    retryOptions: `retryOptions`,
    "retry-options": `retryOptions`,
    batchItems: `batchItems`,
    "batch-items": `batchItems`,
    strictZeroValidation: `strictZeroValidation`,
    "strict-zero-validation": `strictZeroValidation`,
  }
  return map[feature]
}

/**
 * Check if client supports all required features.
 * Returns list of missing features, or empty array if all satisfied.
 */
function getMissingFeatures(
  requires: Array<string> | undefined,
  clientFeatures: ClientFeatures
): Array<string> {
  if (!requires || requires.length === 0) {
    return []
  }
  return requires.filter((feature) => {
    const prop = featureToProperty(feature)
    return !prop || !clientFeatures[prop]
  })
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

  // Check if test requires features the client doesn't support
  const missingFeatures = getMissingFeatures(test.requires, ctx.clientFeatures)
  if (missingFeatures.length > 0) {
    return {
      suite: ``,
      test: test.id,
      passed: true,
      duration: 0,
      skipped: true,
      skipReason: `missing features: ${missingFeatures.join(`, `)}`,
    }
  }

  // Clear variables and background ops for this test
  ctx.variables.clear()
  ctx.backgroundOps.clear()

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

  // Start reference server with short long-poll timeout for testing
  // Tests use timeoutMs: 1000, so server timeout should be shorter
  const server = new DurableStreamTestServer({
    port: options.serverPort ?? 0,
    longPollTimeout: 500, // 500ms timeout for testing
  })
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

    // Extract client features from init result
    let clientFeatures: ClientFeatures = {}
    if (initResult.type === `init`) {
      console.log(
        `Client: ${initResult.clientName} v${initResult.clientVersion}`
      )
      if (initResult.features) {
        clientFeatures = initResult.features
        const featureList = Object.entries(initResult.features)
          .filter(([, v]) => v)
          .map(([k]) => k)
        console.log(`Features: ${featureList.join(`, `) || `none`}\n`)
      }
    }

    const ctx: ExecutionContext = {
      serverUrl,
      variables: new Map(),
      client,
      verbose: options.verbose ?? false,
      clientFeatures,
      backgroundOps: new Map(),
      commandTimeout: options.testTimeout ?? 30000,
    }

    // Run test suites
    for (const suite of suites) {
      console.log(`\n${suite.name}`)
      console.log(`─`.repeat(suite.name.length))

      // Check if suite requires features the client doesn't support
      const suiteMissingFeatures = getMissingFeatures(
        suite.requires,
        clientFeatures
      )

      for (const test of suite.tests) {
        // If suite has missing features, skip all tests in it
        if (suiteMissingFeatures.length > 0) {
          const result: TestRunResult = {
            suite: suite.id,
            test: test.id,
            passed: true,
            duration: 0,
            skipped: true,
            skipReason: `missing features: ${suiteMissingFeatures.join(`, `)}`,
          }
          results.push(result)
          console.log(
            `  ○ ${test.name} (skipped: missing features: ${suiteMissingFeatures.join(`, `)})`
          )
          continue
        }

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
