// SPDX-License-Identifier: MIT
// DurableStreams Swift Client - Unified Configuration

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Handle Configuration

/// Unified configuration for DurableStream operations.
///
/// Combines HTTP settings, batching behavior, idempotent producer options,
/// and retry policies into a single configuration object.
///
/// ```swift
/// let config = HandleConfiguration(
///     idempotentProducer: .enabled(producerId: "my-producer"),
///     batching: .init(maxBytes: 64_000, lingerMs: 10),
///     http: .init(timeout: .seconds(30))
/// )
///
/// let handle = try await DurableStream.create(url: streamURL, config: config)
/// ```
public struct HandleConfiguration: Sendable {
    /// Idempotent producer settings (nil to disable)
    public var idempotentProducer: IdempotentProducerConfig?

    /// Batching configuration for append operations
    public var batching: BatchingConfig

    /// HTTP client configuration
    public var http: HTTPConfig

    /// Retry policy for operations
    public var retry: RetryConfig

    /// Custom headers for all requests
    public var headers: HeadersRecord

    /// Custom params for all requests
    public var params: ParamsRecord

    /// Default configuration
    public static let `default` = HandleConfiguration()

    public init(
        idempotentProducer: IdempotentProducerConfig? = nil,
        batching: BatchingConfig = .default,
        http: HTTPConfig = .default,
        retry: RetryConfig = .default,
        headers: HeadersRecord = [:],
        params: ParamsRecord = [:]
    ) {
        self.idempotentProducer = idempotentProducer
        self.batching = batching
        self.http = http
        self.retry = retry
        self.headers = headers
        self.params = params
    }
}

// MARK: - Idempotent Producer Configuration

/// Configuration for idempotent producer behavior.
public struct IdempotentProducerConfig: Sendable {
    /// Producer identifier (should be stable across restarts for deduplication)
    public let producerId: String

    /// Starting epoch (auto-incremented on fence errors)
    public var initialEpoch: Int

    /// Automatic epoch increment on 403 Forbidden (stale epoch)
    public var autoClaimOnStaleEpoch: Bool

    /// Error callback for batch failures (since append() is fire-and-forget)
    public var onError: (@Sendable (Error) -> Void)?

    /// Create an enabled idempotent producer configuration.
    public static func enabled(
        producerId: String,
        initialEpoch: Int = 0,
        autoClaimOnStaleEpoch: Bool = true,
        onError: (@Sendable (Error) -> Void)? = nil
    ) -> IdempotentProducerConfig {
        IdempotentProducerConfig(
            producerId: producerId,
            initialEpoch: initialEpoch,
            autoClaimOnStaleEpoch: autoClaimOnStaleEpoch,
            onError: onError
        )
    }

    public init(
        producerId: String,
        initialEpoch: Int = 0,
        autoClaimOnStaleEpoch: Bool = true,
        onError: (@Sendable (Error) -> Void)? = nil
    ) {
        self.producerId = producerId
        self.initialEpoch = initialEpoch
        self.autoClaimOnStaleEpoch = autoClaimOnStaleEpoch
        self.onError = onError
    }
}

// MARK: - Batching Configuration

/// Batching configuration for append operations.
public struct BatchingConfig: Sendable {
    /// Maximum bytes per batch
    public var maxBytes: Int

    /// Time to wait for more items before sending (milliseconds)
    public var lingerMs: Int

    /// Maximum concurrent batches in flight
    public var maxInFlight: Int

    /// Disable batching (send immediately)
    public static let disabled = BatchingConfig(maxBytes: 0, lingerMs: 0, maxInFlight: 1)

    /// Default: 1MB max, 5ms linger, 5 in-flight
    public static let `default` = BatchingConfig(
        maxBytes: Defaults.maxBatchBytes,
        lingerMs: Defaults.lingerMs,
        maxInFlight: Defaults.maxInFlight
    )

    /// High-throughput: larger batches, more concurrency
    public static let highThroughput = BatchingConfig(
        maxBytes: 4_194_304,  // 4MB
        lingerMs: 20,
        maxInFlight: 10
    )

    /// Low-latency: smaller batches, less waiting
    public static let lowLatency = BatchingConfig(
        maxBytes: 65_536,  // 64KB
        lingerMs: 1,
        maxInFlight: 5
    )

    public init(
        maxBytes: Int = Defaults.maxBatchBytes,
        lingerMs: Int = Defaults.lingerMs,
        maxInFlight: Int = Defaults.maxInFlight
    ) {
        self.maxBytes = maxBytes
        self.lingerMs = lingerMs
        self.maxInFlight = maxInFlight
    }
}

// MARK: - HTTP Configuration

/// HTTP client configuration.
public struct HTTPConfig: Sendable {
    /// Request timeout
    public var timeout: TimeInterval

    /// Long-poll timeout (server-side, client waits slightly longer)
    public var longPollTimeout: TimeInterval

    /// URLSession to use (nil uses .shared)
    public var session: URLSession?

    /// Default HTTP configuration
    public static let `default` = HTTPConfig(
        timeout: Defaults.timeout,
        longPollTimeout: Defaults.longPollTimeout
    )

    public init(
        timeout: TimeInterval = Defaults.timeout,
        longPollTimeout: TimeInterval = Defaults.longPollTimeout,
        session: URLSession? = nil
    ) {
        self.timeout = timeout
        self.longPollTimeout = longPollTimeout
        self.session = session
    }

    /// Resolve the session, defaulting to .shared if not specified.
    public var resolvedSession: URLSession {
        session ?? .shared
    }
}

// MARK: - Retry Configuration

/// Retry policy configuration.
public struct RetryConfig: Sendable {
    /// Maximum retry attempts (1 = no retries)
    public var maxAttempts: Int

    /// Base delay for exponential backoff
    public var baseDelayMs: Int

    /// Maximum delay cap
    public var maxDelayMs: Int

    /// Jitter factor (0.0 to 1.0)
    public var jitterFactor: Double

    /// Default retry configuration for reads
    public static let `default` = RetryConfig(
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
        jitterFactor: 0.2
    )

    /// No retries (for non-idempotent operations)
    public static let none = RetryConfig(
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterFactor: 0
    )

    /// Aggressive retry for important operations
    public static let aggressive = RetryConfig(
        maxAttempts: 5,
        baseDelayMs: 50,
        maxDelayMs: 10000,
        jitterFactor: 0.3
    )

    public init(
        maxAttempts: Int = 3,
        baseDelayMs: Int = 100,
        maxDelayMs: Int = 5000,
        jitterFactor: Double = 0.2
    ) {
        self.maxAttempts = maxAttempts
        self.baseDelayMs = baseDelayMs
        self.maxDelayMs = maxDelayMs
        self.jitterFactor = jitterFactor
    }

    /// Calculate delay for a given attempt (0-indexed).
    public func delayForAttempt(_ attempt: Int) -> Int {
        guard attempt > 0 else { return 0 }

        // Exponential backoff: base * 2^attempt
        let exponentialDelay = Double(baseDelayMs) * pow(2.0, Double(attempt - 1))
        let cappedDelay = min(exponentialDelay, Double(maxDelayMs))

        // Add jitter
        let jitter = cappedDelay * jitterFactor * Double.random(in: -1...1)
        let finalDelay = cappedDelay + jitter

        return max(0, Int(finalDelay))
    }

    /// Check if we should retry on this error.
    public func shouldRetry(_ error: DurableStreamError) -> Bool {
        switch error.code {
        case .timeout, .serverBusy, .networkError, .rateLimited:
            return true
        default:
            return false
        }
    }
}

// MARK: - Convenience Extensions

extension DurableStream.Configuration {
    /// Create a DurableStream.Configuration from HandleConfiguration.
    public init(from handle: HandleConfiguration) {
        self.init(
            headers: handle.headers,
            params: handle.params,
            batching: handle.batching.maxBytes > 0,
            maxBatchBytes: handle.batching.maxBytes,
            lingerMs: handle.batching.lingerMs,
            timeout: handle.http.timeout,
            session: handle.http.resolvedSession
        )
    }
}

extension IdempotentProducer.Configuration {
    /// Create an IdempotentProducer.Configuration from IdempotentProducerConfig.
    public init(from config: IdempotentProducerConfig, contentType: String? = nil) {
        self.init(
            autoClaim: config.autoClaimOnStaleEpoch,
            contentType: contentType,
            onError: config.onError
        )
    }
}

// MARK: - Swift Duration Convenience APIs

extension RetryConfig {
    /// Base delay as Swift Duration (convenience for Swift-native code).
    public var baseDelay: Duration {
        get { .milliseconds(baseDelayMs) }
        set { baseDelayMs = Int(newValue.components.seconds * 1000 + newValue.components.attoseconds / 1_000_000_000_000_000) }
    }

    /// Maximum delay as Swift Duration.
    public var maxDelay: Duration {
        get { .milliseconds(maxDelayMs) }
        set { maxDelayMs = Int(newValue.components.seconds * 1000 + newValue.components.attoseconds / 1_000_000_000_000_000) }
    }

    /// Create a retry configuration using Swift Duration types.
    public init(
        maxAttempts: Int = 3,
        baseDelay: Duration,
        maxDelay: Duration,
        jitterFactor: Double = 0.2
    ) {
        self.init(
            maxAttempts: maxAttempts,
            baseDelayMs: Int(baseDelay.components.seconds * 1000 + baseDelay.components.attoseconds / 1_000_000_000_000_000),
            maxDelayMs: Int(maxDelay.components.seconds * 1000 + maxDelay.components.attoseconds / 1_000_000_000_000_000),
            jitterFactor: jitterFactor
        )
    }
}

extension BatchingConfig {
    /// Linger time as Swift Duration (convenience for Swift-native code).
    public var linger: Duration {
        get { .milliseconds(lingerMs) }
        set { lingerMs = Int(newValue.components.seconds * 1000 + newValue.components.attoseconds / 1_000_000_000_000_000) }
    }

    /// Create a batching configuration using Swift Duration.
    public init(
        maxBytes: Int = Defaults.maxBatchBytes,
        linger: Duration,
        maxInFlight: Int = Defaults.maxInFlight
    ) {
        self.init(
            maxBytes: maxBytes,
            lingerMs: Int(linger.components.seconds * 1000 + linger.components.attoseconds / 1_000_000_000_000_000),
            maxInFlight: maxInFlight
        )
    }
}
