// SPDX-License-Identifier: MIT
// DurableStreams Swift Client - Error Types

import Foundation

/// Standard error codes for Durable Streams operations.
public enum ErrorCode: String, Sendable, CaseIterable {
    case notFound = "NOT_FOUND"
    case conflict = "CONFLICT"
    case conflictSeq = "CONFLICT_SEQ"
    case conflictExists = "CONFLICT_EXISTS"
    case badRequest = "BAD_REQUEST"
    case unauthorized = "UNAUTHORIZED"
    case forbidden = "FORBIDDEN"
    case rateLimited = "RATE_LIMITED"
    case serverBusy = "BUSY"
    case sseNotSupported = "SSE_NOT_SUPPORTED"
    case timeout = "TIMEOUT"
    case networkError = "NETWORK_ERROR"
    case parseError = "PARSE_ERROR"
    case internalError = "INTERNAL_ERROR"
    case retentionExpired = "RETENTION_EXPIRED"
    case staleEpoch = "STALE_EPOCH"
    case sequenceGap = "SEQUENCE_GAP"
    case unknown = "UNKNOWN"
}

/// Errors specific to Durable Streams operations.
public struct DurableStreamError: Error, Sendable, Equatable {
    /// The error code
    public let code: ErrorCode

    /// Human-readable error message
    public let message: String

    /// HTTP status code if available
    public let status: Int?

    /// Additional error details
    public let details: [String: String]?

    public init(code: ErrorCode, message: String, status: Int? = nil, details: [String: String]? = nil) {
        self.code = code
        self.message = message
        self.status = status
        self.details = details
    }

    // Convenience initializers for common errors

    public static func notFound(url: URL) -> DurableStreamError {
        DurableStreamError(code: .notFound, message: "Stream not found: \(url)", status: 404)
    }

    public static func conflict(message: String) -> DurableStreamError {
        DurableStreamError(code: .conflict, message: message, status: 409)
    }

    public static func conflictExists(message: String) -> DurableStreamError {
        DurableStreamError(code: .conflictExists, message: message, status: 409)
    }

    public static func unauthorized(message: String) -> DurableStreamError {
        DurableStreamError(code: .unauthorized, message: message, status: 401)
    }

    public static func forbidden(message: String) -> DurableStreamError {
        DurableStreamError(code: .forbidden, message: message, status: 403)
    }

    public static func badRequest(message: String) -> DurableStreamError {
        DurableStreamError(code: .badRequest, message: message, status: 400)
    }

    public static func rateLimited(retryAfter: TimeInterval? = nil) -> DurableStreamError {
        var details: [String: String]? = nil
        if let retryAfter = retryAfter {
            details = ["retryAfter": String(retryAfter)]
        }
        return DurableStreamError(code: .rateLimited, message: "Rate limited", status: 429, details: details)
    }

    public static func serverBusy(retryAfter: TimeInterval? = nil) -> DurableStreamError {
        var details: [String: String]? = nil
        if let retryAfter = retryAfter {
            details = ["retryAfter": String(retryAfter)]
        }
        return DurableStreamError(code: .serverBusy, message: "Server busy", status: 503, details: details)
    }

    public static func staleEpoch(producerId: String, currentEpoch: Int) -> DurableStreamError {
        DurableStreamError(
            code: .staleEpoch,
            message: "Producer epoch is stale",
            status: 403,
            details: ["producerId": producerId, "currentEpoch": String(currentEpoch)]
        )
    }

    public static func sequenceGap(expected: Int, received: Int) -> DurableStreamError {
        DurableStreamError(
            code: .sequenceGap,
            message: "Sequence gap: expected \(expected), received \(received)",
            status: 409,
            details: ["expected": String(expected), "received": String(received)]
        )
    }

    public static func retentionExpired(offset: Offset) -> DurableStreamError {
        DurableStreamError(
            code: .retentionExpired,
            message: "Data at offset \(offset) has expired",
            status: 410,
            details: ["offset": offset.rawValue]
        )
    }

    public static func networkError(_ underlying: Error) -> DurableStreamError {
        DurableStreamError(code: .networkError, message: "Network error: \(underlying.localizedDescription)")
    }

    public static func timeout() -> DurableStreamError {
        DurableStreamError(code: .timeout, message: "Request timed out")
    }

    public static func parseError(_ message: String) -> DurableStreamError {
        DurableStreamError(code: .parseError, message: "Parse error: \(message)")
    }

    public static func fromHTTPStatus(_ status: Int, body: String? = nil, url: URL? = nil) -> DurableStreamError {
        // Use body if provided and not empty, otherwise use HTTP status message
        let hasBody = body != nil && !body!.isEmpty
        let baseMessage = hasBody ? body! : httpStatusMessage(status)
        // Include URL in message for context when no custom body provided
        let message = if let url = url, !hasBody {
            "\(baseMessage): \(url.path)"
        } else {
            baseMessage
        }
        switch status {
        case 400:
            return .badRequest(message: message)
        case 401:
            return .unauthorized(message: message)
        case 403:
            return .forbidden(message: message)
        case 404:
            return DurableStreamError(code: .notFound, message: message, status: status)
        case 409:
            return .conflict(message: message)
        case 410:
            return DurableStreamError(code: .retentionExpired, message: message, status: status)
        case 429:
            return .rateLimited()
        case 503:
            return .serverBusy()
        default:
            return DurableStreamError(code: .unknown, message: message, status: status)
        }
    }

    private static func httpStatusMessage(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 201: return "Created"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 410: return "Gone"
        case 429: return "Too Many Requests"
        case 500: return "Internal Server Error"
        case 503: return "Service Unavailable"
        default: return "HTTP \(status)"
        }
    }
}

extension DurableStreamError: LocalizedError {
    public var errorDescription: String? {
        if let status = status {
            return "[\(code.rawValue)] \(message) (HTTP \(status))"
        }
        return "[\(code.rawValue)] \(message)"
    }
}

extension DurableStreamError: CustomDebugStringConvertible {
    public var debugDescription: String {
        var parts = ["DurableStreamError(\(code.rawValue))"]
        parts.append("message: \"\(message)\"")
        if let status = status {
            parts.append("status: \(status)")
        }
        if let details = details, !details.isEmpty {
            let detailStr = details.map { "\($0.key): \($0.value)" }.joined(separator: ", ")
            parts.append("details: [\(detailStr)]")
        }
        return parts.joined(separator: ", ")
    }
}
