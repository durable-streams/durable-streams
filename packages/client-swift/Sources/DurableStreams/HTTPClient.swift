// SPDX-License-Identifier: Apache-2.0
// DurableStreams Swift Client - HTTP Client

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Response metadata extracted from HTTP response headers.
public struct ResponseMetadata: Sendable {
    /// Next offset to read from
    public let offset: Offset?

    /// Cursor for CDN collapsing
    public let cursor: String?

    /// Whether stream is up-to-date
    public let upToDate: Bool

    /// ETag for caching
    public let etag: String?

    /// Content type
    public let contentType: String?

    /// HTTP status code
    public let status: Int

    /// Producer epoch from server
    public let producerEpoch: Int?

    /// Producer sequence from server
    public let producerSeq: Int?

    /// Expected sequence on 409
    public let producerExpectedSeq: Int?

    /// Received sequence on 409
    public let producerReceivedSeq: Int?

    public init(from response: HTTPURLResponse) {
        self.status = response.statusCode
        self.offset = response.value(forHTTPHeaderField: Headers.streamNextOffset).map { Offset(rawValue: $0) }
        self.cursor = response.value(forHTTPHeaderField: Headers.streamCursor)
        self.upToDate = response.value(forHTTPHeaderField: Headers.streamUpToDate) != nil
        self.etag = response.value(forHTTPHeaderField: "ETag")
        self.contentType = response.value(forHTTPHeaderField: "Content-Type")
        self.producerEpoch = response.value(forHTTPHeaderField: Headers.producerEpoch).flatMap { Int($0) }
        self.producerSeq = response.value(forHTTPHeaderField: Headers.producerSeq).flatMap { Int($0) }
        self.producerExpectedSeq = response.value(forHTTPHeaderField: Headers.producerExpectedSeq).flatMap { Int($0) }
        self.producerReceivedSeq = response.value(forHTTPHeaderField: Headers.producerReceivedSeq).flatMap { Int($0) }
    }
}

/// Internal HTTP client wrapper with common functionality.
internal actor HTTPClient {
    let session: URLSession
    let baseHeaders: HeadersRecord
    let baseParams: ParamsRecord

    init(
        session: URLSession = .shared,
        headers: HeadersRecord = [:],
        params: ParamsRecord = [:]
    ) {
        self.session = session
        self.baseHeaders = headers
        self.baseParams = params
    }

    /// Build a URL with query parameters.
    /// - Throws: `DurableStreamError.badRequest` if the URL cannot be constructed
    func buildURL(
        base: URL,
        params: [String: String] = [:],
        additionalParams: ParamsRecord = [:]
    ) async throws -> URL {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: true) else {
            throw DurableStreamError.badRequest(message: "Invalid base URL: \(base)")
        }
        var queryItems = components.queryItems ?? []

        // Add static params
        for (key, value) in params {
            queryItems.append(URLQueryItem(name: key, value: value))
        }

        // Add base params
        for (key, value) in baseParams {
            let resolvedValue = await value.resolve()
            queryItems.append(URLQueryItem(name: key, value: resolvedValue))
        }

        // Add additional params
        for (key, value) in additionalParams {
            let resolvedValue = await value.resolve()
            queryItems.append(URLQueryItem(name: key, value: resolvedValue))
        }

        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }

        guard let url = components.url else {
            throw DurableStreamError.badRequest(message: "Cannot construct URL from components")
        }
        return url
    }

    /// Build a URLRequest with headers.
    func buildRequest(
        url: URL,
        method: String = "GET",
        headers: [String: String] = [:],
        additionalHeaders: HeadersRecord = [:],
        body: Data? = nil,
        contentType: String? = nil
    ) async -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method

        // Add static headers
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }

        // Add base headers
        for (key, value) in baseHeaders {
            let resolvedValue = await value.resolve()
            request.setValue(resolvedValue, forHTTPHeaderField: key)
        }

        // Add additional headers
        for (key, value) in additionalHeaders {
            let resolvedValue = await value.resolve()
            request.setValue(resolvedValue, forHTTPHeaderField: key)
        }

        // Set content type if provided
        if let contentType = contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }

        // Set body
        request.httpBody = body

        return request
    }

    /// Perform a request and return data with metadata.
    func perform(_ request: URLRequest) async throws -> (Data, ResponseMetadata) {
        do {
            let (data, response) = try await session.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw DurableStreamError.networkError(URLError(.badServerResponse))
            }

            let metadata = ResponseMetadata(from: httpResponse)
            return (data, metadata)
        } catch let error as DurableStreamError {
            throw error
        } catch let urlError as URLError {
            if urlError.code == .timedOut {
                throw DurableStreamError.timeout()
            }
            throw DurableStreamError.networkError(urlError)
        } catch {
            throw DurableStreamError.networkError(error)
        }
    }

    /// Perform a request and check for success.
    func performChecked(_ request: URLRequest, expectedStatus: Set<Int> = [200, 201, 204]) async throws -> (Data, ResponseMetadata) {
        let (data, metadata) = try await perform(request)

        guard expectedStatus.contains(metadata.status) else {
            let body = String(data: data, encoding: .utf8)
            throw DurableStreamError.fromHTTPStatus(metadata.status, body: body)
        }

        return (data, metadata)
    }
}

/// Extension for normalizing content types.
extension String {
    /// Normalize content type by extracting media type and lowercasing.
    func normalizedContentType() -> String {
        let mediaType = self.split(separator: ";").first ?? Substring(self)
        return String(mediaType).trimmingCharacters(in: .whitespaces).lowercased()
    }

    /// Check if this content type indicates JSON.
    var isJSONContentType: Bool {
        let normalized = self.normalizedContentType()
        return normalized == "application/json" || normalized.hasSuffix("+json")
    }
}
