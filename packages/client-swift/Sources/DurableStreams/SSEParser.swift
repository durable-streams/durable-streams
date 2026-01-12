// SPDX-License-Identifier: Apache-2.0
// DurableStreams Swift Client - SSE Parser

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A parsed Server-Sent Event.
public struct SSEEvent: Sendable {
    /// Event type (nil defaults to "message")
    public let event: String?

    /// Event data (may contain newlines)
    public let data: String

    /// Event ID for resumption
    public let id: String?

    /// Reconnection time in milliseconds (if specified by server)
    public let retry: Int?

    public init(event: String? = nil, data: String, id: String? = nil, retry: Int? = nil) {
        self.event = event
        self.data = data
        self.id = id
        self.retry = retry
    }

    /// The effective event type (defaults to "message" if not specified)
    public var effectiveEvent: String {
        event ?? "message"
    }
}

/// Parses Server-Sent Events from raw data.
///
/// Follows the EventSource specification:
/// - Lines starting with ":" are comments (ignored)
/// - "event:" sets the event type
/// - "data:" appends to the data buffer (multiple data lines joined with \n)
/// - "id:" sets the event ID
/// - "retry:" sets the reconnection time
/// - Empty line dispatches the event
public struct SSEParser: Sendable {

    /// Parse SSE events from data.
    /// Returns parsed events and any remaining incomplete data.
    public static func parse(data: Data, pendingData: Data = Data()) -> (events: [SSEEvent], remaining: Data) {
        var combined = pendingData
        combined.append(data)

        guard let text = String(data: combined, encoding: .utf8) else {
            return ([], combined)
        }

        var events: [SSEEvent] = []
        var eventType: String? = nil
        var dataBuffer: [String] = []
        var eventId: String? = nil
        var retryMs: Int? = nil

        // Split into lines
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)

        for (index, line) in lines.enumerated() {
            let lineStr = String(line)

            // Check if this is the last line and it doesn't end with newline
            // (meaning it's potentially incomplete)
            let isLastLine = index == lines.count - 1
            let textEndsWithNewline = text.hasSuffix("\n")

            if isLastLine && !textEndsWithNewline && !lineStr.isEmpty {
                // This line might be incomplete, save it for next parse
                break
            }

            // Empty line = dispatch event
            if lineStr.isEmpty {
                if !dataBuffer.isEmpty {
                    let event = SSEEvent(
                        event: eventType,
                        data: dataBuffer.joined(separator: "\n"),
                        id: eventId,
                        retry: retryMs
                    )
                    events.append(event)
                }
                // Reset for next event
                eventType = nil
                dataBuffer = []
                // Note: id and retry persist across events per spec
                continue
            }

            // Comment line (starts with :)
            if lineStr.hasPrefix(":") {
                continue
            }

            // Parse field:value
            let (field, value) = parseLine(lineStr)

            switch field {
            case "event":
                eventType = value
            case "data":
                dataBuffer.append(value)
            case "id":
                // Per spec, id cannot contain null
                if !value.contains("\0") {
                    eventId = value
                }
            case "retry":
                if let ms = Int(value) {
                    retryMs = ms
                }
            default:
                // Unknown field, ignore per spec
                break
            }
        }

        // Return any incomplete data at the end
        let remaining: Data
        if let lastLineStart = text.range(of: "\n", options: .backwards)?.upperBound,
           !text.hasSuffix("\n") {
            let remainingText = String(text[lastLineStart...])
            remaining = remainingText.data(using: .utf8) ?? Data()
        } else if !text.hasSuffix("\n") && events.isEmpty {
            remaining = combined
        } else {
            remaining = Data()
        }

        return (events, remaining)
    }

    /// Parse a line into field and value.
    /// Per spec: "field: value" or "field:value" or "field:" or "field"
    private static func parseLine(_ line: String) -> (field: String, value: String) {
        guard let colonIndex = line.firstIndex(of: ":") else {
            // No colon - entire line is field name, value is empty
            return (line, "")
        }

        let field = String(line[..<colonIndex])
        var value = String(line[line.index(after: colonIndex)...])

        // Remove single leading space from value if present
        if value.hasPrefix(" ") {
            value = String(value.dropFirst())
        }

        return (field, value)
    }
}

// MARK: - SSE Streaming Extension for StreamResponse

extension StreamResponse {
    /// Parse SSE events from response data.
    /// Use this for responses that contain SSE-formatted data.
    public func sseEvents() -> [SSEEvent] {
        let (events, _) = SSEParser.parse(data: data)
        return events
    }
}
