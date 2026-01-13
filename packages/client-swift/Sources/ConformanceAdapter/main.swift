// SPDX-License-Identifier: MIT
// DurableStreams Swift Client - Conformance Test Adapter
//
// This adapter implements the stdin/stdout JSON-line protocol for
// the client conformance test runner.
//
// IMPORTANT: This adapter MUST use the DurableStreams library for all operations.
// No raw URLSession calls allowed - we're testing the library, not HTTP.

import DurableStreams
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Command Types

struct Command: Codable {
    let type: String
    var serverUrl: String?
    var timeoutMs: Int?
    var path: String?
    var contentType: String?
    var ttlSeconds: Int?
    var expiresAt: String?
    var data: String?
    var binary: Bool?
    var seq: Int?
    var producerId: String?
    var epoch: Int?
    var autoClaim: Bool?
    var maxInFlight: Int?
    var items: [String]?
    var offset: String?
    var live: LiveValue?
    var maxChunks: Int?
    var waitForUpToDate: Bool?
    var headers: [String: String]?
    var iterationId: String?
    var operation: BenchmarkOperation?
    var name: String?
    var valueType: String?
    var initialValue: String?
    var background: Bool?
    var operationId: String?
}

enum LiveValue: Codable {
    case bool(Bool)
    case string(String)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let boolValue = try? container.decode(Bool.self) {
            self = .bool(boolValue)
        } else if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
        } else {
            throw DecodingError.typeMismatch(LiveValue.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Expected Bool or String"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .bool(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        }
    }
}

struct BenchmarkOperation: Codable {
    let op: String
    var path: String?
    var size: Int?
    var offset: String?
    var live: String?
    var contentType: String?
    var count: Int?
    var concurrency: Int?
}

// MARK: - Result Types

struct Result: Codable {
    var type: String
    var success: Bool
    var clientName: String?
    var clientVersion: String?
    var features: Features?
    var status: Int?
    var offset: String?
    var contentType: String?
    var chunks: [ReadChunk]?
    var upToDate: Bool?
    var cursor: String?
    var headers: [String: String]?
    var commandType: String?
    var errorCode: String?
    var message: String?
    var duplicate: Bool?
    var producerSeq: Int?
    var iterationId: String?
    var durationNs: String?
    var metrics: BenchmarkMetrics?
    var headersSent: [String: String]?
    var paramsSent: [String: String]?
    var operationId: String?
}

struct Features: Codable {
    var batching: Bool?
    var sse: Bool?
    var longPoll: Bool?
    var streaming: Bool?
    var dynamicHeaders: Bool?
}

struct ReadChunk: Codable {
    var data: String
    var binary: Bool?
    var offset: String?
}

struct BenchmarkMetrics: Codable {
    var bytesTransferred: Int?
    var messagesProcessed: Int?
    var opsPerSecond: Double?
    var bytesPerSecond: Double?
}

// MARK: - Adapter State

actor AdapterState {
    var serverURL: String = ""
    var streamHandles: [String: DurableStream] = [:]
    var streamContentTypes: [String: String] = [:]
    var dynamicHeaders: [String: DynamicValue] = [:]
    var dynamicParams: [String: DynamicValue] = [:]
    var backgroundOps: [String: Task<Result, Never>] = [:]
    var opCounter: Int = 0

    struct DynamicValue {
        let type: String  // "counter", "timestamp", "token"
        var counter: Int = 0
        var tokenValue: String = ""
    }

    func generateOpId() -> String {
        opCounter += 1
        return "op-\(opCounter)"
    }

    func storeBackgroundOp(id: String, task: Task<Result, Never>) {
        backgroundOps[id] = task
    }

    func getBackgroundOp(id: String) -> Task<Result, Never>? {
        backgroundOps[id]
    }

    func removeBackgroundOp(id: String) {
        backgroundOps.removeValue(forKey: id)
    }

    func cancelAllBackgroundOps() {
        for (_, task) in backgroundOps {
            task.cancel()
        }
        backgroundOps.removeAll()
    }

    func setServerURL(_ url: String) {
        serverURL = url
        streamHandles.removeAll()
        streamContentTypes.removeAll()
    }

    func setContentType(path: String, contentType: String) {
        streamContentTypes[path] = contentType
    }

    func getContentType(path: String) -> String? {
        streamContentTypes[path]
    }

    func cacheHandle(path: String, handle: DurableStream) {
        streamHandles[path] = handle
    }

    func getHandle(path: String) -> DurableStream? {
        streamHandles[path]
    }

    func removeHandle(path: String) {
        streamHandles.removeValue(forKey: path)
    }

    func setDynamicHeader(name: String, type: String, initialValue: String?) {
        var dv = DynamicValue(type: type)
        if let value = initialValue {
            dv.tokenValue = value
        }
        dynamicHeaders[name] = dv
    }

    func setDynamicParam(name: String, type: String) {
        dynamicParams[name] = DynamicValue(type: type)
    }

    func clearDynamic() {
        dynamicHeaders.removeAll()
        dynamicParams.removeAll()
    }

    func resolveDynamicHeaders() -> [String: String] {
        var result: [String: String] = [:]
        for (name, var dv) in dynamicHeaders {
            switch dv.type {
            case "counter":
                dv.counter += 1
                dynamicHeaders[name] = dv
                result[name] = String(dv.counter)
            case "timestamp":
                result[name] = String(Int(Date().timeIntervalSince1970 * 1000))
            case "token":
                result[name] = dv.tokenValue
            default:
                break
            }
        }
        return result
    }

    func resolveDynamicParams() -> [String: String] {
        var result: [String: String] = [:]
        for (name, var dv) in dynamicParams {
            switch dv.type {
            case "counter":
                dv.counter += 1
                dynamicParams[name] = dv
                result[name] = String(dv.counter)
            case "timestamp":
                result[name] = String(Int(Date().timeIntervalSince1970 * 1000))
            default:
                break
            }
        }
        return result
    }
}

let state = AdapterState()

// MARK: - Main Loop

func writeOutput(_ string: String) {
    let handle = FileHandle.standardOutput
    if let data = (string + "\n").data(using: .utf8) {
        handle.write(data)
        try? handle.synchronize()
    }
}

func main() async {
    let encoder = JSONEncoder()
    encoder.outputFormatting = []

    while let line = readLine() {
        guard !line.isEmpty else { continue }

        do {
            let command = try JSONDecoder().decode(Command.self, from: Data(line.utf8))
            let result = await handleCommand(command)
            let jsonData = try encoder.encode(result)
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                writeOutput(jsonString)
            }

            if command.type == "shutdown" {
                break
            }
        } catch {
            let errorResult = Result(
                type: "error",
                success: false,
                commandType: "unknown",
                errorCode: "PARSE_ERROR",
                message: "Failed to parse command: \(error.localizedDescription)"
            )
            if let jsonData = try? encoder.encode(errorResult),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                writeOutput(jsonString)
            }
        }
    }
}

// MARK: - Command Handlers

func handleCommand(_ cmd: Command) async -> Result {
    switch cmd.type {
    case "init":
        return await handleInit(cmd)
    case "create":
        return await handleCreate(cmd)
    case "connect":
        return await handleConnect(cmd)
    case "append":
        return await handleAppend(cmd)
    case "idempotent-append":
        return await handleIdempotentAppend(cmd)
    case "idempotent-append-batch":
        return await handleIdempotentAppendBatch(cmd)
    case "read":
        return await handleRead(cmd)
    case "head":
        return await handleHead(cmd)
    case "delete":
        return await handleDelete(cmd)
    case "shutdown":
        return Result(type: "shutdown", success: true)
    case "set-dynamic-header":
        return await handleSetDynamicHeader(cmd)
    case "set-dynamic-param":
        return await handleSetDynamicParam(cmd)
    case "clear-dynamic":
        return await handleClearDynamic(cmd)
    case "benchmark":
        return await handleBenchmark(cmd)
    default:
        return Result(
            type: "error",
            success: false,
            commandType: cmd.type,
            errorCode: "NOT_SUPPORTED",
            message: "Unknown command type: \(cmd.type)"
        )
    }
}

func handleInit(_ cmd: Command) async -> Result {
    guard var serverUrl = cmd.serverUrl else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing serverUrl")
    }

    // When running in Docker on macOS, replace localhost with host.docker.internal
    if ProcessInfo.processInfo.environment["DOCKER_HOST_REWRITE"] == "1" {
        serverUrl = serverUrl
            .replacingOccurrences(of: "://localhost:", with: "://host.docker.internal:")
            .replacingOccurrences(of: "://127.0.0.1:", with: "://host.docker.internal:")
    }

    await state.setServerURL(serverUrl)

    return Result(
        type: "init",
        success: true,
        clientName: ClientInfo.name,
        clientVersion: ClientInfo.version,
        features: Features(
            batching: true,
            sse: true,
            longPoll: true,
            streaming: true,
            dynamicHeaders: true
        )
    )
}

// MARK: - Create (uses DurableStream.create)

func handleCreate(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    let contentType = cmd.contentType ?? "application/octet-stream"

    // Build headers
    let dynamicHeaders = await state.resolveDynamicHeaders()
    var allHeaders: HeadersRecord = [:]
    for (key, value) in dynamicHeaders {
        allHeaders[key] = .static(value)
    }
    if let cmdHeaders = cmd.headers {
        for (key, value) in cmdHeaders {
            allHeaders[key] = .static(value)
        }
    }

    do {
        let handle = try await DurableStream.create(
            url: url,
            contentType: contentType,
            ttlSeconds: cmd.ttlSeconds,
            expiresAt: cmd.expiresAt,
            config: DurableStream.Configuration(headers: allHeaders)
        )

        await state.setContentType(path: path, contentType: contentType)
        await state.cacheHandle(path: path, handle: handle)

        // Get the offset
        let info = try await DurableStream.head(url: url)

        return Result(
            type: "create",
            success: true,
            status: 201,
            offset: info.offset?.rawValue
        )
    } catch let error as DurableStreamError {
        return mapError(cmd.type, error)
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
}

// MARK: - Connect (uses DurableStream.connect)

func handleConnect(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    // Build headers
    var allHeaders: HeadersRecord = [:]
    if let cmdHeaders = cmd.headers {
        for (key, value) in cmdHeaders {
            allHeaders[key] = .static(value)
        }
    }

    do {
        let handle = try await DurableStream.connect(
            url: url,
            config: DurableStream.Configuration(headers: allHeaders)
        )

        // Get content type from the handle
        let ct = await handle.contentType
        if let ct = ct {
            await state.setContentType(path: path, contentType: ct)
        }
        await state.cacheHandle(path: path, handle: handle)

        // Get the offset
        let info = try await DurableStream.head(url: url)

        return Result(
            type: "connect",
            success: true,
            status: 200,
            offset: info.offset?.rawValue
        )
    } catch let error as DurableStreamError {
        return mapError(cmd.type, error)
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
}

// MARK: - Append (uses stream.appendSync or appendWithProducer)

func handleAppend(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    // Decode data
    let bodyData: Data
    if cmd.binary == true, let base64Data = cmd.data {
        guard let decoded = Data(base64Encoded: base64Data) else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid base64 data")
        }
        bodyData = decoded
    } else {
        bodyData = Data((cmd.data ?? "").utf8)
    }

    // Get content type
    let contentType = await state.getContentType(path: path) ?? "application/octet-stream"
    let isJSON = contentType.normalizedContentType() == "application/json"

    // Wrap in JSON array if needed
    let finalBody: Data
    if isJSON && !bodyData.isEmpty {
        var arrayData = Data("[".utf8)
        arrayData.append(bodyData)
        arrayData.append(Data("]".utf8))
        finalBody = arrayData
    } else {
        finalBody = bodyData
    }

    // Get dynamic headers
    let dynamicHeaders = await state.resolveDynamicHeaders()
    let dynamicParams = await state.resolveDynamicParams()

    // Build headers for the request
    var allHeaders: HeadersRecord = [:]
    for (key, value) in dynamicHeaders {
        allHeaders[key] = .static(value)
    }
    if let cmdHeaders = cmd.headers {
        for (key, value) in cmdHeaders {
            allHeaders[key] = .static(value)
        }
    }

    // Retry loop for transient errors
    var retryCount = 0
    let maxRetries = 3

    while true {
        do {
            // Get or create handle
            let handle: DurableStream
            if let cached = await state.getHandle(path: path) {
                handle = cached
            } else {
                handle = try await DurableStream.connect(
                    url: url,
                    config: DurableStream.Configuration(headers: allHeaders)
                )
                await state.cacheHandle(path: path, handle: handle)
            }

            // Check if this is a producer append or simple append
            if let producerId = cmd.producerId, let epoch = cmd.epoch {
                let result = try await handle.appendWithProducer(
                    finalBody,
                    producerId: producerId,
                    epoch: epoch,
                    seq: cmd.seq ?? 0,
                    contentType: contentType
                )

                return Result(
                    type: "append",
                    success: true,
                    status: 200,
                    offset: result.offset.rawValue,
                    duplicate: result.isDuplicate,
                    headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
                    paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
                )
            } else {
                // Simple append with optional Stream-Seq
                let result = try await handle.appendSync(finalBody, contentType: contentType, seq: cmd.seq)

                return Result(
                    type: "append",
                    success: true,
                    status: 200,
                    offset: result.offset.rawValue,
                    duplicate: result.isDuplicate,
                    headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
                    paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
                )
            }
        } catch let error as DurableStreamError {
            // Check for retryable errors
            if (error.status == 500 || error.status == 503 || error.status == 429) && retryCount < maxRetries {
                retryCount += 1
                try? await Task.sleep(for: .seconds(Double(retryCount) * 0.1))
                continue
            }
            return mapError(cmd.type, error)
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }
    }
}

// MARK: - Idempotent Append (uses stream.appendWithProducer)

func handleIdempotentAppend(_ cmd: Command) async -> Result {
    guard let path = cmd.path,
          let data = cmd.data,
          let producerId = cmd.producerId else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing required fields")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    let storedContentType = await state.getContentType(path: path)
    let contentType = storedContentType ?? "application/octet-stream"
    let isJSON = contentType.normalizedContentType() == "application/json"

    // Prepare body
    let bodyData: Data
    if isJSON {
        var arrayData = Data("[".utf8)
        if let jsonData = data.data(using: .utf8) {
            arrayData.append(jsonData)
        }
        arrayData.append(Data("]".utf8))
        bodyData = arrayData
    } else {
        bodyData = data.data(using: .utf8) ?? Data()
    }

    var currentEpoch = cmd.epoch ?? 0
    let autoClaim = cmd.autoClaim ?? false
    var epochRetries = autoClaim ? 3 : 0

    while true {
        do {
            // Get or create handle
            let handle: DurableStream
            if let cached = await state.getHandle(path: path) {
                handle = cached
            } else {
                handle = try await DurableStream.connect(url: url)
                await state.cacheHandle(path: path, handle: handle)
            }

            let result = try await handle.appendWithProducer(
                bodyData,
                producerId: producerId,
                epoch: currentEpoch,
                seq: cmd.seq ?? 0,
                contentType: contentType
            )

            return Result(
                type: "idempotent-append",
                success: true,
                status: 200,
                offset: result.offset.rawValue,
                duplicate: result.isDuplicate
            )
        } catch let error as DurableStreamError where error.code == .staleEpoch {
            // Handle stale epoch - if autoClaim, bump epoch and retry
            if autoClaim && epochRetries > 0 {
                if let details = error.details, let epochStr = details["currentEpoch"], let serverEpoch = Int(epochStr) {
                    currentEpoch = serverEpoch + 1
                } else {
                    currentEpoch += 1
                }
                epochRetries -= 1
                continue
            }
            return errorResult(cmd.type, "STALE_EPOCH", "Stale epoch", status: 403)
        } catch let error as DurableStreamError where error.code == .sequenceGap {
            return errorResult(cmd.type, "SEQUENCE_GAP", "Sequence gap", status: 409)
        } catch let error as DurableStreamError {
            return mapError(cmd.type, error)
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }
    }
}

// MARK: - Idempotent Append Batch (uses IdempotentProducer)

func handleIdempotentAppendBatch(_ cmd: Command) async -> Result {
    guard let path = cmd.path,
          let items = cmd.items,
          let producerId = cmd.producerId else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing required fields")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    let contentType = await state.getContentType(path: path) ?? "application/octet-stream"
    let autoClaim = cmd.autoClaim ?? false
    let epoch = cmd.epoch ?? 0

    do {
        // Get or create handle
        let handle: DurableStream
        if let cached = await state.getHandle(path: path) {
            handle = cached
        } else {
            handle = try await DurableStream.connect(url: url)
            await state.cacheHandle(path: path, handle: handle)
        }

        let producer = IdempotentProducer(
            stream: handle,
            producerId: producerId,
            epoch: epoch,
            config: IdempotentProducer.Configuration(
                autoClaim: autoClaim,
                maxInFlight: 1,  // Sequential for conformance
                contentType: contentType
            )
        )

        // Append all items
        for itemData in items {
            if let data = itemData.data(using: .utf8) {
                await producer.appendData(data)
            }
        }

        // Flush and get result
        let result = try await producer.flush()

        return Result(
            type: "idempotent-append-batch",
            success: true,
            status: 200,
            offset: result.offset.rawValue,
            producerSeq: items.count - 1
        )
    } catch let error as DurableStreamError where error.code == .staleEpoch {
        return errorResult(cmd.type, "STALE_EPOCH", "Stale epoch", status: 403)
    } catch let error as DurableStreamError where error.code == .sequenceGap {
        return errorResult(cmd.type, "SEQUENCE_GAP", "Sequence gap", status: 409)
    } catch let error as DurableStreamError {
        return mapError(cmd.type, error)
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
}

// MARK: - Read (uses stream.read or streaming APIs)

func handleRead(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    // Determine live mode
    var liveMode: LiveMode = .catchUp
    if let live = cmd.live {
        switch live {
        case .bool(let value):
            if value {
                liveMode = .longPoll
            }
        case .string(let value):
            switch value {
            case "long-poll":
                liveMode = .longPoll
            case "sse":
                liveMode = .sse
            default:
                liveMode = .catchUp
            }
        }
    }

    // Get dynamic values
    let dynamicHeaders = await state.resolveDynamicHeaders()
    let dynamicParams = await state.resolveDynamicParams()

    let offset = Offset(rawValue: cmd.offset ?? "-1")
    let maxChunks = cmd.maxChunks ?? Int.max
    let waitForUpToDate = cmd.waitForUpToDate ?? false
    let timeoutSeconds = cmd.timeoutMs.map { Double($0) / 1000.0 } ?? 25.0

    // Build headers
    var allHeaders: HeadersRecord = [:]
    for (key, value) in dynamicHeaders {
        allHeaders[key] = .static(value)
    }
    if let cmdHeaders = cmd.headers {
        for (key, value) in cmdHeaders {
            allHeaders[key] = .static(value)
        }
    }

    // For SSE mode, use the SSE streaming API
    if liveMode == .sse {
        return await handleSSERead(
            cmd,
            url: url,
            offset: offset,
            maxChunks: maxChunks,
            waitForUpToDate: waitForUpToDate,
            timeoutSeconds: timeoutSeconds,
            dynamicHeaders: dynamicHeaders,
            dynamicParams: dynamicParams,
            headers: allHeaders
        )
    }

    // For catch-up or long-poll mode
    var allChunks: [ReadChunk] = []
    var currentOffset = offset
    var lastUpToDate = false
    var lastCursor: String?
    var lastStatus = 200
    var retryCount = 0
    let maxRetries = 5

    // Retry loop with timeout
    let deadline = Date().addingTimeInterval(timeoutSeconds)

    while allChunks.count < maxChunks && Date() < deadline {
        do {
            // Get or create handle
            let handle: DurableStream
            if let cached = await state.getHandle(path: path) {
                handle = cached
            } else {
                handle = try await DurableStream.connect(
                    url: url,
                    config: DurableStream.Configuration(headers: allHeaders)
                )
                await state.cacheHandle(path: path, handle: handle)
            }

            let result = try await handle.read(
                offset: currentOffset,
                live: liveMode,
                headers: [:]  // Already in config
            )

            // Reset retry count on success
            retryCount = 0

            lastStatus = result.status
            lastUpToDate = result.upToDate
            lastCursor = result.cursor

            // Collect chunk if there's data
            if !result.data.isEmpty {
                if let text = String(data: result.data, encoding: .utf8) {
                    allChunks.append(ReadChunk(data: text, offset: result.offset.rawValue))
                } else {
                    allChunks.append(ReadChunk(data: result.data.base64EncodedString(), binary: true, offset: result.offset.rawValue))
                }
            }

            currentOffset = result.offset

            // For catch-up mode, return immediately
            if liveMode == .catchUp {
                break
            }

            // In long-poll mode with maxChunks, keep polling
            if liveMode == .longPoll && cmd.maxChunks != nil && allChunks.count < maxChunks {
                continue
            } else if waitForUpToDate && !lastUpToDate {
                continue
            } else {
                break
            }
        } catch let error as DurableStreamError {
            // Handle retryable errors
            if (error.status == 500 || error.status == 503 || error.status == 429) && retryCount < maxRetries {
                retryCount += 1
                try? await Task.sleep(for: .seconds(Double(retryCount) * 0.1))
                continue
            }

            // Handle specific non-retryable errors
            if error.code == .badRequest {
                return errorResult(cmd.type, "INVALID_OFFSET", "Invalid offset", status: 400)
            } else if error.code == .notFound {
                return errorResult(cmd.type, "NOT_FOUND", "Stream not found", status: 404)
            } else if error.code == .retentionExpired {
                return errorResult(cmd.type, "RETENTION_EXPIRED", "Data expired", status: 410)
            } else if error.code == .timeout || error.code == .serverBusy {
                // Timeout in long-poll - return what we have
                lastUpToDate = true
                break
            }
            return mapError(cmd.type, error)
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }
    }

    return Result(
        type: "read",
        success: true,
        status: lastStatus,
        offset: currentOffset.rawValue,
        chunks: allChunks,
        upToDate: lastUpToDate,
        cursor: lastCursor,
        headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
        paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
    )
}

// MARK: - SSE Read (uses stream.sseEvents)

func handleSSERead(
    _ cmd: Command,
    url: URL,
    offset: Offset,
    maxChunks: Int,
    waitForUpToDate: Bool,
    timeoutSeconds: Double,
    dynamicHeaders: [String: String],
    dynamicParams: [String: String],
    headers: HeadersRecord
) async -> Result {
    var allChunks: [ReadChunk] = []
    var currentOffset = offset
    var lastUpToDate = false
    var lastCursor: String?

    let deadline = Date().addingTimeInterval(timeoutSeconds)

    do {
        let handle = try await DurableStream.connect(
            url: url,
            config: DurableStream.Configuration(headers: headers)
        )

        // Start a timeout task
        let sseTask = Task {
            for try await event in await handle.sseEvents(from: offset) {
                if Task.isCancelled || Date() >= deadline {
                    break
                }

                // Parse event data
                if event.effectiveEvent == "data" || event.effectiveEvent == "message" {
                    allChunks.append(ReadChunk(data: event.data, offset: currentOffset.rawValue))
                } else if event.effectiveEvent == "control" {
                    // Parse control event for metadata
                    if let jsonData = event.data.data(using: .utf8),
                       let control = try? JSONDecoder().decode(SSEControlEvent.self, from: jsonData) {
                        currentOffset = Offset(rawValue: control.streamNextOffset)
                        lastCursor = control.streamCursor
                        lastUpToDate = control.upToDate ?? false
                    }
                }

                // Check exit conditions
                if allChunks.count >= maxChunks {
                    break
                }

                let shouldReturnOnUpToDate = waitForUpToDate || !allChunks.isEmpty
                if shouldReturnOnUpToDate && lastUpToDate {
                    break
                }
            }
        }

        // Wait with timeout
        let timeoutTask = Task {
            try? await Task.sleep(for: .seconds(timeoutSeconds))
            sseTask.cancel()
        }

        _ = await sseTask.result
        timeoutTask.cancel()

    } catch let error as DurableStreamError {
        if error.code == .notFound {
            return errorResult(cmd.type, "NOT_FOUND", "Stream not found", status: 404)
        }
        return mapError(cmd.type, error)
    } catch {
        // Timeout or cancellation - return what we have
        lastUpToDate = true
    }

    return Result(
        type: "read",
        success: true,
        status: 200,
        offset: currentOffset.rawValue,
        chunks: allChunks,
        upToDate: lastUpToDate,
        cursor: lastCursor,
        headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
        paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
    )
}

struct SSEControlEvent: Codable {
    let streamNextOffset: String
    var streamCursor: String?
    var upToDate: Bool?
}

// MARK: - Head (uses DurableStream.head)

func handleHead(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    // Build headers
    var allHeaders: HeadersRecord = [:]
    if let cmdHeaders = cmd.headers {
        for (key, value) in cmdHeaders {
            allHeaders[key] = .static(value)
        }
    }

    do {
        let info = try await DurableStream.head(
            url: url,
            config: DurableStream.Configuration(headers: allHeaders)
        )

        return Result(
            type: "head",
            success: true,
            status: 200,
            offset: info.offset?.rawValue,
            contentType: info.contentType
        )
    } catch let error as DurableStreamError {
        return mapError(cmd.type, error)
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
}

// MARK: - Delete (uses DurableStream.delete)

func handleDelete(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    // Build headers
    var allHeaders: HeadersRecord = [:]
    if let cmdHeaders = cmd.headers {
        for (key, value) in cmdHeaders {
            allHeaders[key] = .static(value)
        }
    }

    do {
        try await DurableStream.delete(
            url: url,
            config: DurableStream.Configuration(headers: allHeaders)
        )

        await state.removeHandle(path: path)

        return Result(
            type: "delete",
            success: true,
            status: 200
        )
    } catch let error as DurableStreamError {
        return mapError(cmd.type, error)
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
}

// MARK: - Dynamic Headers/Params

func handleSetDynamicHeader(_ cmd: Command) async -> Result {
    guard let name = cmd.name, let valueType = cmd.valueType else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing name or valueType")
    }

    await state.setDynamicHeader(name: name, type: valueType, initialValue: cmd.initialValue)
    return Result(type: "set-dynamic-header", success: true)
}

func handleSetDynamicParam(_ cmd: Command) async -> Result {
    guard let name = cmd.name, let valueType = cmd.valueType else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing name or valueType")
    }

    await state.setDynamicParam(name: name, type: valueType)
    return Result(type: "set-dynamic-param", success: true)
}

func handleClearDynamic(_ cmd: Command) async -> Result {
    await state.clearDynamic()
    return Result(type: "clear-dynamic", success: true)
}

// MARK: - Benchmark (already uses library)

func handleBenchmark(_ cmd: Command) async -> Result {
    guard let iterationId = cmd.iterationId, let operation = cmd.operation else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing iterationId or operation")
    }

    let startTime = DispatchTime.now()

    switch operation.op {
    case "create":
        guard let path = operation.path else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
        }
        let serverURL = await state.serverURL
        guard let url = URL(string: serverURL + path) else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
        }

        do {
            _ = try await DurableStream.create(url: url, contentType: operation.contentType ?? "application/json")
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }

    case "append":
        guard let path = operation.path, let size = operation.size else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path or size")
        }
        let serverURL = await state.serverURL
        guard let url = URL(string: serverURL + path) else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
        }

        do {
            let handle = try await DurableStream.connect(url: url)
            let data = Data(repeating: 0x41, count: size)
            _ = try await handle.appendSync(data)
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }

    case "read":
        guard let path = operation.path else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
        }
        let serverURL = await state.serverURL
        guard let url = URL(string: serverURL + path) else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
        }

        do {
            let offset = operation.offset.map { Offset(rawValue: $0) } ?? .start
            _ = try await stream(url: url, offset: offset)
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }

    case "roundtrip":
        guard let path = operation.path, let size = operation.size else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path or size")
        }
        let serverURL = await state.serverURL
        guard let url = URL(string: serverURL + path) else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
        }

        do {
            let contentType = operation.contentType ?? "application/octet-stream"
            let handle = try await DurableStream.create(url: url, contentType: contentType)

            let data: Data
            if contentType.contains("json") {
                let jsonString = String(repeating: "x", count: max(0, size - 4))
                let json = "\"\(jsonString)\""
                data = json.data(using: .utf8) ?? Data()
            } else {
                data = Data(repeating: 0x41, count: size)
            }

            _ = try await handle.appendSync(data)
            _ = try await handle.read(offset: .start, live: .catchUp)
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }

    case "throughput_append":
        guard let path = operation.path,
              let count = operation.count,
              let size = operation.size else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Missing required fields")
        }
        let serverURL = await state.serverURL
        guard let url = URL(string: serverURL + path) else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
        }

        let messagesProcessed = count
        let bytesTransferred = count * size

        do {
            let handle: DurableStream
            do {
                handle = try await DurableStream.create(url: url, contentType: operation.contentType ?? "application/octet-stream")
            } catch {
                handle = try await DurableStream.connect(url: url)
            }

            let contentType = operation.contentType ?? "application/octet-stream"
            let producer = IdempotentProducer(
                stream: handle,
                producerId: "bench-producer-\(UUID().uuidString.prefix(8))",
                config: IdempotentProducer.Configuration(
                    lingerMs: 0,
                    maxInFlight: 10,
                    contentType: contentType
                )
            )

            let data = Data(repeating: 0x41, count: size)
            let items = [Data](repeating: data, count: count)
            await producer.appendBatch(items)
            _ = try await producer.flush()
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }

        let endTime = DispatchTime.now()
        let durationNs = endTime.uptimeNanoseconds - startTime.uptimeNanoseconds

        return Result(
            type: "benchmark",
            success: true,
            iterationId: iterationId,
            durationNs: String(durationNs),
            metrics: BenchmarkMetrics(
                bytesTransferred: bytesTransferred,
                messagesProcessed: messagesProcessed
            )
        )

    case "throughput_read":
        guard let path = operation.path else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
        }
        let serverURL = await state.serverURL
        guard let url = URL(string: serverURL + path) else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
        }

        var bytesTransferred = 0

        do {
            let response = try await stream(url: url, offset: .start)
            bytesTransferred = response.data.count
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }

        let endTime = DispatchTime.now()
        let durationNs = endTime.uptimeNanoseconds - startTime.uptimeNanoseconds

        return Result(
            type: "benchmark",
            success: true,
            iterationId: iterationId,
            durationNs: String(durationNs),
            metrics: BenchmarkMetrics(
                bytesTransferred: bytesTransferred,
                messagesProcessed: 1
            )
        )

    default:
        return errorResult(cmd.type, "NOT_SUPPORTED", "Unknown benchmark operation: \(operation.op)")
    }

    let endTime = DispatchTime.now()
    let durationNs = endTime.uptimeNanoseconds - startTime.uptimeNanoseconds

    return Result(
        type: "benchmark",
        success: true,
        iterationId: iterationId,
        durationNs: String(durationNs)
    )
}

// MARK: - Helpers

func errorResult(_ commandType: String, _ errorCode: String, _ message: String, status: Int? = nil) -> Result {
    Result(
        type: "error",
        success: false,
        status: status,
        commandType: commandType,
        errorCode: errorCode,
        message: message
    )
}

func mapError(_ commandType: String, _ error: DurableStreamError) -> Result {
    let errorCode: String
    switch error.code {
    case .notFound:
        errorCode = "NOT_FOUND"
    case .conflict, .conflictExists:
        errorCode = "CONFLICT"
    case .conflictSeq:
        errorCode = "SEQUENCE_CONFLICT"
    case .badRequest:
        errorCode = "INVALID_OFFSET"
    case .unauthorized:
        errorCode = "UNAUTHORIZED"
    case .forbidden:
        errorCode = "FORBIDDEN"
    case .staleEpoch:
        errorCode = "STALE_EPOCH"
    case .sequenceGap:
        errorCode = "SEQUENCE_GAP"
    case .retentionExpired:
        errorCode = "RETENTION_EXPIRED"
    case .timeout:
        errorCode = "TIMEOUT"
    case .networkError:
        errorCode = "NETWORK_ERROR"
    default:
        errorCode = "UNEXPECTED_STATUS"
    }

    return Result(
        type: "error",
        success: false,
        status: error.status,
        commandType: commandType,
        errorCode: errorCode,
        message: error.message
    )
}

extension String {
    func normalizedContentType() -> String {
        let mediaType = self.split(separator: ";").first ?? Substring(self)
        return String(mediaType).trimmingCharacters(in: .whitespaces).lowercased()
    }
}

// Run the main loop
await main()
