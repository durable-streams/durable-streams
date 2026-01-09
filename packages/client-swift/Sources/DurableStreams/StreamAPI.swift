// SPDX-License-Identifier: Apache-2.0
// DurableStreams Swift Client - Stream API (Read-Only)

import Foundation

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
        timeout: TimeInterval = Defaults.timeout
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

    let requestURL = await httpClient.buildURL(base: options.url, params: queryParams)
    let request = await httpClient.buildRequest(url: requestURL)

    let (data, metadata) = try await httpClient.performChecked(request, expectedStatus: [200, 204])

    return StreamResponse(
        data: data,
        offset: metadata.offset ?? options.offset,
        upToDate: metadata.upToDate,
        cursor: metadata.cursor,
        contentType: metadata.contentType,
        status: metadata.status,
        startOffset: options.offset,
        live: options.live
    )
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
