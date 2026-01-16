// SPDX-License-Identifier: MIT
// DurableStreams Swift Client - Core Types

import Foundation

/// Represents a position in a Durable Stream.
/// Offsets are opaque strings that can be compared lexicographically.
public struct Offset: Sendable, Hashable, Comparable, Codable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let rawValue: String

    /// Start of stream (returns all messages)
    public static let start = Offset(rawValue: "-1")

    /// Current tail (only new messages)
    public static let now = Offset(rawValue: "now")

    /// Create from a raw offset string (typically from a previous read)
    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        self.rawValue = value
    }

    public static func < (lhs: Offset, rhs: Offset) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public var description: String { rawValue }
}

/// Specifies how the client should handle real-time updates.
///
/// - `catchUp`: Read existing data only, stop at end of stream
/// - `longPoll`: HTTP long-polling for updates (CDN-friendly)
/// - `sse`: Server-Sent Events for persistent connection
public enum LiveMode: Sendable, Equatable, CaseIterable {
    /// Read existing data only, stop at end of stream
    case catchUp

    /// HTTP long-polling for updates (CDN-friendly)
    case longPoll

    /// Server-Sent Events for persistent connection
    case sse

    var queryValue: String? {
        switch self {
        case .catchUp: return nil
        case .longPoll: return "long-poll"
        case .sse: return "sse"
        }
    }
}

/// A batch of JSON messages from the stream.
///
/// Conforms to `Sequence` so you can iterate directly:
/// ```swift
/// for item in batch {
///     process(item)
/// }
/// ```
public struct JsonBatch<T: Sendable>: Sendable, Sequence {
    /// The decoded messages
    public let items: [T]

    /// Offset after the last message (use for resumption)
    public let offset: Offset

    /// True if caught up to the current tail
    public let upToDate: Bool

    /// Cursor for CDN cache collapsing
    public let cursor: String?

    public init(items: [T], offset: Offset, upToDate: Bool, cursor: String? = nil) {
        self.items = items
        self.offset = offset
        self.upToDate = upToDate
        self.cursor = cursor
    }

    // MARK: - Sequence Conformance

    public func makeIterator() -> IndexingIterator<[T]> {
        items.makeIterator()
    }

    /// Number of items in the batch
    public var count: Int { items.count }

    /// Whether the batch is empty
    public var isEmpty: Bool { items.isEmpty }

    /// First item in the batch, if any
    public var first: T? { items.first }

    /// Last item in the batch, if any
    public var last: T? { items.last }
}

/// A chunk of bytes from the stream.
public struct ByteChunk: Sendable, Equatable {
    /// Raw byte data
    public let data: Data

    /// Offset after this chunk
    public let offset: Offset

    /// True if caught up to the current tail
    public let upToDate: Bool

    /// Cursor for CDN cache collapsing
    public let cursor: String?

    public init(data: Data, offset: Offset, upToDate: Bool, cursor: String? = nil) {
        self.data = data
        self.offset = offset
        self.upToDate = upToDate
        self.cursor = cursor
    }
}

/// A chunk of text from the stream.
public struct TextChunk: Sendable, Equatable {
    /// UTF-8 decoded text
    public let text: String

    /// Offset after this chunk
    public let offset: Offset

    /// True if caught up to the current tail
    public let upToDate: Bool

    /// Cursor for CDN cache collapsing
    public let cursor: String?

    public init(text: String, offset: Offset, upToDate: Bool, cursor: String? = nil) {
        self.text = text
        self.offset = offset
        self.upToDate = upToDate
        self.cursor = cursor
    }
}

/// Result of accumulating text content.
public struct TextResult: Sendable, Equatable {
    public let text: String
    public let offset: Offset
    public let upToDate: Bool

    public init(text: String, offset: Offset, upToDate: Bool) {
        self.text = text
        self.offset = offset
        self.upToDate = upToDate
    }
}

/// Result of accumulating byte content.
public struct ByteResult: Sendable, Equatable {
    public let data: Data
    public let offset: Offset
    public let upToDate: Bool

    public init(data: Data, offset: Offset, upToDate: Bool) {
        self.data = data
        self.offset = offset
        self.upToDate = upToDate
    }
}

/// Metadata about a Durable Stream.
public struct StreamInfo: Sendable {
    /// Current tail offset
    public let offset: Offset?

    /// Content type of the stream
    public let contentType: String?

    /// ETag for conditional requests
    public let etag: String?

    /// Cache control headers
    public let cacheControl: String?

    public init(offset: Offset?, contentType: String?, etag: String? = nil, cacheControl: String? = nil) {
        self.offset = offset
        self.contentType = contentType
        self.etag = etag
        self.cacheControl = cacheControl
    }

    /// Whether the stream exists (has an offset)
    public var exists: Bool { offset != nil }

    /// Whether the stream is empty (exists but has no data)
    public var isEmpty: Bool { offset == .start }

    /// Whether the stream has data
    public var hasData: Bool { exists && !isEmpty }
}

/// Result of an append operation.
public struct AppendResult: Sendable, Equatable {
    /// The offset assigned to the appended data
    public let offset: Offset

    /// Whether this was a duplicate (idempotent producer detected)
    public let isDuplicate: Bool

    public init(offset: Offset, isDuplicate: Bool = false) {
        self.offset = offset
        self.isDuplicate = isDuplicate
    }
}

/// Result of a flush operation.
public struct FlushResult: Sendable, Equatable {
    /// The offset after all flushed data
    public let offset: Offset

    /// Number of batches that were duplicates
    public let duplicateCount: Int

    public init(offset: Offset, duplicateCount: Int = 0) {
        self.offset = offset
        self.duplicateCount = duplicateCount
    }
}

/// Type alias for headers that can be static or dynamic
public typealias HeadersRecord = [String: HeaderValue]

/// A header value that can be static or evaluated per-request
public enum HeaderValue: Sendable {
    case `static`(String)
    case dynamic(@Sendable () async -> String)

    public static func value(_ string: String) -> HeaderValue {
        .static(string)
    }

    public static func provider(_ closure: @escaping @Sendable () async -> String) -> HeaderValue {
        .dynamic(closure)
    }

    func resolve() async -> String {
        switch self {
        case .static(let value):
            return value
        case .dynamic(let provider):
            return await provider()
        }
    }
}

extension HeaderValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        self = .static(value)
    }
}

/// Type alias for params that can be static or dynamic
public typealias ParamsRecord = [String: ParamValue]

/// A param value that can be static or evaluated per-request
public enum ParamValue: Sendable {
    case `static`(String)
    case dynamic(@Sendable () async -> String)

    public static func value(_ string: String) -> ParamValue {
        .static(string)
    }

    public static func provider(_ closure: @escaping @Sendable () async -> String) -> ParamValue {
        .dynamic(closure)
    }

    func resolve() async -> String {
        switch self {
        case .static(let value):
            return value
        case .dynamic(let provider):
            return await provider()
        }
    }
}

extension ParamValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        self = .static(value)
    }
}
