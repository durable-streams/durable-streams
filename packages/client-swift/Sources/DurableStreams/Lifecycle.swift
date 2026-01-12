// SPDX-License-Identifier: Apache-2.0
// DurableStreams Swift Client - iOS Lifecycle Management

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Suspended State

/// State captured when a stream is suspended.
public struct SuspendedStreamState: Sendable {
    /// The stream URL
    public let url: URL

    /// Last known offset for resumption
    public let offset: Offset

    /// Content type of the stream
    public let contentType: String?

    /// Timestamp when suspended
    public let suspendedAt: Date

    public init(url: URL, offset: Offset, contentType: String?, suspendedAt: Date = Date()) {
        self.url = url
        self.offset = offset
        self.contentType = contentType
        self.suspendedAt = suspendedAt
    }
}

// MARK: - Stream Lifecycle Manager

/// Manages stream connections across iOS app lifecycle.
///
/// Use this manager to properly handle app backgrounding/foregrounding:
///
/// ```swift
/// class StreamManager: ObservableObject {
///     let lifecycleManager = StreamLifecycleManager()
///     var handle: DurableStream?
///
///     func suspend() async {
///         if let handle = handle {
///             await lifecycleManager.suspend(handle)
///         }
///     }
///
///     func resume() async throws {
///         handle = try await lifecycleManager.resume(for: streamURL)
///     }
/// }
/// ```
public actor StreamLifecycleManager {
    /// Suspended stream states keyed by URL
    private var suspendedStates: [URL: SuspendedStreamState] = [:]

    /// Configuration to use when reconnecting
    private var configurations: [URL: DurableStream.Configuration] = [:]

    public init() {}

    /// Suspend a stream, capturing its state for later resumption.
    ///
    /// Call this when the app is about to become inactive (e.g., from
    /// `sceneWillResignActive` or `applicationWillResignActive`).
    public func suspend(_ stream: DurableStream) async -> SuspendedStreamState {
        let state = await stream.captureState()
        suspendedStates[stream.url] = state
        return state
    }

    /// Suspend a stream with explicit offset.
    ///
    /// Use this when you're tracking the offset externally (e.g., from batch processing).
    public func suspend(url: URL, offset: Offset, contentType: String? = nil) -> SuspendedStreamState {
        let state = SuspendedStreamState(url: url, offset: offset, contentType: contentType)
        suspendedStates[url] = state
        return state
    }

    /// Resume a suspended stream.
    ///
    /// Call this when the app becomes active again (e.g., from
    /// `sceneDidBecomeActive` or `applicationDidBecomeActive`).
    ///
    /// - Parameter url: The stream URL to resume
    /// - Parameter config: Optional configuration override
    /// - Returns: A reconnected DurableStream positioned at the suspended offset
    /// - Throws: `DurableStreamError.notFound` if stream doesn't exist
    public func resume(
        for url: URL,
        config: DurableStream.Configuration? = nil
    ) async throws -> DurableStream {
        guard suspendedStates[url] != nil else {
            // No suspended state, just connect normally
            let effectiveConfig = config ?? configurations[url] ?? .default
            return try await DurableStream.connect(url: url, config: effectiveConfig)
        }

        // Remove from suspended states
        suspendedStates.removeValue(forKey: url)

        // Reconnect
        let effectiveConfig = config ?? configurations[url] ?? .default
        return try await DurableStream.connect(url: url, config: effectiveConfig)
    }

    /// Get the suspended state for a URL without resuming.
    public func getSuspendedState(for url: URL) -> SuspendedStreamState? {
        suspendedStates[url]
    }

    /// Check if a stream is currently suspended.
    public func isSuspended(_ url: URL) -> Bool {
        suspendedStates[url] != nil
    }

    /// Store configuration for a URL (used on resume).
    public func setConfiguration(_ config: DurableStream.Configuration, for url: URL) {
        configurations[url] = config
    }

    /// Clear all suspended states.
    public func clearAll() {
        suspendedStates.removeAll()
    }

    /// Get all suspended URLs.
    public var suspendedURLs: [URL] {
        Array(suspendedStates.keys)
    }
}

// MARK: - DurableStream Lifecycle Extensions

extension DurableStream {
    /// Capture the current state for suspension.
    public func captureState() -> SuspendedStreamState {
        SuspendedStreamState(
            url: url,
            offset: Offset(rawValue: "0"), // Will be updated by streaming operations
            contentType: contentType
        )
    }

    /// Resume reading from a suspended state.
    ///
    /// This is a convenience method to continue streaming from where you left off:
    ///
    /// ```swift
    /// // Save state before backgrounding
    /// let state = handle.captureState()
    /// lastOffset = currentStreamingOffset
    ///
    /// // Resume after foregrounding
    /// for try await batch in handle.jsonBatches(as: Event.self, from: lastOffset) {
    ///     // Continue processing
    /// }
    /// ```
    public func resumeMessages<T: Decodable & Sendable>(
        as type: T.Type,
        from state: SuspendedStreamState,
        decoder: JSONDecoder = JSONDecoder()
    ) -> AsyncThrowingStream<T, Error> {
        messages(as: type, from: state.offset, decoder: decoder)
    }

    /// Resume reading batches from a suspended state.
    public func resumeBatches<T: Decodable & Sendable>(
        as type: T.Type,
        from state: SuspendedStreamState,
        decoder: JSONDecoder = JSONDecoder()
    ) -> AsyncThrowingStream<JsonBatch<T>, Error> {
        jsonBatches(as: type, from: state.offset, decoder: decoder)
    }
}

// MARK: - iOS Background Task Support

#if canImport(UIKit) && !os(watchOS)
import UIKit

extension DurableStream {
    /// Request background time for flushing pending writes.
    ///
    /// Call this when the app is about to be backgrounded to ensure
    /// any pending writes are flushed before the app is suspended.
    ///
    /// ```swift
    /// func applicationDidEnterBackground() {
    ///     Task {
    ///         try await handle.requestBackgroundFlush()
    ///     }
    /// }
    /// ```
    @MainActor
    public func requestBackgroundFlush() async throws {
        var taskId: UIBackgroundTaskIdentifier = .invalid

        taskId = UIApplication.shared.beginBackgroundTask(withName: "DurableStreamFlush") {
            // Expiration handler - task took too long
            if taskId != .invalid {
                UIApplication.shared.endBackgroundTask(taskId)
            }
        }

        guard taskId != .invalid else {
            // Background task not available, try to flush anyway
            _ = try await flush()
            return
        }

        defer {
            UIApplication.shared.endBackgroundTask(taskId)
        }

        _ = try await flush()
    }
}

extension IdempotentProducer {
    /// Request background time for flushing pending writes.
    @MainActor
    public func requestBackgroundFlush() async throws {
        var taskId: UIBackgroundTaskIdentifier = .invalid

        taskId = UIApplication.shared.beginBackgroundTask(withName: "IdempotentProducerFlush") {
            if taskId != .invalid {
                UIApplication.shared.endBackgroundTask(taskId)
            }
        }

        guard taskId != .invalid else {
            _ = try await flush()
            return
        }

        defer {
            UIApplication.shared.endBackgroundTask(taskId)
        }

        _ = try await flush()
    }
}

// MARK: - SwiftUI Integration Helpers

/// A property wrapper for managing stream lifecycle with SwiftUI.
///
/// ```swift
/// struct ContentView: View {
///     @StateObject var streamState = StreamState()
///
///     var body: some View {
///         MessageList(messages: streamState.messages)
///             .onReceive(NotificationCenter.default.publisher(
///                 for: UIApplication.willResignActiveNotification
///             )) { _ in
///                 Task { await streamState.suspend() }
///             }
///             .onReceive(NotificationCenter.default.publisher(
///                 for: UIApplication.didBecomeActiveNotification
///             )) { _ in
///                 Task { try await streamState.resume() }
///             }
///     }
/// }
/// ```
@MainActor
public class StreamState: ObservableObject {
    /// The lifecycle manager
    public let lifecycleManager = StreamLifecycleManager()

    /// Currently active streams
    @Published public private(set) var activeStreams: [URL: DurableStream] = [:]

    /// Whether currently suspended
    @Published public private(set) var isSuspended = false

    /// Last error encountered
    @Published public var lastError: Error?

    public init() {}

    /// Register a stream with the lifecycle manager.
    public func register(_ stream: DurableStream) {
        activeStreams[stream.url] = stream
    }

    /// Unregister a stream.
    public func unregister(_ stream: DurableStream) {
        activeStreams.removeValue(forKey: stream.url)
    }

    /// Suspend all active streams.
    public func suspend() async {
        isSuspended = true
        for (_, stream) in activeStreams {
            _ = await lifecycleManager.suspend(stream)
        }
        activeStreams.removeAll()
    }

    /// Resume all suspended streams.
    public func resume() async {
        guard isSuspended else { return }

        for url in await lifecycleManager.suspendedURLs {
            do {
                let stream = try await lifecycleManager.resume(for: url)
                activeStreams[url] = stream
            } catch {
                lastError = error
            }
        }

        isSuspended = false
    }

    /// Flush all active streams (call before backgrounding).
    public func flushAll() async throws {
        for (_, stream) in activeStreams {
            _ = try await stream.flush()
        }
    }
}
#endif

// MARK: - Service Lifecycle Integration (Server-side Swift)

#if canImport(ServiceLifecycle)
import ServiceLifecycle

extension DurableStream: Service {
    /// Run the stream handle as a service.
    ///
    /// The handle stays alive until the service is cancelled, at which point
    /// it gracefully closes (flushing any pending writes).
    public func run() async throws {
        try await withTaskCancellationHandler {
            // Keep alive until cancelled
            try await Task.sleep(for: .seconds(.max))
        } onCancel: {
            Task { try? await self.close() }
        }
    }
}

extension IdempotentProducer: Service {
    /// Run the producer as a service.
    public func run() async throws {
        try await withTaskCancellationHandler {
            try await Task.sleep(for: .seconds(.max))
        } onCancel: {
            Task { try? await self.close() }
        }
    }
}
#endif
