/**
 * @durable-streams/txn-spec
 *
 * Formal specification DSL for transactional storage systems.
 * Based on the CobbleDB/RocksDB formalization paper.
 *
 * This package provides:
 * - Type definitions for the formal specification
 * - Effect algebra (apply, merge, assignments, increments)
 * - Transaction semantics (begin, update, read, commit, abort)
 * - Trace representation (DAG of transaction nodes)
 * - Store implementations (map, journal, WAL-memtable)
 * - Test scenario DSL for expressing test cases
 * - Test generator for vitest conformance tests
 *
 * @example
 * ```typescript
 * import {
 *   scenario,
 *   assign,
 *   increment,
 *   executeScenario,
 *   createMapStore,
 * } from '@durable-streams/txn-spec'
 *
 * // Define a test scenario
 * const myScenario = scenario("concurrent writes merge correctly")
 *   .transaction("t1", { st: 0 })
 *     .update("counter", assign(0))
 *     .commit({ ct: 5 })
 *   .transaction("t2", { st: 10 })
 *     .update("counter", increment(5))
 *     .commit({ ct: 15 })
 *   .transaction("t3", { st: 20 })
 *     .readExpect("counter", 5)
 *     .commit({ ct: 25 })
 *   .build()
 *
 * // Run against a store
 * const store = createMapStore()
 * const result = executeScenario(myScenario, store)
 * console.log(result.success) // true
 * ```
 */

// =============================================================================
// Core Types
// =============================================================================

export {
  // Primitives
  type Key,
  type Value,
  type Timestamp,
  type TxnId,
  type Bottom,
  BOTTOM,
  isBottom,

  // Effects
  type EffectType,
  type BaseEffect,
  type AssignEffect,
  type IncrementEffect,
  type DeleteEffect,
  type CustomEffect,
  type Effect,
  type EffectOrBottom,

  // Buffers
  type ReadBuffer,
  type EffectBuffer,
  type InitSet,

  // Transaction Descriptors
  type TxnStatus,
  type TxnDescriptor,

  // Trace Nodes
  type NodeType,
  type BaseNode,
  type BeginNode,
  type UpdateNode,
  type AbortNode,
  type CommitNode,
  type TraceNode,
  type TraceEdge,

  // Store Types
  type MapVersion,
  type JournalRecordType,
  type BaseJournalRecord,
  type BeginTxnRecord,
  type UpdateRecord,
  type AbortRecord,
  type CommitRecord,
  type JournalRecord,

  // OTSPs
  type OTSP,
  createOTSP,
  otspsAreConcurrent,
  otspPrecedes,
} from "./types"

// =============================================================================
// Effects
// =============================================================================

export {
  // Constructors
  assign,
  increment,
  del,
  custom,

  // Type guards
  isAssignment,
  isIncrement,
  isDelete,
  isCustom,

  // Apply operator (⊙)
  applyEffect,
  effectToValue,

  // Sequential composition
  composeEffects,
  composeEffectSequence,

  // Concurrent merge
  mergeEffects,
  mergeEffectSet,

  // Utilities
  isProperSequence,
  findLastAssignment,
  compactEffectSequence,
  evaluateEffectSequence,
  effectsEqual,
} from "./effects"

// =============================================================================
// Transactions
// =============================================================================

export {
  // Descriptor operations
  createTxnDescriptor,
  updateTxnDescriptor,

  // Transaction state
  type TransactionState,
  createTransactionState,

  // Timestamp generator
  type TimestampGenerator,
  createTimestampGenerator,

  // No-inversion check
  noInversion,
  checkNoInversion,

  // Store interface
  type StoreInterface,

  // Transaction operations (Figure 1 rules)
  type TxnOperationResult,
  beginTxn,
  update,
  readSnapshot,
  read,
  readAssignOpt,
  abort,
  commit,

  // Transaction coordinator
  type TransactionCoordinator,
  createTransactionCoordinator,
} from "./transaction"

// =============================================================================
// Traces
// =============================================================================

export {
  // Node constructors
  beginNode,
  updateNode,
  abortNode,
  commitNode,

  // Trace types
  type Trace,
  type TraceBuilder,
  createTraceBuilder,

  // Trace queries
  getRoots,
  getParents,
  getChildren,
  isVisible,
  areConcurrent,
  getVisibleNodes,
  getVisibleCommits,

  // Topological sort
  topologicalSort,

  // Valuation (Figure 4)
  valAt,
  valAtAll,
  getTraceKeys,

  // Trace recorder
  type TraceRecorder,
  createTraceRecorder,

  // Trace validation
  validateTrace,
} from "./trace"

// =============================================================================
// Stores
// =============================================================================

export {
  // Store events (for stream-based architecture)
  type StoreEventType,
  type BaseStoreEvent,
  type BeginEvent,
  type UpdateEvent,
  type AbortEvent,
  type CommitEvent,
  type LookupEvent,
  type CheckpointEvent,
  type CompactionEvent,
  type StoreEvent,
  type StoreEventStream,

  // Store interface
  type StreamStore,
  createEventStream,

  // Basic stores
  type MapStoreState,
  createMapStore,
  createJournalStore,

  // Composed stores
  type StoreWindow,
  type Ministore,
  createComposedStore,
  createWALMemtablePair,

  // Trace-building store
  createTraceBuildingStore,

  // Verification
  verifyStoreEquivalence,
} from "./store"

// =============================================================================
// Stream-Backed Stores
// =============================================================================

export {
  // Stream-backed store options
  type StreamBackedStoreOptions,

  // Stream-backed store factory
  createStreamBackedStore,

  // In-memory stream for testing
  InMemoryStream,
  createInMemoryStreamStore,
} from "./stream-store"

// =============================================================================
// Scenarios & Testing
// =============================================================================

export {
  // Scenario types
  type ScenarioOperation,
  type ScenarioAssertion,
  type ScenarioMetadata,
  type ScenarioDefinition,
  type ScenarioState,

  // Scenario builder
  type TransactionBuilder,
  type ScenarioBuilder,
  scenario,

  // Scenario execution
  executeScenario,

  // Standard scenarios
  standardScenarios,
  getStandardScenarios,
  filterScenariosByTag,
  getOnlyScenarios,
  filterSkipped,
} from "./scenario"

// =============================================================================
// Test Generation
// =============================================================================

export {
  // Types
  type StoreFactory,
  type ScenarioTestResult,
  type TestSuiteResult,
  type TestGeneratorOptions,

  // Reference stores
  referenceStores,

  // Test execution
  runScenario,
  runScenarios,
  runConformanceTests,

  // Code generation
  generateTestCode,

  // YAML export
  exportToYAML,

  // Reporting
  formatReport,

  // CLI
  runCLI,
} from "./test-generator"

// =============================================================================
// HTTP API
// =============================================================================

export {
  // Request/Response types
  type SerializedEffect,
  type BatchOperation,
  type BatchRequest,
  type ReadResult,
  type BatchResponse,
  type ErrorResponse,

  // Execution
  executeBatch,

  // HTTP handler
  type HttpApiOptions,
  createHttpHandler,

  // Server
  type ServerOptions,
  createServer,
} from "./http-api"

// =============================================================================
// Fuzz Testing
// =============================================================================

export {
  // Random generation
  SeededRandom,

  // Configuration
  type FuzzConfig,
  defaultFuzzConfig,

  // Scenario generation
  generateRandomScenario,

  // Test results
  type FuzzRunResult,
  type StoreFactory,

  // Test runners
  runFuzzTest,
  runFuzzTests,
  quickFuzz,

  // Default stores
  fuzzStores,

  // Shrinking
  shrinkFailingCase,
} from "./fuzz"

// =============================================================================
// History-Based Verification
// =============================================================================

export {
  // History types
  type OperationType,
  type OperationStatus,
  type HistoryOperation,
  type HistoryTransaction,
  type History,

  // History builder
  type HistoryBuilder,
  createHistoryBuilder,

  // Dependency graph
  type DependencyType,
  type DependencyEdge,
  type DependencyGraph,
  buildDependencyGraph,

  // Cycle detection
  hasCycle,
  findCycle,

  // Consistency checking
  type ConsistencyCheckResult,
  checkSerializable,
  checkSnapshotIsolation,

  // Utilities
  formatGraph,
  formatCheckResult,
} from "./history"
