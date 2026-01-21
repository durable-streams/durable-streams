// SPDX-License-Identifier: MIT
// DurableStreams Swift Client - Idempotent Producer

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Fire-and-forget producer with exactly-once semantics.
///
/// Uses (producerId, epoch, seq) tuples for deduplication. Automatically
/// batches messages and pipelines requests for high throughput.
public actor IdempotentProducer {
    /// The underlying stream
    private let stream: DurableStream

    /// Producer identifier
    public let producerId: String

    /// Current epoch
    public private(set) var epoch: Int

    /// Current sequence number
    private var sequence: Int = 0

    /// Configuration
    private let config: Configuration

    /// Pending items to be batched
    private var pendingItems: [Data] = []
    private var pendingSize: Int = 0

    /// In-flight batches
    private var inFlightCount: Int = 0

    /// Linger timer task
    private var lingerTask: Task<Void, Never>?

    /// Last known offset
    private var lastOffset: Offset?

    /// Duplicate count for current session
    private var duplicateCount: Int = 0

    /// Whether producer has been closed
    private var closed = false

    /// Continuations waiting for flush
    private var flushContinuations: [CheckedContinuation<FlushResult, Error>] = []

    /// Configuration for IdempotentProducer
    public struct Configuration: Sendable {
        /// Auto-claim epoch on 403 Forbidden
        public var autoClaim: Bool

        /// Maximum bytes per batch
        public var maxBatchBytes: Int

        /// Time to wait for more items before sending (milliseconds)
        public var lingerMs: Int

        /// Maximum concurrent batches in flight
        public var maxInFlight: Int

        /// Maximum retries for sequence gap errors before giving up
        public var maxSequenceGapRetries: Int

        /// Content type for batch serialization (cached to avoid actor hops)
        public var contentType: String?

        /// Error callback
        public var onError: (@Sendable (Error) -> Void)?

        public init(
            autoClaim: Bool = false,
            maxBatchBytes: Int = 1_048_576,  // 1MB
            lingerMs: Int = 5,
            maxInFlight: Int = 5,
            maxSequenceGapRetries: Int = 10,
            contentType: String? = nil,
            onError: (@Sendable (Error) -> Void)? = nil
        ) {
            self.autoClaim = autoClaim
            self.maxBatchBytes = maxBatchBytes
            self.lingerMs = lingerMs
            self.maxInFlight = maxInFlight
            self.maxSequenceGapRetries = maxSequenceGapRetries
            self.contentType = contentType
            self.onError = onError
        }

        public static let `default` = Configuration()
    }

    public init(
        stream: DurableStream,
        producerId: String,
        epoch: Int = 0,
        config: Configuration = .default
    ) {
        self.stream = stream
        self.producerId = producerId
        self.epoch = epoch
        self.config = config
    }

    // MARK: - Public API

    /// Enqueue raw data for sending (returns immediately).
    /// For JSON streams, pass pre-serialized JSON data.
    ///
    /// Example:
    /// ```swift
    /// // JSON stream - pass pre-serialized JSON
    /// let jsonData = try JSONEncoder().encode(MyMessage(text: "hello"))
    /// producer.appendData(jsonData)
    ///
    /// // Byte stream
    /// producer.appendData("raw data".data(using: .utf8)!)
    /// ```
    public func appendData(_ data: Data) {
        guard !closed else {
            config.onError?(DurableStreamError.badRequest(message: "Producer is closed"))
            return
        }
        enqueueData(data)
    }

    /// Enqueue multiple raw data items at once (single actor hop).
    /// Much faster than calling appendData() in a loop.
    /// For JSON streams, each item should be pre-serialized JSON.
    public func appendBatch(_ items: [Data]) {
        guard !closed else {
            config.onError?(DurableStreamError.badRequest(message: "Producer is closed"))
            return
        }
        for data in items {
            pendingItems.append(data)
            pendingSize += data.count
        }
        // Trigger send if we have room
        if inFlightCount < config.maxInFlight && !pendingItems.isEmpty {
            lingerTask?.cancel()
            Task {
                await sendBatch()
            }
        }
    }

    /// Enqueue a string for sending (returns immediately).
    /// For JSON streams, pass pre-serialized JSON strings.
    ///
    /// Example:
    /// ```swift
    /// // JSON stream - pass pre-serialized JSON
    /// producer.appendString("{\"message\":\"hello\"}")
    ///
    /// // Byte stream
    /// producer.appendString("raw text data")
    /// ```
    public func appendString(_ text: String) {
        guard !closed else {
            config.onError?(DurableStreamError.badRequest(message: "Producer is closed"))
            return
        }
        guard let data = text.data(using: .utf8) else {
            config.onError?(DurableStreamError.badRequest(message: "Invalid UTF-8 string"))
            return
        }
        enqueueData(data)
    }

    /// Wait for all pending items to be acknowledged.
    @discardableResult
    public func flush() async throws -> FlushResult {
        guard !closed else {
            return FlushResult(offset: lastOffset ?? Offset(rawValue: "0"), duplicateCount: duplicateCount)
        }

        // If nothing pending and nothing in-flight, return immediately
        if pendingItems.isEmpty && inFlightCount == 0 {
            return FlushResult(offset: lastOffset ?? Offset(rawValue: "0"), duplicateCount: duplicateCount)
        }

        // Send any pending items immediately
        if !pendingItems.isEmpty {
            await sendBatch()
        }

        // If still have in-flight batches, wait for them
        if inFlightCount > 0 {
            return try await withCheckedThrowingContinuation { continuation in
                flushContinuations.append(continuation)
            }
        }

        return FlushResult(offset: lastOffset ?? Offset(rawValue: "0"), duplicateCount: duplicateCount)
    }

    /// Close the producer, flushing any pending writes.
    public func close() async throws {
        closed = true
        lingerTask?.cancel()
        _ = try await flush()
    }

    // MARK: - Private Implementation

    private func enqueueData(_ data: Data) {
        pendingItems.append(data)
        pendingSize += data.count

        // Send immediately only when batch size threshold is reached
        if pendingSize >= config.maxBatchBytes {
            lingerTask?.cancel()
            lingerTask = nil
            if inFlightCount < config.maxInFlight {
                Task {
                    await sendBatch()
                }
            }
        } else if lingerTask == nil {
            // Start linger timer to collect more items before sending
            lingerTask = Task {
                try? await Task.sleep(for: .milliseconds(config.lingerMs))
                guard !Task.isCancelled else { return }
                if inFlightCount < config.maxInFlight {
                    await sendBatch()
                }
            }
        }
    }

    private func sendBatch(sequenceGapRetryCount: Int = 0, isRetry: Bool = false) async {
        guard !pendingItems.isEmpty else { return }

        // Take current pending items
        let items = pendingItems
        let seq = sequence

        pendingItems = []
        pendingSize = 0
        lingerTask = nil

        // Increment sequence for next batch
        sequence += 1

        // Only increment inFlightCount for new batches, not retries
        // (retries already have inFlightCount accounted for)
        if !isRetry {
            inFlightCount += 1
        }

        // Build batch data - use cached contentType to avoid actor hop
        let batchData: Data
        let isJSON = config.contentType?.isJSONContentType ?? false

        if isJSON {
            // JSON mode: wrap items in array
            // Pre-calculate size: brackets + commas + item sizes
            let commas = max(0, items.count - 1)
            let totalSize = 2 + commas + items.reduce(0) { $0 + $1.count }
            var arrayData = Data(capacity: totalSize)
            arrayData.append(contentsOf: "[".utf8)
            for (index, item) in items.enumerated() {
                if index > 0 {
                    arrayData.append(contentsOf: ",".utf8)
                }
                arrayData.append(item)
            }
            arrayData.append(contentsOf: "]".utf8)
            batchData = arrayData
        } else {
            // Byte mode: concatenate with pre-allocated capacity (avoids O(n²))
            let totalSize = items.reduce(0) { $0 + $1.count }
            var combined = Data(capacity: totalSize)
            for item in items {
                combined.append(item)
            }
            batchData = combined
        }

        // Send batch
        do {
            let result = try await stream.appendWithProducer(
                batchData,
                producerId: producerId,
                epoch: epoch,
                seq: seq
            )

            lastOffset = result.offset
            if result.isDuplicate {
                duplicateCount += 1
            }

            inFlightCount -= 1

            // Try to send pending items now that capacity freed up
            if !pendingItems.isEmpty && inFlightCount < config.maxInFlight {
                lingerTask?.cancel()
                lingerTask = nil
                Task {
                    await sendBatch()
                }
            }

            checkFlushComplete()

        } catch let error as DurableStreamError where error.code == .staleEpoch {
            // Handle stale epoch
            if config.autoClaim, let details = error.details, let currentEpoch = details["currentEpoch"].flatMap({ Int($0) }) {
                // Bump epoch and retry (don't decrement inFlightCount - we're retrying)
                epoch = currentEpoch + 1
                sequence = 0

                // Re-enqueue items directly (bypass enqueueData to avoid linger timer)
                for item in items.reversed() {
                    pendingItems.insert(item, at: 0)
                    pendingSize += item.count
                }

                // Cancel linger timer and immediately send the re-queued batch
                // Note: inFlightCount is still 1, so flush() will wait
                // Use isRetry: true since we're reusing the existing inFlightCount
                lingerTask?.cancel()
                lingerTask = nil
                Task {
                    await sendBatch(isRetry: true)
                }
            } else {
                inFlightCount -= 1
                config.onError?(error)
                failFlushContinuations(error)
            }

        } catch let error as DurableStreamError where error.code == .sequenceGap {
            // Handle sequence gap by resetting to expected sequence and retrying
            inFlightCount -= 1

            let newRetryCount = sequenceGapRetryCount + 1
            if newRetryCount > config.maxSequenceGapRetries {
                // Exceeded max retries, fail permanently
                let maxRetriesError = DurableStreamError.badRequest(
                    message: "Exceeded max sequence gap retries (\(config.maxSequenceGapRetries))"
                )
                config.onError?(maxRetriesError)
                failFlushContinuations(maxRetriesError)
                return
            }

            // Reset sequence to expected value from server
            if let expectedStr = error.details?["expected"], let expected = Int(expectedStr) {
                sequence = expected
            }

            // Re-enqueue items for retry
            for item in items.reversed() {
                pendingItems.insert(item, at: 0)
                pendingSize += item.count
            }

            // Retry sending with incremented count
            Task {
                try? await Task.sleep(for: .milliseconds(10))
                await sendBatch(sequenceGapRetryCount: newRetryCount)
            }

        } catch {
            inFlightCount -= 1
            config.onError?(error)
            failFlushContinuations(error)
        }
    }

    private func checkFlushComplete() {
        if inFlightCount == 0 && pendingItems.isEmpty && !flushContinuations.isEmpty {
            let result = FlushResult(offset: lastOffset ?? Offset(rawValue: "0"), duplicateCount: duplicateCount)
            for continuation in flushContinuations {
                continuation.resume(returning: result)
            }
            flushContinuations.removeAll()
        }
    }

    private func failFlushContinuations(_ error: Error) {
        for continuation in flushContinuations {
            continuation.resume(throwing: error)
        }
        flushContinuations.removeAll()
    }
}
