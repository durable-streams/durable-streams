/**
 * Test case types for client conformance testing.
 *
 * Test cases are defined in YAML files and describe operations to perform
 * and expectations to verify.
 */

// =============================================================================
// Test Case Structure
// =============================================================================

/**
 * A suite of related test cases.
 */
// =============================================================================
// Test Case Loader
// =============================================================================

import * as fs from "node:fs"
import * as path from "node:path"
import YAML from "yaml"

export interface TestSuite {
  /** Unique identifier for this suite */
  id: string
  /** Human-readable name */
  name: string
  /** Description of what this suite tests */
  description: string
  /** Category: producer, consumer, or lifecycle */
  category: `producer` | `consumer` | `lifecycle`
  /** Tags for filtering tests */
  tags?: Array<string>
  /** Required client features for all tests in this suite */
  requires?: Array<ClientFeature>
  /** Test cases in this suite */
  tests: Array<TestCase>
}

/**
 * A single test case with operations and expectations.
 */
export interface TestCase {
  /** Unique identifier within the suite */
  id: string
  /** Human-readable name */
  name: string
  /** Description of what this test verifies */
  description?: string
  /** Tags for filtering */
  tags?: Array<string>
  /** Skip this test (with optional reason) */
  skip?: boolean | string
  /** Required client features for this test */
  requires?: Array<ClientFeature>
  /** Setup operations to run before the test */
  setup?: Array<TestOperation>
  /** Test operations to execute */
  operations: Array<TestOperation>
  /** Cleanup operations to run after the test */
  cleanup?: Array<TestOperation>
}

/**
 * Client features that may be required for certain tests.
 */
export type ClientFeature =
  | `batching`
  | `sse`
  | `long-poll`
  | `streaming`
  | `dynamicHeaders`

// =============================================================================
// Test Operations
// =============================================================================

/**
 * Create a stream.
 */
export interface CreateOperation {
  action: `create`
  /** Stream path (a unique path will be generated if not specified) */
  path?: string
  /** Variable name to store the generated path */
  as?: string
  /** Content type */
  contentType?: string
  /** TTL in seconds */
  ttlSeconds?: number
  /** Absolute expiry (ISO 8601) */
  expiresAt?: string
  /** Custom headers */
  headers?: Record<string, string>
  /** Expected result */
  expect?: CreateExpectation
}

/**
 * Connect to an existing stream.
 */
export interface ConnectOperation {
  action: `connect`
  /** Stream path or variable reference like ${streamPath} */
  path: string
  headers?: Record<string, string>
  expect?: ConnectExpectation
}

/**
 * Append data to a stream.
 */
export interface AppendOperation {
  action: `append`
  /** Stream path or variable reference */
  path: string
  /** Data to append (string) */
  data?: string
  /** Binary data (base64 encoded) */
  binaryData?: string
  /** Sequence number for ordering */
  seq?: number
  headers?: Record<string, string>
  expect?: AppendExpectation
}

/**
 * Append multiple items (tests batching behavior).
 */
export interface AppendBatchOperation {
  action: `append-batch`
  path: string
  /** Items to append concurrently */
  items: Array<{
    data?: string
    binaryData?: string
    seq?: number
  }>
  headers?: Record<string, string>
  expect?: AppendBatchExpectation
}

/**
 * Read from a stream.
 */
export interface ReadOperation {
  action: `read`
  path: string
  /** Starting offset or variable reference like ${lastOffset} */
  offset?: string
  /** Live mode */
  live?: false | `long-poll` | `sse`
  /** Timeout for long-poll in ms */
  timeoutMs?: number
  /** Maximum chunks to read */
  maxChunks?: number
  /** Wait until up-to-date */
  waitForUpToDate?: boolean
  headers?: Record<string, string>
  expect?: ReadExpectation
  /** Run in background (don't wait for completion) */
  background?: boolean
  /** Store reference for later await (required if background: true) */
  as?: string
}

/**
 * Get stream metadata.
 */
export interface HeadOperation {
  action: `head`
  path: string
  headers?: Record<string, string>
  expect?: HeadExpectation
}

/**
 * Delete a stream.
 */
export interface DeleteOperation {
  action: `delete`
  path: string
  headers?: Record<string, string>
  expect?: DeleteExpectation
}

/**
 * Wait for a duration (for timing-sensitive tests).
 */
export interface WaitOperation {
  action: `wait`
  /** Duration in milliseconds */
  ms: number
}

/**
 * Store a value in a variable for later use.
 */
export interface SetOperation {
  action: `set`
  /** Variable name */
  name: string
  /** Value (can reference other variables) */
  value: string
}

/**
 * Assert a condition using structured assertions (no eval).
 */
export interface AssertOperation {
  action: `assert`
  /** Check that two values are equal */
  equals?: { left: string; right: string }
  /** Check that two values are not equal */
  notEquals?: { left: string; right: string }
  /** Check that a string contains a substring */
  contains?: { value: string; substring: string }
  /** Check that a value matches a regex pattern */
  matches?: { value: string; pattern: string }
  /** Message if assertion fails */
  message?: string
}

/**
 * Append to stream via direct server HTTP (bypasses client adapter).
 * Used for concurrent operations when adapter is blocked on a read.
 */
export interface ServerAppendOperation {
  action: `server-append`
  path: string
  data: string
  headers?: Record<string, string>
}

/**
 * Wait for a background operation to complete.
 */
export interface AwaitOperation {
  action: `await`
  /** Reference to the background operation (from 'as' field) */
  ref: string
  expect?: ReadExpectation
}

/**
 * Inject an error to be returned on the next N requests to a path.
 * Used for testing retry/resilience behavior.
 */
export interface InjectErrorOperation {
  action: `inject-error`
  /** Stream path to inject error for */
  path: string
  /** HTTP status code to return */
  status: number
  /** Number of times to return this error (default: 1) */
  count?: number
  /** Optional Retry-After header value (seconds) */
  retryAfter?: number
}

/**
 * Clear all injected errors.
 */
export interface ClearErrorsOperation {
  action: `clear-errors`
}

/**
 * Set a dynamic header that is evaluated per-request.
 * Useful for testing token refresh scenarios.
 */
export interface SetDynamicHeaderOperation {
  action: `set-dynamic-header`
  /** Header name */
  name: string
  /** Type of dynamic value */
  valueType: `counter` | `timestamp` | `token`
  /** Initial value (for token type) */
  initialValue?: string
}

/**
 * Set a dynamic URL parameter that is evaluated per-request.
 */
export interface SetDynamicParamOperation {
  action: `set-dynamic-param`
  /** Param name */
  name: string
  /** Type of dynamic value */
  valueType: `counter` | `timestamp`
}

/**
 * Clear all dynamic headers and params.
 */
export interface ClearDynamicOperation {
  action: `clear-dynamic`
}

/**
 * All possible test operations.
 */
export type TestOperation =
  | CreateOperation
  | ConnectOperation
  | AppendOperation
  | AppendBatchOperation
  | ReadOperation
  | HeadOperation
  | DeleteOperation
  | WaitOperation
  | SetOperation
  | AssertOperation
  | ServerAppendOperation
  | AwaitOperation
  | InjectErrorOperation
  | ClearErrorsOperation
  | SetDynamicHeaderOperation
  | SetDynamicParamOperation
  | ClearDynamicOperation

// =============================================================================
// Expectations
// =============================================================================

/**
 * Base expectation fields.
 */
interface BaseExpectation {
  /** Expected HTTP status code */
  status?: number
  /** Expected error code (if operation should fail) */
  errorCode?: string
  /** Store result in variable */
  storeAs?: string
}

export interface CreateExpectation extends BaseExpectation {
  /** Status should be 201 for new, 200 for existing */
  status?: 200 | 201 | 409 | number
}

export interface ConnectExpectation extends BaseExpectation {
  status?: 200 | 404 | number
}

export interface AppendExpectation extends BaseExpectation {
  status?: 200 | 404 | 409 | number
  /** Store the returned offset */
  storeOffsetAs?: string
  /** Expected headers that were sent (for dynamic header testing) */
  headersSent?: Record<string, string>
  /** Expected params that were sent (for dynamic param testing) */
  paramsSent?: Record<string, string>
}

export interface AppendBatchExpectation extends BaseExpectation {
  /** All items should succeed */
  allSucceed?: boolean
  /** Specific items should succeed (by index) */
  succeedIndices?: Array<number>
  /** Specific items should fail (by index) */
  failIndices?: Array<number>
}

export interface ReadExpectation extends BaseExpectation {
  status?: 200 | 204 | 404 | number
  /** Expected data content (exact match) */
  data?: string
  /** Expected data to contain (substring) */
  dataContains?: string
  /** Expected data to contain all of these substrings */
  dataContainsAll?: Array<string>
  /** Expected number of chunks */
  chunkCount?: number
  /** Minimum number of chunks */
  minChunks?: number
  /** Maximum number of chunks */
  maxChunks?: number
  /** Should be up-to-date after read */
  upToDate?: boolean
  /** Store final offset */
  storeOffsetAs?: string
  /** Store all data concatenated */
  storeDataAs?: string
  /** Expected headers that were sent (for dynamic header testing) */
  headersSent?: Record<string, string>
  /** Expected params that were sent (for dynamic param testing) */
  paramsSent?: Record<string, string>
}

export interface HeadExpectation extends BaseExpectation {
  status?: 200 | 404 | number
  /** Expected content type */
  contentType?: string
  /** Should have an offset */
  hasOffset?: boolean
}

export interface DeleteExpectation extends BaseExpectation {
  status?: 200 | 204 | 404 | number
}

/**
 * Load all test suites from a directory.
 */
export function loadTestSuites(dir: string): Array<TestSuite> {
  const suites: Array<TestSuite> = []

  function walkDir(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        walkDir(fullPath)
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(`.yaml`) || entry.name.endsWith(`.yml`))
      ) {
        const content = fs.readFileSync(fullPath, `utf-8`)
        const suite = YAML.parse(content) as TestSuite
        suites.push(suite)
      }
    }
  }

  walkDir(dir)
  return suites
}

/**
 * Load test suites from the embedded test-cases directory.
 */
export function loadEmbeddedTestSuites(): Array<TestSuite> {
  const testCasesDir = path.join(import.meta.dirname, `..`, `test-cases`)
  return loadTestSuites(testCasesDir)
}

/**
 * Filter test suites by category.
 */
export function filterByCategory(
  suites: Array<TestSuite>,
  category: TestSuite[`category`]
): Array<TestSuite> {
  return suites.filter((s) => s.category === category)
}

/**
 * Filter test cases by tags.
 */
export function filterByTags(
  suites: Array<TestSuite>,
  tags: Array<string>
): Array<TestSuite> {
  return suites
    .map((suite) => ({
      ...suite,
      tests: suite.tests.filter(
        (test) =>
          test.tags?.some((t) => tags.includes(t)) ||
          suite.tags?.some((t) => tags.includes(t))
      ),
    }))
    .filter((suite) => suite.tests.length > 0)
}

/**
 * Get total test count.
 */
export function countTests(suites: Array<TestSuite>): number {
  return suites.reduce((sum, suite) => sum + suite.tests.length, 0)
}
