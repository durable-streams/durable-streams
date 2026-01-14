// SPDX-License-Identifier: MIT
// DurableStreams Swift Client - Stream API (Read-Only)

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Options for the stream() function.
public struct StreamOptions: Sendable {
    /// The stream URL
    public var url: URL

    /// Starting offset
    public var offset: Offset

    /// Live mode
    public var live: LiveMode

    /// Custom headers
    public var headers: HeadersRecord

    /// Custom params
    public var params: ParamsRecord

    /// URLSession to use
    public var session: URLSession

    /// Request timeout
    public var timeout: TimeInterval

    public init(
        url: URL,
        offset: Offset = .start,
        live: LiveMode = .auto,
        headers: HeadersRecord = [:],
        params: ParamsRecord = [:],
        session: URLSession = .shared,
        timeout: TimeInterval = 30
    ) {
        self.url = url
        self.offset = offset
        self.live = live
        self.headers = headers
        self.params = params
        self.session = session
        self.timeout = timeout
    }
}

/// Simple stream function for read-only access.
///
/// This provides a fetch-like interface for reading streams without
/// establishing a persistent handle.
public func stream(
    url: URL,
    offset: Offset = .start,
    live: LiveMode = .auto,
    headers: HeadersRecord = [:],
    params: ParamsRecord = [:],
    session: URLSession = .shared
) async throws -> StreamResponse {
    let options = StreamOptions(
        url: url,
        offset: offset,
        live: live,
        headers: headers,
        params: params,
        session: session
    )
    return try await stream(options)
}

/// Stream with full options.
public func stream(_ options: StreamOptions) async throws -> StreamResponse {
    let httpClient = HTTPClient(
        session: options.session,
        headers: options.headers,
        params: options.params
    )

    // Build URL with offset and live params
    var queryParams: [String: String] = [
        QueryParams.offset: options.offset.rawValue
    ]

    // Determine effective live mode
    let effectiveLive = options.live == .auto ? .catchUp : options.live

    if let liveValue = effectiveLive.queryValue, effectiveLive != .catchUp {
        queryParams[QueryParams.live] = liveValue
    }

    let requestURL = try await httpClient.buildURL(base: options.url, params: queryParams)
    let request = await httpClient.buildRequest(url: requestURL, timeout: options.timeout)

    let (data, metadata) = try await httpClient.performChecked(request, expectedStatus: [200, 204])

    // Create streaming context for continuation
    let streamingContext = StreamingContext(
        url: options.url,
        session: options.session,
        headers: options.headers,
        params: options.params,
        timeout: options.timeout
    )

    return StreamResponse(
        data: data,
        offset: metadata.offset ?? options.offset,
        upToDate: metadata.upToDate,
        cursor: metadata.cursor,
        contentType: metadata.contentType,
        status: metadata.status,
        startOffset: options.offset,
        live: options.live,
        streamingContext: streamingContext
    )
}

/// Context needed for streaming continuation.
internal struct StreamingContext: Sendable {
    let url: URL
    let session: URLSession
    let headers: HeadersRecord
    let params: ParamsRecord
    let timeout: TimeInterval
}

/// Response from a stream request.
public struct StreamResponse: Sendable {
    /// Raw response data
    public let data: Data

    /// Offset after the response (use for resumption)
    public let offset: Offset

    /// Whether caught up to current tail
    public let upToDate: Bool

    /// Cursor for CDN collapsing
    public let cursor: String?

    /// Content type
    public let contentType: String?

    /// HTTP status code
    public let status: Int

    /// Starting offset used for this request
    public let startOffset: Offset

    /// Live mode used for this request
    public let live: LiveMode

    /// Context for streaming continuation (internal)
    internal let streamingContext: StreamingContext?

    public init(
        data: Data,
        offset: Offset,
        upToDate: Bool,
        cursor: String? = nil,
        contentType: String? = nil,
        status: Int = 200,
        startOffset: Offset = .start,
        live: LiveMode = .auto
    ) {
        self.data = data
        self.offset = offset
        self.upToDate = upToDate
        self.cursor = cursor
        self.contentType = contentType
        self.status = status
        self.startOffset = startOffset
        self.live = live
        self.streamingContext = nil
    }

    /// Internal initializer with streaming context for continuation.
    internal init(
        data: Data,
        offset: Offset,
        upToDate: Bool,
        cursor: String?,
        contentType: String?,
        status: Int,
        startOffset: Offset,
        live: LiveMode,
        streamingContext: StreamingContext?
    ) {
        self.data = data
        self.offset = offset
        self.upToDate = upToDate
        self.cursor = cursor
        self.contentType = contentType
        self.status = status
        self.startOffset = startOffset
        self.live = live
        self.streamingContext = streamingContext
    }

    // MARK: - Accumulators

    /// Get accumulated JSON items with metadata.
    public func json<T: Decodable>(as type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> JsonBatch<T> {
        if data.isEmpty {
            return JsonBatch(items: [], offset: offset, upToDate: upToDate, cursor: cursor)
        }

        let items = try decoder.decode([T].self, from: data)
        return JsonBatch(items: items, offset: offset, upToDate: upToDate, cursor: cursor)
    }

    /// Get accumulated text with metadata.
    public func text() -> TextResult {
        let text = String(data: data, encoding: .utf8) ?? ""
        return TextResult(text: text, offset: offset, upToDate: upToDate)
    }

    /// Get accumulated bytes with metadata.
    public func bytes() -> ByteResult {
        return ByteResult(data: data, offset: offset, upToDate: upToDate)
    }

    // MARK: - Streaming (AsyncSequence)

    /// Stream JSON batches as they arrive.
    /// Uses long-poll for live updates when `live` mode is `.longPoll` or `.auto`.
    ///
    /// Each batch includes the offset for checkpointing:
    /// ```swift
    /// for try await batch in response.jsonStream(as: MyMessage.self) {
    ///     for message in batch.items {
    ///         await process(message)
    ///     }
    ///     saveCheckpoint(batch.offset)
    /// }
    /// ```
    public func jsonStream<T: Decodable & Sendable>(
        as type: T.Type,
        decoder: JSONDecoder = JSONDecoder()
    ) -> AsyncThrowingStream<JsonBatch<T>, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                await self.runLongPollLoop(
                    continuation: continuation,
                    transform: { data, offset, upToDate, cursor in
                        if data.isEmpty {
                            return JsonBatch<T>(items: [], offset: offset, upToDate: upToDate, cursor: cursor)
                        }
                        let items = try decoder.decode([T].self, from: data)
                        return JsonBatch<T>(items: items, offset: offset, upToDate: upToDate, cursor: cursor)
                    }
                )
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    /// Stream individual JSON items (flattens batches).
    /// Note: Use `jsonStream()` if you need per-batch offset tracking.
    ///
    /// ```swift
    /// for try await message in response.jsonItems(as: MyMessage.self) {
    ///     await process(message)
    /// }
    /// ```
    public func jsonItems<T: Decodable & Sendable>(
        as type: T.Type,
        decoder: JSONDecoder = JSONDecoder()
    ) -> AsyncThrowingStream<T, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await batch in self.jsonStream(as: type, decoder: decoder) {
                        if Task.isCancelled { break }
                        for item in batch {
                            continuation.yield(item)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    /// Stream byte chunks as they arrive.
    public func byteStream() -> AsyncThrowingStream<ByteChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                await self.runLongPollLoop(
                    continuation: continuation,
                    transform: { data, offset, upToDate, cursor in
                        ByteChunk(data: data, offset: offset, upToDate: upToDate, cursor: cursor)
                    }
                )
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    /// Stream text chunks as they arrive.
    public func textStream() -> AsyncThrowingStream<TextChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                await self.runLongPollLoop(
                    continuation: continuation,
                    transform: { data, offset, upToDate, cursor in
                        let text = String(data: data, encoding: .utf8) ?? ""
                        return TextChunk(text: text, offset: offset, upToDate: upToDate, cursor: cursor)
                    }
                )
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    // MARK: - Internal Long-Poll Implementation

    /// Internal long-poll loop that yields results via continuation.
    private func runLongPollLoop<T: Sendable>(
        continuation: AsyncThrowingStream<T, Error>.Continuation,
        transform: @escaping @Sendable (Data, Offset, Bool, String?) throws -> T
    ) async {
        guard let ctx = streamingContext else {
            // No streaming context - just yield the initial response and finish
            do {
                let result = try transform(data, offset, upToDate, cursor)
                continuation.yield(result)
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
            return
        }

        // Yield the initial response first
        do {
            let result = try transform(data, offset, upToDate, cursor)
            continuation.yield(result)
        } catch {
            continuation.finish(throwing: error)
            return
        }

        // Determine effective live mode once
        let effectiveLive = live == .auto ? .longPoll : live

        // If already up-to-date and in catch-up mode, we're done
        if upToDate && effectiveLive == .catchUp {
            continuation.finish()
            return
        }

        // Continue with long-poll loop
        var currentOffset = offset
        var currentCursor = cursor
        var retryAttempt = 0
        let retryConfig = RetryConfig.default

        let httpClient = HTTPClient(
            session: ctx.session,
            headers: ctx.headers,
            params: ctx.params
        )

        while !Task.isCancelled {
            do {
                // Build URL with query parameters per protocol spec
                var queryParams: [String: String] = [
                    QueryParams.offset: currentOffset.rawValue,
                    QueryParams.live: "long-poll"
                ]

                // Echo cursor for CDN collapsing
                if let cursor = currentCursor {
                    queryParams[QueryParams.cursor] = cursor
                }

                let requestURL = try await httpClient.buildURL(base: ctx.url, params: queryParams)
                let request = await httpClient.buildRequest(url: requestURL, timeout: ctx.timeout)

                let (responseData, metadata) = try await httpClient.perform(request)

                switch metadata.status {
                case 200:
                    let newOffset = metadata.offset ?? currentOffset
                    let result = try transform(responseData, newOffset, metadata.upToDate, metadata.cursor)
                    continuation.yield(result)
                    currentOffset = newOffset
                    currentCursor = metadata.cursor
                    retryAttempt = 0  // Reset retry count on success

                    // In catch-up mode, stop when we've caught up
                    if metadata.upToDate && effectiveLive == .catchUp {
                        continuation.finish()
                        return
                    }

                case 204:
                    // Long-poll timeout, retry with same offset
                    retryAttempt = 0  // Timeout is normal, reset retry count
                    continue

                case 410:
                    // Data expired due to retention policy
                    continuation.finish(throwing: DurableStreamError.retentionExpired(offset: currentOffset))
                    return

                default:
                    let body = String(data: responseData, encoding: .utf8)
                    continuation.finish(throwing: DurableStreamError.fromHTTPStatus(metadata.status, body: body, url: requestURL))
                    return
                }
            } catch let error as DurableStreamError {
                // Check if this is a retriable error
                if shouldRetryStreamingError(error) {
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

    /// Determine if an error should be retried in the streaming loop.
    private func shouldRetryStreamingError(_ error: DurableStreamError) -> Bool {
        switch error.code {
        case .timeout, .serverBusy:
            return true
        default:
            return false
        }
    }
}

// MARK: - Convenience Extensions

extension URL {
    /// Create a stream URL from a base URL and path.
    public func appendingStreamPath(_ path: String) -> URL {
        if path.hasPrefix("/") {
            return self.appendingPathComponent(String(path.dropFirst()))
        }
        return self.appendingPathComponent(path)
    }
}
