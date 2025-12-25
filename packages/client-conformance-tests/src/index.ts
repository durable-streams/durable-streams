/**
 * Client Conformance Test Suite for Durable Streams
 *
 * This package provides a comprehensive test suite to verify that a client
 * correctly implements the Durable Streams protocol for both producers and consumers,
 * along with performance benchmarking capabilities.
 *
 * @packageDocumentation
 */

// Conformance testing
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

// Benchmarking
export {
  runBenchmarks,
  allScenarios,
  getScenarioById,
  type BenchmarkRunnerOptions,
  type ScenarioResult,
  type BenchmarkSummary,
} from "./benchmark-runner.js"

export {
  type BenchmarkScenario,
  type BenchmarkScenarioConfig,
  type BenchmarkCriteria,
  type ScenarioContext,
  getScenariosByCategory,
  scenariosByCategory,
} from "./benchmark-scenarios.js"

// Re-export protocol types for adapter implementers
export * from "./protocol.js"
