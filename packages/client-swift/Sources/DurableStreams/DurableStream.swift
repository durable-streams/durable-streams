// SPDX-License-Identifier: MIT
// DurableStreams Swift Client - Main Stream Handle

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A handle to a Durable Stream with read/write capabilities.
public actor DurableStream {
    /// The stream URL
    public let url: URL

    /// The stream's content type
    public private(set) var contentType: String?

    /// HTTP client for requests
    private let httpClient: HTTPClient

    /// Configuration
    private let config: Configuration

    /// Batch queue for appends when batching is enabled
    private var batchQueue: [Data] = []
    private var batchTask: Task<Void, Never>?
    private var lastOffset: Offset?

    /// Configuration for DurableStream
    public struct Configuration: Sendable {
        /// Custom headers for all requests
        public var headers: HeadersRecord

        /// Custom params for all requests
        public var params: ParamsRecord

        /// Whether to enable automatic batching for appends
        public var batching: Bool

        /// Maximum bytes before sending a batch
        public var maxBatchBytes: Int

        /// Time to wait for more items before sending (milliseconds)
        public var lingerMs: Int

        /// Request timeout
        public var timeout: TimeInterval

        /// URLSession to use
        public var session: URLSession

        public init(
            headers: HeadersRecord = [:],
            params: ParamsRecord = [:],
            batching: Bool = true,
            maxBatchBytes: Int = Defaults.maxBatchBytes,
            lingerMs: Int = Defaults.lingerMs,
            timeout: TimeInterval = Defaults.timeout,
            session: URLSession = .shared
        ) {
            self.headers = headers
            self.params = params
            self.batching = batching
            self.maxBatchBytes = maxBatchBytes
            self.lingerMs = lingerMs
            self.timeout = timeout
            self.session = session
        }

        public static let `default` = Configuration()
    }

    private init(url: URL, contentType: String?, config: Configuration) {
        self.url = url
        self.contentType = contentType
        self.config = config
        self.httpClient = HTTPClient(
            session: config.session,
            headers: config.headers,
            params: config.params
        )
    }

    // MARK: - Factory Methods

    /// Create a new stream.
    /// - Throws: `DurableStreamError.conflictExists` if stream already exists
    public static func create(
        url: URL,
        contentType: String = "application/json",
        ttlSeconds: Int? = nil,
        expiresAt: String? = nil,
        config: Configuration = .default
    ) async throws -> DurableStream {
        let httpClient = HTTPClient(
            session: config.session,
            headers: config.headers,
            params: config.params
        )

        var headers: [String: String] = [
            "Content-Type": contentType
        ]

        if let ttl = ttlSeconds {
            headers[Headers.streamTTL] = String(ttl)
        }
        if let expires = expiresAt {
            headers[Headers.streamExpiresAt] = expires
        }

        let request = await httpClient.buildRequest(
            url: url,
            method: "PUT",
            headers: headers
        )

        _ = try await httpClient.performChecked(request, expectedStatus: [201])

        return DurableStream(url: url, contentType: contentType, config: config)
    }

    /// Connect to an existing stream.
    /// - Throws: `DurableStreamError.notFound` if stream doesn't exist
    public static func connect(
        url: URL,
        config: Configuration = .default
    ) async throws -> DurableStream {
        let httpClient = HTTPClient(
            session: config.session,
            headers: config.headers,
            params: config.params
        )

        let request = await httpClient.buildRequest(url: url, method: "HEAD")
        let (_, metadata) = try await httpClient.performChecked(request)

        return DurableStream(url: url, contentType: metadata.contentType, config: config)
    }

    /// Create if not exists, or connect if it does.
    public static func createOrConnect(
        url: URL,
        contentType: String = "application/json",
        ttlSeconds: Int? = nil,
        expiresAt: String? = nil,
        config: Configuration = .default
    ) async throws -> DurableStream {
        do {
            return try await create(
                url: url,
                contentType: contentType,
                ttlSeconds: ttlSeconds,
                expiresAt: expiresAt,
                config: config
            )
        } catch let error as DurableStreamError where error.code == .conflictExists || error.status == 409 {
            return try await connect(url: url, config: config)
        }
    }

    // MARK: - Factory Methods (HandleConfiguration)

    /// Create a new stream with unified configuration.
    /// - Throws: `DurableStreamError.conflictExists` if stream already exists
    public static func create(
        url: URL,
        contentType: String = "application/json",
        ttlSeconds: Int? = nil,
        expiresAt: String? = nil,
        handleConfig: HandleConfiguration
    ) async throws -> DurableStream {
        try await create(
            url: url,
            contentType: contentType,
            ttlSeconds: ttlSeconds,
            expiresAt: expiresAt,
            config: Configuration(from: handleConfig)
        )
    }

    /// Connect to an existing stream with unified configuration.
    /// - Throws: `DurableStreamError.notFound` if stream doesn't exist
    public static func connect(
        url: URL,
        handleConfig: HandleConfiguration
    ) async throws -> DurableStream {
        try await connect(url: url, config: Configuration(from: handleConfig))
    }

    /// Create if not exists, or connect if it does (unified configuration).
    public static func createOrConnect(
        url: URL,
        contentType: String = "application/json",
        ttlSeconds: Int? = nil,
        expiresAt: String? = nil,
        handleConfig: HandleConfiguration
    ) async throws -> DurableStream {
        try await createOrConnect(
            url: url,
            contentType: contentType,
            ttlSeconds: ttlSeconds,
            expiresAt: expiresAt,
            config: Configuration(from: handleConfig)
        )
    }

    /// Get stream metadata without establishing a handle.
    public static func head(url: URL, config: Configuration = .default) async throws -> StreamInfo {
        let httpClient = HTTPClient(
            session: config.session,
            headers: config.headers,
            params: config.params
        )

        let request = await httpClient.buildRequest(url: url, method: "HEAD")
        let (_, metadata) = try await httpClient.performChecked(request)

        return StreamInfo(
            offset: metadata.offset,
            contentType: metadata.contentType,
            etag: metadata.etag
        )
    }

    /// Delete a stream.
    public static func delete(url: URL, config: Configuration = .default) async throws {
        let httpClient = HTTPClient(
            session: config.session,
            headers: config.headers,
            params: config.params
        )

        let request = await httpClient.buildRequest(url: url, method: "DELETE")
        _ = try await httpClient.performChecked(request)
    }

    // MARK: - Reading

    /// Read from the stream starting at an offset.
    public func read(
        offset: Offset = .start,
        live: LiveMode = .catchUp,
        headers: HeadersRecord = [:]
    ) async throws -> StreamReadResult {
        var params: [String: String] = [
            QueryParams.offset: offset.rawValue
        ]

        if let liveValue = live.queryValue, live != .catchUp {
            params[QueryParams.live] = liveValue
        }

        let requestURL = try await httpClient.buildURL(base: url, params: params)
        let request = await httpClient.buildRequest(
            url: requestURL,
            additionalHeaders: headers
        )

        let (data, metadata) = try await httpClient.performChecked(request, expectedStatus: [200, 204])

        return StreamReadResult(
            data: data,
            offset: metadata.offset ?? offset,
            upToDate: metadata.upToDate,
            cursor: metadata.cursor,
            contentType: metadata.contentType,
            status: metadata.status
        )
    }

    /// Read all data as text.
    /// Note: Non-UTF-8 data is converted to empty string rather than throwing.
    public func readText(offset: Offset = .start) async throws -> TextResult {
        let result = try await read(offset: offset, live: .catchUp)
        let text = String(data: result.data, encoding: .utf8) ?? ""
        return TextResult(text: text, offset: result.offset, upToDate: result.upToDate)
    }

    /// Read all data as bytes.
    public func readBytes(offset: Offset = .start) async throws -> ByteResult {
        let result = try await read(offset: offset, live: .catchUp)
        return ByteResult(data: result.data, offset: result.offset, upToDate: result.upToDate)
    }

    /// Read and decode JSON.
    public func readJSON<T: Decodable>(
        as type: T.Type,
        offset: Offset = .start,
        decoder: JSONDecoder = JSONDecoder()
    ) async throws -> JsonBatch<T> {
        let result = try await read(offset: offset, live: .catchUp)

        // Empty response
        if result.data.isEmpty {
            return JsonBatch(items: [], offset: result.offset, upToDate: result.upToDate, cursor: result.cursor)
        }

        let items = try decoder.decode([T].self, from: result.data)
        return JsonBatch(items: items, offset: result.offset, upToDate: result.upToDate, cursor: result.cursor)
    }

    // MARK: - Streaming

    /// Stream individual JSON messages as they arrive.
    ///
    /// This is a convenience method that uses long-poll streaming under the hood:
    /// ```swift
    /// for try await message in handle.messages(as: ChatMessage.self) {
    ///     print("Received: \(message)")
    /// }
    /// ```
    ///
    /// For batch-level control (e.g., checkpointing per-batch), use `jsonBatches()` instead.
    public func messages<T: Decodable & Sendable>(
        as type: T.Type,
        from offset: Offset = .start,
        decoder: JSONDecoder = JSONDecoder()
    ) -> AsyncThrowingStream<T, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await batch in self.jsonBatches(as: type, from: offset, decoder: decoder) {
                        if Task.isCancelled { break }
                        for item in batch.items {
                            continuation.yield(item)
                        }
                    }
                    continuation.finish()
                } catch {
                    if !Task.isCancelled {
                        continuation.finish(throwing: error)
                    } else {
                        continuation.finish()
                    }
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Stream JSON batches as they arrive.
    ///
    /// Each batch includes the offset for checkpointing:
    /// ```swift
    /// for try await batch in handle.jsonBatches(as: Event.self) {
    ///     try await database.transaction { tx in
    ///         for event in batch.items {
    ///             try await tx.apply(event)
    ///         }
    ///         try await tx.saveOffset(batch.offset)
    ///     }
    /// }
    /// ```
    public func jsonBatches<T: Decodable & Sendable>(
        as type: T.Type,
        from offset: Offset = .start,
        decoder: JSONDecoder = JSONDecoder()
    ) -> AsyncThrowingStream<JsonBatch<T>, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                await self.runStreamLoop(
                    from: offset,
                    continuation: continuation,
                    transform: { data, resultOffset, upToDate, cursor in
                        if data.isEmpty {
                            return JsonBatch<T>(items: [], offset: resultOffset, upToDate: upToDate, cursor: cursor)
                        }
                        let items = try decoder.decode([T].self, from: data)
                        return JsonBatch<T>(items: items, offset: resultOffset, upToDate: upToDate, cursor: cursor)
                    }
                )
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Stream byte chunks as they arrive.
    public func byteChunks(from offset: Offset = .start) -> AsyncThrowingStream<ByteChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                await self.runStreamLoop(
                    from: offset,
                    continuation: continuation,
                    transform: { data, resultOffset, upToDate, cursor in
                        ByteChunk(data: data, offset: resultOffset, upToDate: upToDate, cursor: cursor)
                    }
                )
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Stream text chunks as they arrive.
    /// Note: Non-UTF-8 data is converted to empty string rather than throwing.
    public func textChunks(from offset: Offset = .start) -> AsyncThrowingStream<TextChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                await self.runStreamLoop(
                    from: offset,
                    continuation: continuation,
                    transform: { data, resultOffset, upToDate, cursor in
                        let text = String(data: data, encoding: .utf8) ?? ""
                        return TextChunk(text: text, offset: resultOffset, upToDate: upToDate, cursor: cursor)
                    }
                )
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Internal streaming loop using long-poll.
    private func runStreamLoop<T: Sendable>(
        from offset: Offset,
        continuation: AsyncThrowingStream<T, Error>.Continuation,
        transform: @escaping @Sendable (Data, Offset, Bool, String?) throws -> T
    ) async {
        var currentOffset = offset
        var currentCursor: String? = nil
        var retryAttempt = 0
        let retryConfig = RetryConfig.default

        while !Task.isCancelled {
            do {
                // Build request with long-poll parameters
                var params: [String: String] = [
                    QueryParams.offset: currentOffset.rawValue,
                    QueryParams.live: "long-poll"
                ]

                if let cursor = currentCursor {
                    params[QueryParams.cursor] = cursor
                }

                let requestURL = try await httpClient.buildURL(base: url, params: params)
                let request = await httpClient.buildRequest(url: requestURL)

                let (data, metadata) = try await httpClient.perform(request)

                switch metadata.status {
                case 200:
                    let newOffset = metadata.offset ?? currentOffset
                    let result = try transform(data, newOffset, metadata.upToDate, metadata.cursor)
                    continuation.yield(result)
                    currentOffset = newOffset
                    currentCursor = metadata.cursor
                    retryAttempt = 0  // Reset retry count on success

                case 204:
                    // Long-poll timeout, retry with same offset
                    retryAttempt = 0  // Timeout is normal, reset retry count
                    continue

                case 410:
                    continuation.finish(throwing: DurableStreamError.retentionExpired(offset: currentOffset))
                    return

                default:
                    let body = String(data: data, encoding: .utf8)
                    continuation.finish(throwing: DurableStreamError.fromHTTPStatus(metadata.status, body: body))
                    return
                }
            } catch let error as DurableStreamError {
                if error.code == .timeout || error.code == .serverBusy {
                    retryAttempt += 1
                    let delayMs = retryConfig.delayForAttempt(retryAttempt)
                    try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                    continue
                }
                continuation.finish(throwing: error)
                return
            } catch {
                continuation.finish(throwing: error)
                return
            }
        }

        continuation.finish()
    }

    // MARK: - Writing (Synchronous)

    /// Append data to the stream (awaits server acknowledgment).
    ///
    /// - Parameters:
    ///   - data: The data to append
    ///   - contentType: Optional content type override
    ///   - seq: Optional Stream-Seq header for writer coordination (must be monotonically increasing)
    public func appendSync(_ data: Data, contentType: String? = nil, seq: Int? = nil) async throws -> AppendResult {
        let ct = contentType ?? self.contentType ?? "application/octet-stream"

        var headers: [String: String] = [:]
        if let seq = seq {
            headers[Headers.streamSeq] = String(seq)
        }

        let request = await httpClient.buildRequest(
            url: url,
            method: "POST",
            headers: headers,
            body: data,
            contentType: ct
        )

        let (responseData, metadata) = try await httpClient.perform(request)

        switch metadata.status {
        case 200, 204:
            let isDuplicate = metadata.status == 204
            let offset = metadata.offset ?? lastOffset ?? Offset(rawValue: "0")
            lastOffset = offset
            return AppendResult(offset: offset, isDuplicate: isDuplicate)

        case 409:
            throw DurableStreamError(code: .conflictSeq, message: "Sequence conflict", status: 409)

        default:
            let body = String(data: responseData, encoding: .utf8)
            throw DurableStreamError.fromHTTPStatus(metadata.status, body: body)
        }
    }

    /// Append a string to the stream.
    public func appendSync(_ text: String) async throws -> AppendResult {
        guard let data = text.data(using: .utf8) else {
            throw DurableStreamError.badRequest(message: "Invalid UTF-8 string")
        }
        return try await appendSync(data)
    }

    /// Append an encodable value as JSON.
    public func appendSync<T: Encodable>(_ value: T, encoder: JSONEncoder = JSONEncoder()) async throws -> AppendResult {
        // For JSON mode, wrap in array
        let isJSON = contentType?.isJSONContentType ?? false
        let data: Data
        if isJSON {
            data = try encoder.encode([value])
        } else {
            data = try encoder.encode(value)
        }
        return try await appendSync(data, contentType: "application/json")
    }

    /// Append raw data with producer headers.
    public func appendWithProducer(
        _ data: Data,
        producerId: String,
        epoch: Int,
        seq: Int,
        contentType: String? = nil
    ) async throws -> AppendResult {
        let ct = contentType ?? self.contentType ?? "application/octet-stream"

        let headers: [String: String] = [
            Headers.producerId: producerId,
            Headers.producerEpoch: String(epoch),
            Headers.producerSeq: String(seq)
        ]

        let request = await httpClient.buildRequest(
            url: url,
            method: "POST",
            headers: headers,
            body: data,
            contentType: ct
        )

        let (responseData, metadata) = try await httpClient.perform(request)

        // Handle producer-specific errors
        switch metadata.status {
        case 200, 204:
            let isDuplicate = metadata.status == 204
            let offset = metadata.offset ?? lastOffset ?? Offset(rawValue: "0")
            lastOffset = offset
            return AppendResult(offset: offset, isDuplicate: isDuplicate)

        case 403:
            if let currentEpoch = metadata.producerEpoch {
                throw DurableStreamError.staleEpoch(producerId: producerId, currentEpoch: currentEpoch)
            }
            throw DurableStreamError.forbidden(message: "Stale epoch")

        case 409:
            if let expected = metadata.producerExpectedSeq, let received = metadata.producerReceivedSeq {
                throw DurableStreamError.sequenceGap(expected: expected, received: received)
            }
            let body = String(data: responseData, encoding: .utf8)
            throw DurableStreamError.conflict(message: body ?? "Sequence conflict")

        default:
            let body = String(data: responseData, encoding: .utf8)
            throw DurableStreamError.fromHTTPStatus(metadata.status, body: body)
        }
    }

    // MARK: - Flush and Close

    /// Flush any pending batched writes.
    /// Note: DurableStream uses synchronous writes. For batched writes with
    /// fire-and-forget semantics, use IdempotentProducer instead.
    @discardableResult
    public func flush() async throws -> FlushResult {
        return FlushResult(offset: lastOffset ?? Offset(rawValue: "0"))
    }

    /// Close the handle.
    public func close() async throws {
        _ = try await flush()
        batchTask?.cancel()
    }

    // MARK: - SSE Streaming

    /// Stream JSON messages using Server-Sent Events.
    ///
    /// SSE provides a persistent connection for real-time updates.
    /// Use long-poll (`messages()`) unless you specifically need SSE.
    ///
    /// Note: SSE streaming uses polling-based implementation for cross-platform
    /// compatibility. For true persistent connections on Apple platforms,
    /// consider using platform-specific URLSession APIs directly.
    ///
    /// ```swift
    /// for try await message in handle.messagesSSE(as: ChatMessage.self) {
    ///     print("Received: \(message)")
    /// }
    /// ```
    public func messagesSSE<T: Decodable & Sendable>(
        as type: T.Type,
        from offset: Offset = .start,
        decoder: JSONDecoder = JSONDecoder()
    ) -> AsyncThrowingStream<T, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await event in self.sseEvents(from: offset) {
                        if Task.isCancelled { break }
                        guard event.effectiveEvent == "message" else {
                            continue
                        }

                        guard let data = event.data.data(using: .utf8) else {
                            continue
                        }

                        let item = try decoder.decode(T.self, from: data)
                        continuation.yield(item)
                    }
                    continuation.finish()
                } catch {
                    if !Task.isCancelled {
                        continuation.finish(throwing: error)
                    } else {
                        continuation.finish()
                    }
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Stream raw SSE events from the stream.
    ///
    /// Uses SSE live mode to receive server-sent events. Events are parsed
    /// per the EventSource specification.
    public func sseEvents(from offset: Offset = .start) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                await self.runSSELoop(from: offset, continuation: continuation)
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Internal SSE streaming loop.
    /// Uses true streaming to receive SSE events as they arrive.
    private func runSSELoop(
        from offset: Offset,
        continuation: AsyncThrowingStream<SSEEvent, Error>.Continuation
    ) async {
        var currentOffset = offset
        var retryAttempt = 0
        let retryConfig = RetryConfig.default

        while !Task.isCancelled {
            do {
                let queryParams: [String: String] = [
                    QueryParams.offset: currentOffset.rawValue,
                    QueryParams.live: "sse"
                ]

                let requestURL = try await httpClient.buildURL(base: url, params: queryParams)
                var request = await httpClient.buildRequest(url: requestURL)
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

                // Use streaming to receive bytes as they arrive
                let (bytes, metadata) = try await httpClient.performStreaming(request)

                switch metadata.status {
                case 200:
                    retryAttempt = 0  // Reset retry count on success

                    // Stream and parse SSE events incrementally
                    var lineBuffer = Data()
                    var currentEvent = SSEEventBuilder()

                    for try await byte in bytes {
                        if Task.isCancelled { break }

                        if byte == 0x0A { // LF - end of line
                            let line = String(data: lineBuffer, encoding: .utf8) ?? ""
                            lineBuffer = Data()

                            if line.isEmpty {
                                // Empty line = end of event
                                if let event = currentEvent.build() {
                                    continuation.yield(event)

                                    // Update offset from control events
                                    if event.effectiveEvent == "control",
                                       let jsonData = event.data.data(using: .utf8),
                                       let control = try? JSONDecoder().decode(SSEControlPayload.self, from: jsonData) {
                                        currentOffset = Offset(rawValue: control.streamNextOffset)
                                    }
                                }
                                currentEvent = SSEEventBuilder()
                            } else {
                                // Parse the line
                                currentEvent.parseLine(line)
                            }
                        } else if byte != 0x0D { // Skip CR
                            lineBuffer.append(byte)
                        }
                    }

                    // Handle any remaining partial event
                    if let event = currentEvent.build() {
                        continuation.yield(event)
                    }

                    // Update offset from response headers if available
                    if let newOffset = metadata.offset {
                        currentOffset = newOffset
                    }

                case 204:
                    // No new data, continue polling
                    retryAttempt = 0  // Timeout is normal, reset retry count
                    continue

                case 410:
                    continuation.finish(throwing: DurableStreamError.retentionExpired(offset: currentOffset))
                    return

                default:
                    continuation.finish(throwing: DurableStreamError.fromHTTPStatus(metadata.status, body: nil))
                    return
                }
            } catch let error as DurableStreamError {
                if error.code == .timeout || error.code == .serverBusy {
                    retryAttempt += 1
                    let delayMs = retryConfig.delayForAttempt(retryAttempt)
                    try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                    continue
                }
                continuation.finish(throwing: error)
                return
            } catch is CancellationError {
                continuation.finish()
                return
            } catch {
                continuation.finish(throwing: error)
                return
            }
        }

        continuation.finish()
    }
}

/// Helper to build SSE events incrementally.
private struct SSEEventBuilder {
    var event: String?
    var data: [String] = []
    var id: String?
    var retry: Int?

    mutating func parseLine(_ line: String) {
        if line.hasPrefix("event:") {
            event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        } else if line.hasPrefix("data:") {
            data.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
        } else if line.hasPrefix("id:") {
            id = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        } else if line.hasPrefix("retry:") {
            retry = Int(String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces))
        } else if line.hasPrefix(":") {
            // Comment, ignore
        }
    }

    func build() -> SSEEvent? {
        guard !data.isEmpty || event != nil else { return nil }
        return SSEEvent(
            event: event,
            data: data.joined(separator: "\n"),
            id: id,
            retry: retry
        )
    }
}

/// Payload for SSE control events.
private struct SSEControlPayload: Codable {
    let streamNextOffset: String
    var streamCursor: String?
    var upToDate: Bool?
}

/// Result of a stream read operation.
public struct StreamReadResult: Sendable {
    public let data: Data
    public let offset: Offset
    public let upToDate: Bool
    public let cursor: String?
    public let contentType: String?
    public let status: Int

    public init(data: Data, offset: Offset, upToDate: Bool, cursor: String? = nil, contentType: String? = nil, status: Int = 200) {
        self.data = data
        self.offset = offset
        self.upToDate = upToDate
        self.cursor = cursor
        self.contentType = contentType
        self.status = status
    }
}
