// SPDX-License-Identifier: Apache-2.0
// DurableStreams Swift Client - Idempotent Producer

import Foundation

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

        /// Error callback
        public var onError: (@Sendable (Error) -> Void)?

        public init(
            autoClaim: Bool = false,
            maxBatchBytes: Int = Defaults.maxBatchBytes,
            lingerMs: Int = Defaults.lingerMs,
            maxInFlight: Int = Defaults.maxInFlight,
            onError: (@Sendable (Error) -> Void)? = nil
        ) {
            self.autoClaim = autoClaim
            self.maxBatchBytes = maxBatchBytes
            self.lingerMs = lingerMs
            self.maxInFlight = maxInFlight
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

    /// Enqueue an encodable value for sending (returns immediately).
    public func append<T: Encodable>(_ value: T, encoder: JSONEncoder = JSONEncoder()) {
        guard !closed else { return }

        do {
            // For JSON streams, we send individual items that get wrapped by the batch
            let data = try encoder.encode(value)
            enqueueData(data)
        } catch {
            config.onError?(error)
        }
    }

    /// Enqueue raw data for sending (returns immediately).
    public func appendData(_ data: Data) {
        guard !closed else { return }
        enqueueData(data)
    }

    /// Enqueue a string for sending (returns immediately).
    public func appendString(_ text: String) {
        guard !closed else { return }
        guard let data = text.data(using: .utf8) else {
            config.onError?(DurableStreamError.badRequest(message: "Invalid UTF-8 string"))
            return
        }
        enqueueData(data)
    }

    /// Wait for all pending items to be acknowledged.
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

        // Check if we should send immediately
        if pendingSize >= config.maxBatchBytes || inFlightCount < config.maxInFlight {
            // Cancel any pending linger timer
            lingerTask?.cancel()

            // If we have room for more in-flight batches, send now
            if inFlightCount < config.maxInFlight {
                Task {
                    await sendBatch()
                }
            }
        } else if lingerTask == nil {
            // Start linger timer
            lingerTask = Task {
                try? await Task.sleep(for: .milliseconds(config.lingerMs))
                guard !Task.isCancelled else { return }
                await sendBatch()
            }
        }
    }

    private func sendBatch() async {
        guard !pendingItems.isEmpty else { return }

        // Take current pending items
        let items = pendingItems
        let seq = sequence

        pendingItems = []
        pendingSize = 0
        lingerTask = nil

        // Increment sequence for next batch
        sequence += 1
        inFlightCount += 1

        // Build batch data
        let batchData: Data
        if let contentType = await stream.contentType, contentType.isJSONContentType {
            // JSON mode: wrap items in array
            var arrayData = Data("[".utf8)
            for (index, item) in items.enumerated() {
                if index > 0 {
                    arrayData.append(Data(",".utf8))
                }
                arrayData.append(item)
            }
            arrayData.append(Data("]".utf8))
            batchData = arrayData
        } else {
            // Byte mode: concatenate
            batchData = items.reduce(Data()) { $0 + $1 }
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
            checkFlushComplete()

        } catch let error as DurableStreamError where error.code == .staleEpoch {
            // Handle stale epoch
            if config.autoClaim, let details = error.details, let currentEpoch = details["currentEpoch"].flatMap({ Int($0) }) {
                // Bump epoch and retry
                epoch = currentEpoch + 1
                sequence = 0
                inFlightCount -= 1

                // Re-enqueue items
                for item in items {
                    enqueueData(item)
                }
            } else {
                inFlightCount -= 1
                config.onError?(error)
                failFlushContinuations(error)
            }

        } catch let error as DurableStreamError where error.code == .sequenceGap {
            // Handle sequence gap by retrying
            inFlightCount -= 1

            // Re-enqueue items for retry
            for item in items.reversed() {
                pendingItems.insert(item, at: 0)
                pendingSize += item.count
            }

            // Retry sending
            Task {
                try? await Task.sleep(for: .milliseconds(10))
                await sendBatch()
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
