/**
 * Golden/wire transcript testing for Durable Streams clients.
 *
 * Client golden tests verify that client implementations generate
 * the correct wire-level HTTP requests. This complements server
 * golden tests by ensuring clients are protocol-compliant.
 *
 * Works with the existing stdin/stdout adapter protocol by adding
 * a mock server that captures and verifies requests.
 */

import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

// =============================================================================
// Types
// =============================================================================

/**
 * Expected HTTP request from a client
 */
export interface ExpectedRequest {
  /** HTTP method */
  method: string
  /** Path pattern (can include wildcards like /streams/*) */
  pathPattern: string
  /** Required headers (lowercase names) */
  requiredHeaders?: Record<string, string | RegExp>
  /** Headers that must be present (value not checked) */
  presentHeaders?: Array<string>
  /** Headers that must NOT be present */
  absentHeaders?: Array<string>
  /** Expected body (for POST/PUT) */
  body?: string | RegExp
  /** Expected content-type */
  contentType?: string | RegExp
}

/**
 * Mock response to send back to the client
 */
export interface MockResponse {
  status: number
  headers?: Record<string, string>
  body?: string
}

/**
 * A golden test case for client request verification
 */
export interface ClientGoldenTest {
  id: string
  description: string
  /** The command to send to the client adapter */
  command: unknown
  /** Expected request from the client */
  expectedRequest: ExpectedRequest
  /** Mock response to return */
  mockResponse: MockResponse
  /** Expected result from the adapter */
  expectedResult?: {
    success: boolean
    status?: number
  }
}

/**
 * Captured request from the client
 */
export interface CapturedClientRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

/**
 * Result of verifying a client request
 */
export interface ClientVerifyResult {
  passed: boolean
  testId: string
  differences: Array<{
    type: string
    expected: string
    actual: string
  }>
  capturedRequest?: CapturedClientRequest
}

// =============================================================================
// Mock Server
// =============================================================================

/**
 * A mock server that captures requests and returns configured responses.
 * Used to verify client request generation matches expected wire format.
 */
export class MockServer {
  private server: ReturnType<typeof createServer> | null = null
  private capturedRequests: Array<CapturedClientRequest> = []
  private responseQueue: Array<MockResponse> = []
  private port = 0

  /**
   * Start the mock server on a random available port.
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res))

      this.server.on(`error`, reject)

      this.server.listen(0, `127.0.0.1`, () => {
        const addr = this.server!.address() as AddressInfo
        this.port = addr.port
        resolve(this.port)
      })
    })
  }

  /**
   * Stop the mock server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  /**
   * Get the base URL of the mock server.
   */
  getUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /**
   * Queue a response to be returned for the next request.
   */
  queueResponse(response: MockResponse): void {
    this.responseQueue.push(response)
  }

  /**
   * Get all captured requests.
   */
  getCapturedRequests(): Array<CapturedClientRequest> {
    return [...this.capturedRequests]
  }

  /**
   * Get the last captured request.
   */
  getLastRequest(): CapturedClientRequest | undefined {
    return this.capturedRequests[this.capturedRequests.length - 1]
  }

  /**
   * Clear captured requests and response queue.
   */
  reset(): void {
    this.capturedRequests = []
    this.responseQueue = []
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Collect body
    const chunks: Array<Buffer> = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks).toString(`utf8`)

    // Capture the request
    const headers: Record<string, string> = {}
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!.toLowerCase()
      const value = req.rawHeaders[i + 1]!
      headers[name] = value
    }

    this.capturedRequests.push({
      method: req.method || `GET`,
      path: req.url || `/`,
      headers,
      body,
    })

    // Send queued response or default
    const mockResponse = this.responseQueue.shift() || {
      status: 200,
      headers: { "content-type": `text/plain` },
      body: `OK`,
    }

    res.statusCode = mockResponse.status
    if (mockResponse.headers) {
      for (const [k, v] of Object.entries(mockResponse.headers)) {
        res.setHeader(k, v)
      }
    }
    res.end(mockResponse.body || ``)
  }
}

// =============================================================================
// Verification
// =============================================================================

/**
 * Verify a captured request against expected values.
 */
export function verifyRequest(
  captured: CapturedClientRequest,
  expected: ExpectedRequest,
  testId: string
): ClientVerifyResult {
  const differences: Array<{ type: string; expected: string; actual: string }> =
    []

  // Method
  if (captured.method.toUpperCase() !== expected.method.toUpperCase()) {
    differences.push({
      type: `method`,
      expected: expected.method,
      actual: captured.method,
    })
  }

  // Path (support wildcards)
  if (!matchPath(captured.path, expected.pathPattern)) {
    differences.push({
      type: `path`,
      expected: expected.pathPattern,
      actual: captured.path,
    })
  }

  // Required headers
  if (expected.requiredHeaders) {
    for (const [name, expectedValue] of Object.entries(
      expected.requiredHeaders
    )) {
      const actualValue = captured.headers[name.toLowerCase()]
      if (actualValue === undefined) {
        differences.push({
          type: `header-missing`,
          expected: `${name}: ${expectedValue}`,
          actual: `(missing)`,
        })
      } else if (expectedValue instanceof RegExp) {
        if (!expectedValue.test(actualValue)) {
          differences.push({
            type: `header`,
            expected: `${name}: ${expectedValue}`,
            actual: `${name}: ${actualValue}`,
          })
        }
      } else if (actualValue !== expectedValue) {
        differences.push({
          type: `header`,
          expected: `${name}: ${expectedValue}`,
          actual: `${name}: ${actualValue}`,
        })
      }
    }
  }

  // Headers that must be present
  if (expected.presentHeaders) {
    for (const name of expected.presentHeaders) {
      if (captured.headers[name.toLowerCase()] === undefined) {
        differences.push({
          type: `header-missing`,
          expected: `${name}: (any value)`,
          actual: `(missing)`,
        })
      }
    }
  }

  // Headers that must NOT be present
  if (expected.absentHeaders) {
    for (const name of expected.absentHeaders) {
      const actualValue = captured.headers[name.toLowerCase()]
      if (actualValue !== undefined) {
        differences.push({
          type: `header-unexpected`,
          expected: `${name}: (not present)`,
          actual: `${name}: ${actualValue}`,
        })
      }
    }
  }

  // Content-Type
  if (expected.contentType) {
    const actualCT = captured.headers[`content-type`] || ``
    if (expected.contentType instanceof RegExp) {
      if (!expected.contentType.test(actualCT)) {
        differences.push({
          type: `content-type`,
          expected: String(expected.contentType),
          actual: actualCT,
        })
      }
    } else if (!actualCT.includes(expected.contentType)) {
      differences.push({
        type: `content-type`,
        expected: expected.contentType,
        actual: actualCT,
      })
    }
  }

  // Body
  if (expected.body !== undefined) {
    if (expected.body instanceof RegExp) {
      if (!expected.body.test(captured.body)) {
        differences.push({
          type: `body`,
          expected: String(expected.body),
          actual: captured.body.slice(0, 100),
        })
      }
    } else if (captured.body !== expected.body) {
      differences.push({
        type: `body`,
        expected: expected.body.slice(0, 100),
        actual: captured.body.slice(0, 100),
      })
    }
  }

  return {
    passed: differences.length === 0,
    testId,
    differences,
    capturedRequest: captured,
  }
}

/**
 * Match a path against a pattern with wildcard support.
 * Wildcards: * matches any single segment, ** matches any path suffix
 */
function matchPath(path: string, pattern: string): boolean {
  // Remove query string for matching
  const pathOnly = path.split(`?`)[0]!

  // Simple wildcard matching
  const regexPattern = pattern
    .replace(/\*\*/g, `__DOUBLE_STAR__`)
    .replace(/\*/g, `[^/]+`)
    .replace(/__DOUBLE_STAR__/g, `.*`)

  const regex = new RegExp(`^${regexPattern}$`)
  return regex.test(pathOnly)
}

/**
 * Format a client verify result for display.
 */
export function formatClientResult(result: ClientVerifyResult): string {
  const lines: Array<string> = []

  if (result.passed) {
    lines.push(`PASS: ${result.testId}`)
  } else {
    lines.push(`FAIL: ${result.testId}`)
    for (const diff of result.differences) {
      lines.push(`  ${diff.type}:`)
      lines.push(`    expected: ${diff.expected}`)
      lines.push(`    actual:   ${diff.actual}`)
    }
  }

  return lines.join(`\n`)
}

// =============================================================================
// Test Runner Integration
// =============================================================================

/**
 * Run a golden client test using the mock server and adapter.
 *
 * @param adapter Function to send command to adapter and get result
 * @param test The golden test case to run
 * @param mockServer The mock server instance
 */
export async function runClientGoldenTest(
  adapter: (command: unknown) => Promise<unknown>,
  test: ClientGoldenTest,
  mockServer: MockServer
): Promise<ClientVerifyResult> {
  // Queue the mock response
  mockServer.queueResponse(test.mockResponse)

  // Send the command to the adapter
  await adapter(test.command)

  // Get the captured request
  const captured = mockServer.getLastRequest()
  if (!captured) {
    return {
      passed: false,
      testId: test.id,
      differences: [
        {
          type: `no-request`,
          expected: `HTTP request`,
          actual: `(no request received)`,
        },
      ],
    }
  }

  // Verify the request
  return verifyRequest(captured, test.expectedRequest, test.id)
}
