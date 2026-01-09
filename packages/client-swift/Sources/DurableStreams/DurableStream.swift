// SPDX-License-Identifier: Apache-2.0
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

        let (_, metadata) = try await httpClient.performChecked(request, expectedStatus: [201])

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

        let requestURL = await httpClient.buildURL(base: url, params: params)
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
            contentType: metadata.contentType
        )
    }

    /// Read all data as text.
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

    // MARK: - Writing (Synchronous)

    /// Append data to the stream (awaits server acknowledgment).
    public func appendSync(_ data: Data, contentType: String? = nil) async throws -> AppendResult {
        let ct = contentType ?? self.contentType ?? "application/octet-stream"

        let request = await httpClient.buildRequest(
            url: url,
            method: "POST",
            body: data,
            contentType: ct
        )

        let (_, metadata) = try await httpClient.performChecked(request, expectedStatus: [200, 204])

        let isDuplicate = metadata.status == 204
        let offset = metadata.offset ?? lastOffset ?? Offset(rawValue: "0")
        lastOffset = offset

        return AppendResult(offset: offset, isDuplicate: isDuplicate)
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

        var headers: [String: String] = [
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
    public func flush() async throws -> FlushResult {
        // For now, we don't implement client-side batching in this version
        // Batching is handled by IdempotentProducer
        return FlushResult(offset: lastOffset ?? Offset(rawValue: "0"))
    }

    /// Close the handle.
    public func close() async throws {
        _ = try await flush()
        batchTask?.cancel()
    }
}

/// Result of a stream read operation.
public struct StreamReadResult: Sendable {
    public let data: Data
    public let offset: Offset
    public let upToDate: Bool
    public let cursor: String?
    public let contentType: String?

    public init(data: Data, offset: Offset, upToDate: Bool, cursor: String? = nil, contentType: String? = nil) {
        self.data = data
        self.offset = offset
        self.upToDate = upToDate
        self.cursor = cursor
        self.contentType = contentType
    }
}
