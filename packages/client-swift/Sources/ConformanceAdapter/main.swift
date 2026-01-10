// SPDX-License-Identifier: Apache-2.0
// DurableStreams Swift Client - Conformance Test Adapter
//
// This adapter implements the stdin/stdout JSON-line protocol for
// the client conformance test runner.

import DurableStreams
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Command Types

// Note: The conformance test runner sends items as strings directly, not as objects
// So we need to decode either string or {data: string} format

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
    }

    func setContentType(path: String, contentType: String) {
        streamContentTypes[path] = contentType
    }

    func getContentType(path: String) -> String? {
        streamContentTypes[path]
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

// Create a URLSession with reasonable timeouts
let sessionConfig: URLSessionConfiguration = {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 25.0  // 25 seconds (under the 30s test timeout)
    config.timeoutIntervalForResource = 30.0
    return config
}()
let urlSession = URLSession(configuration: sessionConfig)

// MARK: - Main Loop

// Helper to write output and flush using FileHandle (Swift 6 safe)
func writeOutput(_ string: String) {
    let handle = FileHandle.standardOutput
    if let data = (string + "\n").data(using: .utf8) {
        handle.write(data)
        // Explicitly synchronize to ensure data is flushed
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
    // This allows the container to reach services on the host machine
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

func handleCreate(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    let contentType = cmd.contentType ?? "application/octet-stream"

    // Get dynamic headers
    let dynamicHeaders = await state.resolveDynamicHeaders()
    var allHeaders = dynamicHeaders
    if let cmdHeaders = cmd.headers {
        allHeaders.merge(cmdHeaders) { _, new in new }
    }

    do {
        // Build request manually for more control
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")

        if let ttl = cmd.ttlSeconds {
            request.setValue(String(ttl), forHTTPHeaderField: Headers.streamTTL)
        }
        if let expires = cmd.expiresAt {
            request.setValue(expires, forHTTPHeaderField: Headers.streamExpiresAt)
        }

        for (key, value) in allHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }

        let (_, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
        }

        if httpResponse.statusCode == 201 {
            await state.setContentType(path: path, contentType: contentType)
            let offset = httpResponse.value(forHTTPHeaderField: Headers.streamNextOffset)
            return Result(type: "create", success: true, status: 201, offset: offset)
        } else if httpResponse.statusCode == 409 {
            return errorResult(cmd.type, "CONFLICT", "Stream already exists", status: 409)
        } else {
            return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
        }
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
}

func handleConnect(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    do {
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"

        if let cmdHeaders = cmd.headers {
            for (key, value) in cmdHeaders {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }

        let (_, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
        }

        if httpResponse.statusCode == 200 {
            let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type")
            if let ct = contentType {
                await state.setContentType(path: path, contentType: ct)
            }
            let offset = httpResponse.value(forHTTPHeaderField: Headers.streamNextOffset)
            return Result(type: "connect", success: true, status: 200, offset: offset)
        } else if httpResponse.statusCode == 404 {
            return errorResult(cmd.type, "NOT_FOUND", "Stream not found", status: 404)
        } else {
            return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
        }
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
}

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
        // Wrap the data in a JSON array
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

    // Retry loop for transient errors
    var retryCount = 0
    let maxRetries = 3

    while true {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = finalBody
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")

        // Add dynamic headers
        for (key, value) in dynamicHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }

        // Add command headers
        if let cmdHeaders = cmd.headers {
            for (key, value) in cmdHeaders {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }

        // Add producer headers if present (all three are required together)
        if let producerId = cmd.producerId, let epoch = cmd.epoch {
            request.setValue(producerId, forHTTPHeaderField: Headers.producerId)
            request.setValue(String(epoch), forHTTPHeaderField: Headers.producerEpoch)
            if let seq = cmd.seq {
                request.setValue(String(seq), forHTTPHeaderField: Headers.producerSeq)
            }
        } else if let seq = cmd.seq {
            // Simple sequence ordering (without full producer headers)
            request.setValue(String(seq), forHTTPHeaderField: Headers.streamSeq)
        }

        do {
            let (_, response) = try await urlSession.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
            }

            let offset = httpResponse.value(forHTTPHeaderField: Headers.streamNextOffset)
            let isDuplicate = httpResponse.statusCode == 204
            let producerSeq = httpResponse.value(forHTTPHeaderField: Headers.producerSeq).flatMap { Int($0) }

            if httpResponse.statusCode == 200 || httpResponse.statusCode == 204 {
                // Normalize to 200 for successful appends (204 is also success per protocol)
                return Result(
                    type: "append",
                    success: true,
                    status: 200,
                    offset: offset,
                    duplicate: isDuplicate,
                    producerSeq: producerSeq,
                    headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
                    paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
                )
            } else if httpResponse.statusCode == 500 || httpResponse.statusCode == 503 || httpResponse.statusCode == 429 {
                // Transient error - retry with backoff
                if retryCount < maxRetries {
                    retryCount += 1
                    let delay = Double(retryCount) * 0.1  // Simple linear backoff
                    try await Task.sleep(for: .seconds(delay))
                    continue
                }
                return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
            } else if httpResponse.statusCode == 403 {
                return errorResult(cmd.type, "FORBIDDEN", "Stale epoch", status: 403)
            } else if httpResponse.statusCode == 404 {
                return errorResult(cmd.type, "NOT_FOUND", "Stream not found", status: 404)
            } else if httpResponse.statusCode == 409 {
                return errorResult(cmd.type, "SEQUENCE_CONFLICT", "Sequence conflict", status: 409)
            } else {
                return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
            }
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }
    }
}

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
    var maxRetries = autoClaim ? 3 : 0

    while true {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = bodyData
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue(producerId, forHTTPHeaderField: Headers.producerId)
        request.setValue(String(currentEpoch), forHTTPHeaderField: Headers.producerEpoch)
        request.setValue(String(cmd.seq ?? 0), forHTTPHeaderField: Headers.producerSeq)

        do {
            let (_, response) = try await urlSession.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
            }

            let offset = httpResponse.value(forHTTPHeaderField: Headers.streamNextOffset)
            let isDuplicate = httpResponse.statusCode == 204

            if httpResponse.statusCode == 200 || httpResponse.statusCode == 204 {
                return Result(
                    type: "idempotent-append",
                    success: true,
                    status: 200,
                    offset: offset,
                    duplicate: isDuplicate
                )
            } else if httpResponse.statusCode == 403 {
                // Stale epoch - if autoClaim, bump epoch and retry
                if autoClaim && maxRetries > 0 {
                    if let epochStr = httpResponse.value(forHTTPHeaderField: Headers.producerEpoch),
                       let serverEpoch = Int(epochStr) {
                        currentEpoch = serverEpoch + 1
                    } else {
                        currentEpoch += 1
                    }
                    maxRetries -= 1
                    continue
                }
                return errorResult(cmd.type, "STALE_EPOCH", "Stale epoch", status: 403)
            } else if httpResponse.statusCode == 409 {
                return errorResult(cmd.type, "SEQUENCE_GAP", "Sequence gap", status: 409)
            } else {
                return errorResult(cmd.type, "UNEXPECTED_STATUS", "Status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
            }
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }
    }
}

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

    // Use direct HTTP requests instead of IdempotentProducer
    let contentType = await state.getContentType(path: path) ?? "application/octet-stream"
    let isJSON = contentType.normalizedContentType() == "application/json"
    var currentEpoch = cmd.epoch ?? 0
    let autoClaim = cmd.autoClaim ?? false
    var epochRetries = autoClaim ? 3 : 0
    var lastOffset: String?

    // Outer loop for epoch retries (autoclaim)
    epochLoop: while true {
        var currentSeq = 0

        // Send items sequentially with producer headers
        for itemData in items {
            let bodyData: Data
            if isJSON {
                // For JSON streams, wrap in array
                var arrayData = Data("[".utf8)
                if let jsonData = itemData.data(using: .utf8) {
                    arrayData.append(jsonData)
                }
                arrayData.append(Data("]".utf8))
                bodyData = arrayData
            } else {
                bodyData = itemData.data(using: .utf8) ?? Data()
            }

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.httpBody = bodyData
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.setValue(producerId, forHTTPHeaderField: Headers.producerId)
            request.setValue(String(currentEpoch), forHTTPHeaderField: Headers.producerEpoch)
            request.setValue(String(currentSeq), forHTTPHeaderField: Headers.producerSeq)

            do {
                let (_, response) = try await urlSession.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
                }

                if httpResponse.statusCode == 200 || httpResponse.statusCode == 204 {
                    lastOffset = httpResponse.value(forHTTPHeaderField: Headers.streamNextOffset)
                    currentSeq += 1
                } else if httpResponse.statusCode == 403 {
                    // Stale epoch - if autoClaim, bump epoch and restart
                    if autoClaim && epochRetries > 0 {
                        if let epochStr = httpResponse.value(forHTTPHeaderField: Headers.producerEpoch),
                           let serverEpoch = Int(epochStr) {
                            currentEpoch = serverEpoch + 1
                        } else {
                            currentEpoch += 1
                        }
                        epochRetries -= 1
                        continue epochLoop  // Restart from beginning with new epoch
                    }
                    return errorResult(cmd.type, "STALE_EPOCH", "Stale epoch", status: 403)
                } else if httpResponse.statusCode == 409 {
                    return errorResult(cmd.type, "SEQUENCE_GAP", "Sequence gap", status: 409)
                } else {
                    return errorResult(cmd.type, "UNEXPECTED_STATUS", "Status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
                }
            } catch {
                return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
            }
        }

        // All items sent successfully
        break epochLoop
    }

    return Result(
        type: "idempotent-append-batch",
        success: true,
        status: 200,
        offset: lastOffset,
        producerSeq: items.count - 1  // 0-indexed sequence
    )
}

func handleRead(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL

    // Add live mode
    var liveMode = "catchUp"
    if let live = cmd.live {
        switch live {
        case .bool(let value):
            if value {
                liveMode = "long-poll"
            }
        case .string(let value):
            liveMode = value
        }
    }

    // Get dynamic values once at start
    let dynamicHeaders = await state.resolveDynamicHeaders()
    let dynamicParams = await state.resolveDynamicParams()

    // Handle SSE mode separately
    if liveMode == "sse" {
        return await handleSSERead(cmd, path: path, serverURL: serverURL, dynamicHeaders: dynamicHeaders, dynamicParams: dynamicParams)
    }

    // For live mode with maxChunks, we collect data across multiple requests
    var allChunks: [ReadChunk] = []
    var currentOffset = cmd.offset ?? "-1"
    var lastUpToDate = false
    var lastCursor: String?
    var lastStatus = 200  // Track the actual HTTP status
    let maxChunks = cmd.maxChunks ?? Int.max
    let waitForUpToDate = cmd.waitForUpToDate ?? false

    // Outer loop for collecting chunks (for live mode with maxChunks)
    chunkLoop: while allChunks.count < maxChunks {
        guard var components = URLComponents(string: serverURL + path) else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
        }

        var queryItems: [URLQueryItem] = []
        queryItems.append(URLQueryItem(name: QueryParams.offset, value: currentOffset))

        if liveMode == "long-poll" {
            queryItems.append(URLQueryItem(name: QueryParams.live, value: "long-poll"))
        }

        for (key, value) in dynamicParams {
            queryItems.append(URLQueryItem(name: key, value: value))
        }

        components.queryItems = queryItems

        guard let url = components.url else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
        }

        // Retry loop for transient errors
        var retryCount = 0
        let maxRetries = 3

        retryLoop: while true {
            var request = URLRequest(url: url)
            request.httpMethod = "GET"

            for (key, value) in dynamicHeaders {
                request.setValue(value, forHTTPHeaderField: key)
            }

            if let cmdHeaders = cmd.headers {
                for (key, value) in cmdHeaders {
                    request.setValue(value, forHTTPHeaderField: key)
                }
            }

            if let timeoutMs = cmd.timeoutMs {
                request.timeoutInterval = Double(timeoutMs) / 1000.0
            }

            do {
                let (data, response) = try await urlSession.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
                }

                if httpResponse.statusCode == 200 || httpResponse.statusCode == 204 {
                    let newOffset = httpResponse.value(forHTTPHeaderField: Headers.streamNextOffset)
                    lastUpToDate = httpResponse.value(forHTTPHeaderField: Headers.streamUpToDate) != nil
                    lastCursor = httpResponse.value(forHTTPHeaderField: Headers.streamCursor)
                    lastStatus = httpResponse.statusCode

                    // Collect chunk if there's data
                    if !data.isEmpty {
                        if let text = String(data: data, encoding: .utf8) {
                            allChunks.append(ReadChunk(data: text, offset: newOffset))
                        } else {
                            allChunks.append(ReadChunk(data: data.base64EncodedString(), binary: true, offset: newOffset))
                        }
                    }

                    // Update offset for next iteration
                    if let newOffset = newOffset {
                        currentOffset = newOffset
                    }

                    // Decide whether to continue collecting
                    // For catch-up mode (liveMode == "catchUp"), return immediately
                    if liveMode == "catchUp" {
                        break chunkLoop
                    }

                    // In long-poll mode with maxChunks, keep polling until we hit the limit
                    let hasMaxChunksLimit = cmd.maxChunks != nil
                    if liveMode == "long-poll" && hasMaxChunksLimit && allChunks.count < maxChunks {
                        // Continue collecting in long-poll mode until maxChunks reached
                        continue chunkLoop
                    } else if waitForUpToDate && !lastUpToDate {
                        continue chunkLoop
                    } else {
                        break chunkLoop
                    }
                } else if httpResponse.statusCode == 500 || httpResponse.statusCode == 503 || httpResponse.statusCode == 429 {
                    if retryCount < maxRetries {
                        retryCount += 1
                        try await Task.sleep(for: .seconds(Double(retryCount) * 0.1))
                        continue retryLoop
                    }
                    return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
                } else if httpResponse.statusCode == 400 {
                    return errorResult(cmd.type, "INVALID_OFFSET", "Invalid offset", status: 400)
                } else if httpResponse.statusCode == 404 {
                    return errorResult(cmd.type, "NOT_FOUND", "Stream not found", status: 404)
                } else if httpResponse.statusCode == 410 {
                    return errorResult(cmd.type, "RETENTION_EXPIRED", "Data expired", status: 410)
                } else {
                    return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
                }
            } catch let urlError as URLError where urlError.code == .timedOut {
                // Timeout - return what we have with upToDate=true
                lastUpToDate = true
                break chunkLoop
            } catch let urlError as URLError where urlError.code == .networkConnectionLost || urlError.code == .notConnectedToInternet {
                if retryCount < maxRetries {
                    retryCount += 1
                    try? await Task.sleep(for: .seconds(0.1))
                    continue retryLoop
                }
                return errorResult(cmd.type, "NETWORK_ERROR", urlError.localizedDescription)
            } catch {
                return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
            }
        }
    }

    return Result(
        type: "read",
        success: true,
        status: lastStatus,
        offset: currentOffset,
        chunks: allChunks,
        upToDate: lastUpToDate,
        cursor: lastCursor,
        headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
        paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
    )
}

// SSE Control event structure
struct SSEControlEvent: Codable {
    let streamNextOffset: String
    var streamCursor: String?
    var upToDate: Bool?
}

// SSE delegate for streaming HTTP response
final class SSEDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    var continuation: AsyncStream<Data>.Continuation?
    var responseContinuation: CheckedContinuation<HTTPURLResponse?, Error>?
    var hasReceivedResponse = false
    var isCancelled = false

    func cancel() {
        isCancelled = true
        if !hasReceivedResponse {
            responseContinuation?.resume(returning: nil)
            responseContinuation = nil
        }
        continuation?.finish()
        continuation = nil
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        hasReceivedResponse = true
        responseContinuation?.resume(returning: response as? HTTPURLResponse)
        responseContinuation = nil
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !isCancelled else { return }
        continuation?.yield(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error, !isCancelled {
            if !hasReceivedResponse {
                responseContinuation?.resume(throwing: error)
                responseContinuation = nil
            }
        }
        continuation?.finish()
        continuation = nil
    }
}

func handleSSERead(_ cmd: Command, path: String, serverURL: String, dynamicHeaders: [String: String], dynamicParams: [String: String]) async -> Result {
    guard var components = URLComponents(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    var queryItems: [URLQueryItem] = []
    let offset = cmd.offset ?? "-1"
    queryItems.append(URLQueryItem(name: QueryParams.offset, value: offset))
    queryItems.append(URLQueryItem(name: QueryParams.live, value: "sse"))

    for (key, value) in dynamicParams {
        queryItems.append(URLQueryItem(name: key, value: value))
    }

    components.queryItems = queryItems

    guard let url = components.url else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

    for (key, value) in dynamicHeaders {
        request.setValue(value, forHTTPHeaderField: key)
    }

    if let cmdHeaders = cmd.headers {
        for (key, value) in cmdHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }
    }

    var allChunks: [ReadChunk] = []
    var currentOffset = offset
    var lastUpToDate = false
    var lastCursor: String?
    let maxChunks = cmd.maxChunks ?? Int.max
    let waitForUpToDate = cmd.waitForUpToDate ?? false

    // Calculate deadline for total request timeout
    let timeoutSeconds = cmd.timeoutMs.map { Double($0) / 1000.0 } ?? 25.0
    let deadline = Date().addingTimeInterval(timeoutSeconds)

    // Helper to check if deadline passed
    func isDeadlinePassed() -> Bool {
        Date() >= deadline
    }

    // Use delegate-based streaming for Linux compatibility
    let delegate = SSEDelegate()
    let sseSession = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
    defer {
        delegate.cancel()  // Signal to stop streaming
        sseSession.invalidateAndCancel()  // Cleanup session
    }

    // Set up data stream continuation BEFORE starting task
    let dataStream = AsyncStream<Data> { continuation in
        delegate.continuation = continuation
    }

    // Create task but don't resume yet
    let task = sseSession.dataTask(with: request)

    // Wait for response headers using async continuation with timeout
    let httpResponse: HTTPURLResponse?
    do {
        httpResponse = try await withCheckedThrowingContinuation { continuation in
            // Set the response continuation BEFORE starting the task to avoid race condition
            delegate.responseContinuation = continuation
            // Now start the task
            task.resume()
        }
    } catch let error as URLError where error.code == .timedOut || error.code == .cancelled {
        task.cancel()
        return Result(
            type: "read",
            success: true,
            status: 200,
            offset: currentOffset,
            chunks: allChunks,
            upToDate: true,
            cursor: lastCursor,
            headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
            paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
        )
    } catch {
        task.cancel()
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }

    guard let httpResponse = httpResponse else {
        task.cancel()
        return errorResult(cmd.type, "NETWORK_ERROR", "No response")
    }

    if httpResponse.statusCode == 404 {
        return errorResult(cmd.type, "NOT_FOUND", "Stream not found", status: 404)
    }

    if httpResponse.statusCode != 200 {
        return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
    }

    // Parse SSE events from the data stream
    var buffer = ""
    var currentEventType: String?
    var currentDataLines: [String] = []

    // Start a timeout task that will cancel the SSE connection when deadline passes
    let timeoutTask = Task {
        let remaining = deadline.timeIntervalSinceNow
        if remaining > 0 {
            try? await Task.sleep(for: .seconds(remaining))
        }
        delegate.cancel()  // This will cause the stream to finish
    }

    defer {
        timeoutTask.cancel()
    }

    for await data in dataStream {
        // Check for task cancellation
        if Task.isCancelled || isDeadlinePassed() {
            delegate.cancel()
            task.cancel()
            return Result(
                type: "read",
                success: true,
                status: 200,
                offset: currentOffset,
                chunks: allChunks,
                upToDate: true,  // Signal up-to-date on timeout
                cursor: lastCursor,
                headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
                paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
            )
        }

        guard let str = String(data: data, encoding: .utf8) else { continue }
        buffer.append(str)

        // Normalize line endings and process complete lines
        buffer = buffer.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")

        while let newlineIndex = buffer.firstIndex(of: "\n") {
            let line = String(buffer[..<newlineIndex])
            buffer = String(buffer[buffer.index(after: newlineIndex)...])

            if line.isEmpty {
                // Empty line = end of event
                if let eventType = currentEventType, !currentDataLines.isEmpty {
                    let dataStr = currentDataLines.joined(separator: "\n")

                    if eventType == "data" {
                        // Data event - collect chunk
                        allChunks.append(ReadChunk(data: dataStr, offset: currentOffset))
                    } else if eventType == "control" {
                        // Control event - parse JSON for metadata
                        if let jsonData = dataStr.data(using: .utf8),
                           let control = try? JSONDecoder().decode(SSEControlEvent.self, from: jsonData) {
                            currentOffset = control.streamNextOffset
                            lastCursor = control.streamCursor
                            lastUpToDate = control.upToDate ?? false
                        }
                    }
                }
                currentEventType = nil
                currentDataLines = []

                // Check if we should stop
                if allChunks.count >= maxChunks {
                    delegate.cancel()
                    task.cancel()
                    return Result(
                        type: "read",
                        success: true,
                        status: 200,
                        offset: currentOffset,
                        chunks: allChunks,
                        upToDate: lastUpToDate,
                        cursor: lastCursor,
                        headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
                        paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
                    )
                }

                // Return when up-to-date if:
                // 1. waitForUpToDate is set and we're up-to-date, OR
                // 2. We have data and we're up-to-date (catch-up complete)
                let shouldReturnOnUpToDate = waitForUpToDate || !allChunks.isEmpty
                if shouldReturnOnUpToDate && lastUpToDate {
                    delegate.cancel()
                    task.cancel()
                    return Result(
                        type: "read",
                        success: true,
                        status: 200,
                        offset: currentOffset,
                        chunks: allChunks,
                        upToDate: lastUpToDate,
                        cursor: lastCursor,
                        headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
                        paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
                    )
                }
            } else if line.hasPrefix("event:") {
                currentEventType = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                var content = String(line.dropFirst(5))
                if content.hasPrefix(" ") {
                    content = String(content.dropFirst())
                }
                currentDataLines.append(content)
            }
            // Ignore other SSE fields (id, retry, comments)
        }
    }

    // Stream ended
    return Result(
        type: "read",
        success: true,
        status: 200,
        offset: currentOffset,
        chunks: allChunks,
        upToDate: lastUpToDate,
        cursor: lastCursor,
        headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
        paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
    )
}

func handleHead(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    do {
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"

        if let cmdHeaders = cmd.headers {
            for (key, value) in cmdHeaders {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }

        let (_, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
        }

        if httpResponse.statusCode == 200 {
            let offset = httpResponse.value(forHTTPHeaderField: Headers.streamNextOffset)
            let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type")

            return Result(
                type: "head",
                success: true,
                status: 200,
                offset: offset,
                contentType: contentType
            )
        } else if httpResponse.statusCode == 404 {
            return errorResult(cmd.type, "NOT_FOUND", "Stream not found", status: 404)
        } else {
            return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
        }
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
}

func handleDelete(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard let url = URL(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    do {
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"

        if let cmdHeaders = cmd.headers {
            for (key, value) in cmdHeaders {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }

        let (_, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
        }

        if httpResponse.statusCode == 200 || httpResponse.statusCode == 204 {
            // Normalize to 200 for successful deletes
            return Result(type: "delete", success: true, status: 200)
        } else if httpResponse.statusCode == 404 {
            return errorResult(cmd.type, "NOT_FOUND", "Stream not found", status: 404)
        } else {
            return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
        }
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
}

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

func handleBenchmark(_ cmd: Command) async -> Result {
    guard let iterationId = cmd.iterationId, let operation = cmd.operation else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing iterationId or operation")
    }

    let startTime = DispatchTime.now()

    // Execute the benchmark operation
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
            let stream = try await DurableStream.connect(url: url)
            let data = Data(repeating: 0x41, count: size)  // 'A' bytes
            _ = try await stream.appendSync(data)
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
            // Create stream first (roundtrip uses new path each iteration)
            let contentType = operation.contentType ?? "application/octet-stream"
            let stream = try await DurableStream.create(url: url, contentType: contentType)

            // Generate appropriate data based on content type
            let data: Data
            if contentType.contains("json") {
                // Generate valid JSON for JSON streams
                let jsonString = String(repeating: "x", count: max(0, size - 4))
                let json = "\"\(jsonString)\""
                data = json.data(using: .utf8) ?? Data()
            } else {
                data = Data(repeating: 0x41, count: size)
            }

            _ = try await stream.appendSync(data)

            // Use specified live mode - read from start to get the data we just appended
            // For all modes including SSE, use catchUp since we just want to verify data was written
            _ = try await stream.read(offset: .start, live: .catchUp)
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

        var messagesProcessed = 0
        var bytesTransferred = 0

        do {
            // Create stream if it doesn't exist, otherwise connect
            let stream: DurableStream
            do {
                stream = try await DurableStream.create(url: url, contentType: operation.contentType ?? "application/octet-stream")
            } catch {
                // Stream might already exist, try to connect
                stream = try await DurableStream.connect(url: url)
            }

            let data = Data(repeating: 0x41, count: size)

            for _ in 0..<count {
                _ = try await stream.appendSync(data)
                messagesProcessed += 1
                bytesTransferred += size
            }
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
            // Read all data from the stream
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
                messagesProcessed: 1  // Single read operation
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

/// Execute an async operation with a timeout
func withTimeout<T: Sendable>(seconds: Double, operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask {
            try await operation()
        }

        group.addTask {
            try await Task.sleep(for: .seconds(seconds))
            throw TimeoutError()
        }

        let result = try await group.next()!
        group.cancelAll()
        return result
    }
}

struct TimeoutError: Error, Sendable {}

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

extension String {
    func normalizedContentType() -> String {
        let mediaType = self.split(separator: ";").first ?? Substring(self)
        return String(mediaType).trimmingCharacters(in: .whitespaces).lowercased()
    }
}

// Run the main loop
await main()
