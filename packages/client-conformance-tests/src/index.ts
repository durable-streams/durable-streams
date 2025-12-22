/**
 * Client Conformance Test Suite for Durable Streams
 *
 * This package provides a comprehensive test suite to verify that a client
 * correctly implements the Durable Streams protocol for both producers and consumers.
 *
 * @packageDocumentation
 */

export {
  runConformanceTests,
  loadEmbeddedTestSuites,
  filterByCategory,
  countTests,
  type RunnerOptions,
  type TestRunResult,
  type RunSummary,
} from "./runner.js"

export {
  type TestSuite,
  type TestCase,
  type TestOperation,
  type ClientFeature,
  loadTestSuites,
} from "./test-cases.js"

// Re-export protocol types for adapter implementers
export * from "./protocol.js"
