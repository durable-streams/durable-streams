// SPDX-License-Identifier: MIT
// DurableStreams Swift Client - HTTP Client

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Response metadata extracted from HTTP response headers.
struct ResponseMetadata: Sendable {
    /// Next offset to read from
    let offset: Offset?

    /// Cursor for CDN collapsing
    let cursor: String?

    /// Whether stream is up-to-date
    let upToDate: Bool

    /// ETag for caching
    let etag: String?

    /// Content type
    let contentType: String?

    /// HTTP status code
    let status: Int

    /// Producer epoch from server
    let producerEpoch: Int?

    /// Producer sequence from server
    let producerSeq: Int?

    /// Expected sequence on 409
    let producerExpectedSeq: Int?

    /// Received sequence on 409
    let producerReceivedSeq: Int?

    /// Whether the stream is closed (EOF)
    let streamClosed: Bool

    /// SSE data encoding from response header (e.g., "base64")
    let sseDataEncoding: String?

    init(from response: HTTPURLResponse) {
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
        self.streamClosed = response.value(forHTTPHeaderField: Headers.streamClosed)?.lowercased() == "true"
        self.sseDataEncoding = response.value(forHTTPHeaderField: Headers.sseDataEncoding)
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
        contentType: String? = nil,
        timeout: TimeInterval? = nil
    ) async -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method

        // Set timeout if provided
        if let timeout = timeout {
            request.timeoutInterval = timeout
        }

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
            throw DurableStreamError.fromHTTPStatus(metadata.status, body: body, url: request.url)
        }

        return (data, metadata)
    }

    /// Perform a streaming request and return an async byte sequence with metadata.
    /// This is used for SSE where we need to process bytes as they arrive.
    /// Works cross-platform (including Linux) using a delegate-based approach.
    func performStreaming(_ request: URLRequest) async throws -> (AsyncThrowingStream<UInt8, Error>, ResponseMetadata) {
        let streamingDelegate = StreamingDelegate()
        let delegateSession = URLSession(configuration: .default, delegate: streamingDelegate, delegateQueue: nil)

        let task = delegateSession.dataTask(with: request)
        streamingDelegate.setTask(task)
        task.resume()

        // Wait for the response headers
        let metadata = try await streamingDelegate.waitForHeaders()

        // Return the byte stream
        return (streamingDelegate.byteStream, metadata)
    }
}

/// Delegate-based streaming for cross-platform SSE support.
/// This works on both Apple platforms and Linux.
final class StreamingDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private var continuation: AsyncThrowingStream<UInt8, Error>.Continuation?
    private var headersContinuation: CheckedContinuation<ResponseMetadata, Error>?
    private var response: HTTPURLResponse?
    private var task: URLSessionDataTask?
    private let lock = NSLock()

    let byteStream: AsyncThrowingStream<UInt8, Error>

    override init() {
        var cont: AsyncThrowingStream<UInt8, Error>.Continuation?
        byteStream = AsyncThrowingStream { cont = $0 }
        super.init()
        self.continuation = cont
    }

    func setTask(_ task: URLSessionDataTask) {
        lock.lock()
        self.task = task
        lock.unlock()
    }

    func waitForHeaders() async throws -> ResponseMetadata {
        try await withCheckedThrowingContinuation { cont in
            lock.lock()
            if let response = self.response {
                lock.unlock()
                cont.resume(returning: ResponseMetadata(from: response))
            } else {
                self.headersContinuation = cont
                lock.unlock()
            }
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        if let httpResponse = response as? HTTPURLResponse {
            self.response = httpResponse
            let metadata = ResponseMetadata(from: httpResponse)
            headersContinuation?.resume(returning: metadata)
            headersContinuation = nil
        }
        lock.unlock()
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        let cont = continuation
        lock.unlock()

        for byte in data {
            cont?.yield(byte)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let cont = continuation
        let headersCont = headersContinuation
        continuation = nil
        headersContinuation = nil
        lock.unlock()

        if let error = error {
            let dsError: DurableStreamError
            if let urlError = error as? URLError {
                if urlError.code == .timedOut {
                    dsError = DurableStreamError.timeout()
                } else {
                    dsError = DurableStreamError.networkError(urlError)
                }
            } else {
                dsError = DurableStreamError.networkError(error)
            }
            cont?.finish(throwing: dsError)
            headersCont?.resume(throwing: dsError)
        } else {
            cont?.finish()
        }
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
