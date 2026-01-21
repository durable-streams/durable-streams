/**
 * Stream Protocol Contracts
 *
 * These define the invariants that ALL Durable Streams implementations must satisfy.
 * Each contract specifies:
 * - id: Unique identifier for the contract
 * - description: Human-readable description
 * - assert: Runtime assertion function
 * - property: Property-based test generator (optional, requires fast-check)
 *
 * Contracts serve as the single source of truth for correctness properties,
 * used by conformance tests, unit tests, and property-based tests.
 */

import { assert, bytesEqual, compareOffsets, concatBytes } from "./assert.js"
import type { Contract, ContractAssertFn, PropertyGenerator } from "./types.js"

// ============================================================================
// Contract: Offset Monotonicity
// ============================================================================

export interface OffsetMonotonicityContext {
  prevOffset: string
  newOffset: string
}

const offsetMonotonicityAssert: ContractAssertFn<OffsetMonotonicityContext> = (
  ctx
) => {
  assert(
    compareOffsets(ctx.newOffset, ctx.prevOffset) > 0,
    `offset-monotonicity`,
    `New offset must be greater than previous offset`,
    { prevOffset: ctx.prevOffset, newOffset: ctx.newOffset }
  )
}

const offsetMonotonicityProperty: PropertyGenerator = (fc) =>
  fc.property(
    fc.array(fc.uint8Array({ minLength: 1, maxLength: 100 }), {
      minLength: 2,
      maxLength: 10,
    }),
    () => {
      // This is a template - actual stream interaction provided by test harness
      // Returns true to indicate the property structure
      return true
    }
  )

/**
 * CONTRACT: Offset Monotonicity
 *
 * Each append operation produces an offset that is strictly greater
 * than the previous offset. Offsets are lexicographically sortable strings.
 *
 * Invariant: For any two consecutive appends, offset(n+1) > offset(n)
 */
export const OffsetMonotonicity: Contract<OffsetMonotonicityContext> = {
  id: `offset-monotonicity`,
  description: `Offsets are monotonically increasing`,
  category: `ordering`,
  assert: offsetMonotonicityAssert,
  property: offsetMonotonicityProperty,
}

// ============================================================================
// Contract: Data Ordering
// ============================================================================

export interface DataOrderingContext {
  appendedChunks: Array<Uint8Array>
  readData: Uint8Array
}

const dataOrderingAssert: ContractAssertFn<DataOrderingContext> = (ctx) => {
  const expected = concatBytes(ctx.appendedChunks)
  assert(
    bytesEqual(ctx.readData, expected),
    `data-ordering`,
    `Read data must match concatenated append order`,
    {
      expectedLength: expected.length,
      actualLength: ctx.readData.length,
    }
  )
}

/**
 * CONTRACT: Data Ordering
 *
 * Data read from a stream is returned in the exact order it was appended.
 * Reading from offset 0 returns all data concatenated in append order.
 *
 * Invariant: read() === concat(append[0], append[1], ..., append[n])
 */
export const DataOrdering: Contract<DataOrderingContext> = {
  id: `data-ordering`,
  description: `Data is read in append order`,
  category: `ordering`,
  assert: dataOrderingAssert,
}

// ============================================================================
// Contract: Byte Exactness
// ============================================================================

export interface ByteExactnessContext {
  read1: Uint8Array
  read2: Uint8Array
  offset: string
}

const byteExactnessAssert: ContractAssertFn<ByteExactnessContext> = (ctx) => {
  assert(
    bytesEqual(ctx.read1, ctx.read2),
    `byte-exactness`,
    `Multiple reads from same offset must return identical bytes`,
    {
      offset: ctx.offset,
      length1: ctx.read1.length,
      length2: ctx.read2.length,
    }
  )
}

/**
 * CONTRACT: Byte Exactness
 *
 * Reading from the same offset always returns identical bytes.
 * This is essential for caching, resumption, and consistency.
 *
 * Invariant: read(offset) === read(offset) for any offset
 */
export const ByteExactness: Contract<ByteExactnessContext> = {
  id: `byte-exactness`,
  description: `Reads are byte-exact and deterministic`,
  category: `consistency`,
  assert: byteExactnessAssert,
}

// ============================================================================
// Contract: Resume From Offset
// ============================================================================

export interface ResumeFromOffsetContext {
  offset: string
  dataAfterOffset: Uint8Array
  expectedData: Uint8Array
}

const resumeFromOffsetAssert: ContractAssertFn<ResumeFromOffsetContext> = (
  ctx
) => {
  assert(
    bytesEqual(ctx.dataAfterOffset, ctx.expectedData),
    `resume-from-offset`,
    `Reading from offset must return only subsequent data`,
    {
      offset: ctx.offset,
      expectedLength: ctx.expectedData.length,
      actualLength: ctx.dataAfterOffset.length,
    }
  )
}

/**
 * CONTRACT: Resume From Offset
 *
 * Reading from a specific offset returns only data appended after that offset.
 * The offset marks a position; data at that position is not included.
 *
 * Invariant: read(offset[n]) === concat(append[n+1], ..., append[m])
 */
export const ResumeFromOffset: Contract<ResumeFromOffsetContext> = {
  id: `resume-from-offset`,
  description: `Reading from offset returns only subsequent data`,
  category: `resumption`,
  assert: resumeFromOffsetAssert,
}

// ============================================================================
// Contract: Up-To-Date Flag
// ============================================================================

export interface UpToDateContext {
  upToDate: boolean
  hasMoreData: boolean
}

const upToDateAssert: ContractAssertFn<UpToDateContext> = (ctx) => {
  if (ctx.upToDate) {
    assert(
      !ctx.hasMoreData,
      `up-to-date`,
      `When upToDate is true, there must be no more data to read`,
      { upToDate: ctx.upToDate, hasMoreData: ctx.hasMoreData }
    )
  }
}

/**
 * CONTRACT: Up-To-Date Flag
 *
 * The upToDate flag indicates the client has caught up with all available data.
 * When true, no more data is immediately available (though more may arrive later).
 *
 * Invariant: upToDate === true implies no pending data to read
 */
export const UpToDate: Contract<UpToDateContext> = {
  id: `up-to-date`,
  description: `upToDate flag accurately reflects stream state`,
  category: `state`,
  assert: upToDateAssert,
}

// ============================================================================
// Contract: Idempotent Create
// ============================================================================

export interface IdempotentCreateContext {
  firstCreateSucceeded: boolean
  secondCreateSucceeded: boolean
  sameConfig: boolean
}

const idempotentCreateAssert: ContractAssertFn<IdempotentCreateContext> = (
  ctx
) => {
  if (ctx.sameConfig) {
    assert(
      ctx.secondCreateSucceeded,
      `idempotent-create`,
      `Creating a stream with identical config must succeed (idempotent)`,
      { firstCreateSucceeded: ctx.firstCreateSucceeded }
    )
  }
}

/**
 * CONTRACT: Idempotent Create
 *
 * Creating a stream with the same configuration is idempotent.
 * Repeated creates with identical config succeed; different config returns 409.
 *
 * Invariant: create(config) followed by create(config) both succeed
 */
export const IdempotentCreate: Contract<IdempotentCreateContext> = {
  id: `idempotent-create`,
  description: `Stream creation is idempotent with same config`,
  category: `lifecycle`,
  assert: idempotentCreateAssert,
}

// ============================================================================
// Contract: Config Conflict
// ============================================================================

export interface ConfigConflictContext {
  streamExists: boolean
  differentConfig: boolean
  createRejected: boolean
  statusCode?: number
}

const configConflictAssert: ContractAssertFn<ConfigConflictContext> = (ctx) => {
  if (ctx.streamExists && ctx.differentConfig) {
    assert(
      ctx.createRejected && ctx.statusCode === 409,
      `config-conflict`,
      `Creating a stream with different config must return 409 Conflict`,
      { statusCode: ctx.statusCode }
    )
  }
}

/**
 * CONTRACT: Config Conflict
 *
 * Attempting to create a stream with a different configuration than
 * an existing stream must fail with HTTP 409 Conflict.
 *
 * Invariant: create(config1) then create(config2) returns 409 if config1 !== config2
 */
export const ConfigConflict: Contract<ConfigConflictContext> = {
  id: `config-conflict`,
  description: `Different config on existing stream returns 409`,
  category: `lifecycle`,
  assert: configConflictAssert,
}

// ============================================================================
// Contract: Delete Removes Data
// ============================================================================

export interface DeleteRemovesDataContext {
  deletedSuccessfully: boolean
  readAfterDeleteFails: boolean
  statusCodeAfterDelete?: number
}

const deleteRemovesDataAssert: ContractAssertFn<DeleteRemovesDataContext> = (
  ctx
) => {
  if (ctx.deletedSuccessfully) {
    assert(
      ctx.readAfterDeleteFails,
      `delete-removes-data`,
      `Reading a deleted stream must fail`,
      { statusCodeAfterDelete: ctx.statusCodeAfterDelete }
    )
  }
}

/**
 * CONTRACT: Delete Removes Data
 *
 * After a stream is deleted, it cannot be read. Attempts to read
 * should return 404 Not Found.
 *
 * Invariant: delete(stream) then read(stream) returns 404
 */
export const DeleteRemovesData: Contract<DeleteRemovesDataContext> = {
  id: `delete-removes-data`,
  description: `Deleted streams cannot be read`,
  category: `lifecycle`,
  assert: deleteRemovesDataAssert,
}

// ============================================================================
// Contract: Empty Append Rejected
// ============================================================================

export interface EmptyAppendRejectedContext {
  dataLength: number
  appendRejected: boolean
  statusCode?: number
}

const emptyAppendRejectedAssert: ContractAssertFn<
  EmptyAppendRejectedContext
> = (ctx) => {
  if (ctx.dataLength === 0) {
    assert(
      ctx.appendRejected && ctx.statusCode === 400,
      `empty-append-rejected`,
      `Appending empty data must return 400 Bad Request`,
      { statusCode: ctx.statusCode }
    )
  }
}

/**
 * CONTRACT: Empty Append Rejected
 *
 * Appending empty data (zero bytes) must be rejected with HTTP 400.
 * This prevents creating meaningless offsets.
 *
 * Invariant: append(empty) returns 400
 */
export const EmptyAppendRejected: Contract<EmptyAppendRejectedContext> = {
  id: `empty-append-rejected`,
  description: `Appending empty data returns 400`,
  category: `validation`,
  assert: emptyAppendRejectedAssert,
}

// ============================================================================
// Contract: Unicode Preservation
// ============================================================================

export interface UnicodePreservationContext {
  originalString: string
  readString: string
}

const unicodePreservationAssert: ContractAssertFn<
  UnicodePreservationContext
> = (ctx) => {
  assert(
    ctx.originalString === ctx.readString,
    `unicode-preservation`,
    `Unicode content must be preserved exactly`,
    {
      originalLength: ctx.originalString.length,
      readLength: ctx.readString.length,
      original: ctx.originalString.slice(0, 100),
      read: ctx.readString.slice(0, 100),
    }
  )
}

/**
 * CONTRACT: Unicode Preservation
 *
 * Unicode text (including emoji, multi-byte characters, line separators)
 * must be preserved exactly through append and read cycles.
 *
 * Invariant: decode(read(encode(text))) === text
 */
export const UnicodePreservation: Contract<UnicodePreservationContext> = {
  id: `unicode-preservation`,
  description: `Unicode content is preserved exactly`,
  category: `encoding`,
  assert: unicodePreservationAssert,
}

// ============================================================================
// Export All Stream Contracts
// ============================================================================

/**
 * All stream protocol contracts as a single object.
 * Use this for iteration or dynamic access.
 */
export const StreamContracts: {
  readonly OffsetMonotonicity: Contract<OffsetMonotonicityContext>
  readonly DataOrdering: Contract<DataOrderingContext>
  readonly ByteExactness: Contract<ByteExactnessContext>
  readonly ResumeFromOffset: Contract<ResumeFromOffsetContext>
  readonly UpToDate: Contract<UpToDateContext>
  readonly IdempotentCreate: Contract<IdempotentCreateContext>
  readonly ConfigConflict: Contract<ConfigConflictContext>
  readonly DeleteRemovesData: Contract<DeleteRemovesDataContext>
  readonly EmptyAppendRejected: Contract<EmptyAppendRejectedContext>
  readonly UnicodePreservation: Contract<UnicodePreservationContext>
} = {
  OffsetMonotonicity,
  DataOrdering,
  ByteExactness,
  ResumeFromOffset,
  UpToDate,
  IdempotentCreate,
  ConfigConflict,
  DeleteRemovesData,
  EmptyAppendRejected,
  UnicodePreservation,
}

export type StreamContractId = keyof typeof StreamContracts
