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

    struct DynamicValue {
        let type: String  // "counter", "timestamp", "token"
        var counter: Int = 0
        var tokenValue: String = ""
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

// MARK: - Main Loop

// Helper to flush stdout safely in async context
nonisolated func flushOutput() {
    fflush(stdout)
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
                print(jsonString)
                flushOutput()
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
                print(jsonString)
                flushOutput()
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
    guard let serverUrl = cmd.serverUrl else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing serverUrl")
    }

    await state.setServerURL(serverUrl)

    return Result(
        type: "init",
        success: true,
        clientName: ClientInfo.name,
        clientVersion: ClientInfo.version,
        features: Features(
            batching: true,
            sse: false,  // Not implemented yet
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

        let (_, response) = try await URLSession.shared.data(for: request)
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

        let (_, response) = try await URLSession.shared.data(for: request)
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

    do {
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

        // Add producer headers if present
        if let producerId = cmd.producerId {
            request.setValue(producerId, forHTTPHeaderField: Headers.producerId)
        }
        if let epoch = cmd.epoch {
            request.setValue(String(epoch), forHTTPHeaderField: Headers.producerEpoch)
        }
        if let seq = cmd.seq {
            request.setValue(String(seq), forHTTPHeaderField: Headers.producerSeq)
        }

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
        }

        let offset = httpResponse.value(forHTTPHeaderField: Headers.streamNextOffset)
        let isDuplicate = httpResponse.statusCode == 204
        let producerSeq = httpResponse.value(forHTTPHeaderField: Headers.producerSeq).flatMap { Int($0) }

        if httpResponse.statusCode == 200 || httpResponse.statusCode == 204 {
            return Result(
                type: "append",
                success: true,
                status: httpResponse.statusCode,
                offset: offset,
                duplicate: isDuplicate,
                producerSeq: producerSeq,
                headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
                paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
            )
        } else if httpResponse.statusCode == 403 {
            return errorResult(cmd.type, "FORBIDDEN", "Stale epoch", status: 403)
        } else if httpResponse.statusCode == 409 {
            return errorResult(cmd.type, "CONFLICT", "Sequence conflict", status: 409)
        } else {
            return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
        }
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
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

    do {
        let stream = try await DurableStream.connect(url: url)

        let producer = IdempotentProducer(
            stream: stream,
            producerId: producerId,
            epoch: cmd.epoch ?? 0,
            config: IdempotentProducer.Configuration(
                autoClaim: cmd.autoClaim ?? false
            )
        )

        // Append the data
        await producer.appendString(data)

        // Flush to ensure it's sent
        let flushResult = try await producer.flush()
        try await producer.close()

        return Result(
            type: "idempotent-append",
            success: true,
            status: 200,
            offset: flushResult.offset.rawValue,
            duplicate: flushResult.duplicateCount > 0
        )
    } catch let error as DurableStreamError {
        return errorResult(cmd.type, error.code.rawValue, error.message, status: error.status)
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
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

    do {
        let stream = try await DurableStream.connect(url: url)

        let producer = IdempotentProducer(
            stream: stream,
            producerId: producerId,
            epoch: cmd.epoch ?? 0,
            config: IdempotentProducer.Configuration(
                autoClaim: cmd.autoClaim ?? false,
                maxInFlight: cmd.maxInFlight ?? 1
            )
        )

        // Append all items
        for item in items {
            await producer.appendString(item)
        }

        // Flush to ensure all are sent
        _ = try await producer.flush()
        try await producer.close()

        return Result(
            type: "idempotent-append-batch",
            success: true,
            status: 200,
            producerSeq: items.count - 1  // 0-indexed sequence
        )
    } catch let error as DurableStreamError {
        return errorResult(cmd.type, error.code.rawValue, error.message, status: error.status)
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
}

func handleRead(_ cmd: Command) async -> Result {
    guard let path = cmd.path else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
    }

    let serverURL = await state.serverURL
    guard var components = URLComponents(string: serverURL + path) else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    var queryItems: [URLQueryItem] = []

    // Add offset
    let offset = cmd.offset ?? "-1"
    queryItems.append(URLQueryItem(name: QueryParams.offset, value: offset))

    // Add live mode
    if let live = cmd.live {
        switch live {
        case .bool(let value):
            if value {
                queryItems.append(URLQueryItem(name: QueryParams.live, value: "long-poll"))
            }
        case .string(let value):
            queryItems.append(URLQueryItem(name: QueryParams.live, value: value))
        }
    }

    // Add dynamic params
    let dynamicParams = await state.resolveDynamicParams()
    for (key, value) in dynamicParams {
        queryItems.append(URLQueryItem(name: key, value: value))
    }

    components.queryItems = queryItems

    guard let url = components.url else {
        return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
    }

    // Get dynamic headers
    let dynamicHeaders = await state.resolveDynamicHeaders()

    do {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"

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

        // Set timeout for long-poll
        if let timeoutMs = cmd.timeoutMs {
            request.timeoutInterval = Double(timeoutMs) / 1000.0
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
        }

        if httpResponse.statusCode == 200 || httpResponse.statusCode == 204 {
            let newOffset = httpResponse.value(forHTTPHeaderField: Headers.streamNextOffset)
            let upToDate = httpResponse.value(forHTTPHeaderField: Headers.streamUpToDate) != nil
            let cursor = httpResponse.value(forHTTPHeaderField: Headers.streamCursor)
            let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type")

            // Parse chunks
            var chunks: [ReadChunk] = []
            if !data.isEmpty {
                let isJSON = contentType?.normalizedContentType() == "application/json"

                if isJSON {
                    // Parse JSON array and create chunks for each item
                    if let jsonArray = try? JSONSerialization.jsonObject(with: data) as? [Any] {
                        for item in jsonArray {
                            if let itemData = try? JSONSerialization.data(withJSONObject: item),
                               let itemString = String(data: itemData, encoding: .utf8) {
                                chunks.append(ReadChunk(data: itemString, offset: newOffset))
                            }
                        }
                    } else if let text = String(data: data, encoding: .utf8) {
                        chunks.append(ReadChunk(data: text, offset: newOffset))
                    }
                } else {
                    // Binary or text
                    if let text = String(data: data, encoding: .utf8) {
                        chunks.append(ReadChunk(data: text, offset: newOffset))
                    } else {
                        chunks.append(ReadChunk(data: data.base64EncodedString(), binary: true, offset: newOffset))
                    }
                }
            }

            return Result(
                type: "read",
                success: true,
                status: httpResponse.statusCode,
                offset: newOffset,
                chunks: chunks,
                upToDate: upToDate,
                cursor: cursor,
                headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
                paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
            )
        } else if httpResponse.statusCode == 404 {
            return errorResult(cmd.type, "NOT_FOUND", "Stream not found", status: 404)
        } else if httpResponse.statusCode == 410 {
            return errorResult(cmd.type, "RETENTION_EXPIRED", "Data expired", status: 410)
        } else {
            return errorResult(cmd.type, "UNEXPECTED_STATUS", "Unexpected status: \(httpResponse.statusCode)", status: httpResponse.statusCode)
        }
    } catch let urlError as URLError where urlError.code == .timedOut {
        // Timeout is normal for long-poll
        return Result(
            type: "read",
            success: true,
            status: 204,
            chunks: [],
            upToDate: false,
            headersSent: dynamicHeaders.isEmpty ? nil : dynamicHeaders,
            paramsSent: dynamicParams.isEmpty ? nil : dynamicParams
        )
    } catch {
        return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
    }
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

        let (_, response) = try await URLSession.shared.data(for: request)
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

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            return errorResult(cmd.type, "NETWORK_ERROR", "Invalid response")
        }

        if httpResponse.statusCode == 200 || httpResponse.statusCode == 204 {
            return Result(type: "delete", success: true, status: httpResponse.statusCode)
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
            let stream = try await DurableStream.connect(url: url)
            let data = Data(repeating: 0x41, count: size)
            let appendResult = try await stream.appendSync(data)
            _ = try await stream.read(offset: appendResult.offset, live: .catchUp)
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

        do {
            let stream = try await DurableStream.connect(url: url)
            let data = Data(repeating: 0x41, count: size)

            for _ in 0..<count {
                _ = try await stream.appendSync(data)
            }
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }

    case "throughput_read":
        guard let path = operation.path else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Missing path")
        }
        let serverURL = await state.serverURL
        guard let url = URL(string: serverURL + path) else {
            return errorResult(cmd.type, "INTERNAL_ERROR", "Invalid URL")
        }

        do {
            _ = try await stream(url: url, offset: .start)
        } catch {
            return errorResult(cmd.type, "NETWORK_ERROR", error.localizedDescription)
        }

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

extension String {
    func normalizedContentType() -> String {
        let mediaType = self.split(separator: ";").first ?? Substring(self)
        return String(mediaType).trimmingCharacters(in: .whitespaces).lowercased()
    }
}

// Run the main loop
await main()
