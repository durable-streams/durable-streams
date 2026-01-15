package com.durablestreams;

import com.durablestreams.exception.*;
import com.durablestreams.exception.ParseErrorException;
import com.durablestreams.model.*;

import java.io.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Conformance test adapter for the Durable Streams Java client.
 * Communicates via stdin/stdout using JSON-lines protocol.
 * Zero external dependencies - uses built-in JSON parser.
 */
public class ConformanceAdapter {

    private static final String CLIENT_NAME = "durable-streams-java";
    private static final String CLIENT_VERSION = "0.1.0";

    private static DurableStream client;
    private static String serverUrl;

    // Dynamic header/param state
    private static final Map<String, DynamicValue> dynamicHeaders = new ConcurrentHashMap<>();
    private static final Map<String, DynamicValue> dynamicParams = new ConcurrentHashMap<>();

    // Idempotent producer cache
    private static final Map<String, IdempotentProducer> producers = new ConcurrentHashMap<>();

    public static void main(String[] args) throws Exception {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        PrintWriter writer = new PrintWriter(new BufferedOutputStream(System.out), true);

        String line;
        while ((line = reader.readLine()) != null) {
            if (line.trim().isEmpty()) continue;

            try {
                Map<String, Object> command = Json.parseObject(line);
                Map<String, Object> result = handleCommand(command);
                writer.println(Json.stringify(result));
            } catch (Exception e) {
                Map<String, Object> error = new LinkedHashMap<>();
                error.put("type", "error");
                error.put("success", false);
                error.put("message", e.getMessage());
                error.put("errorCode", "INTERNAL_ERROR");
                writer.println(Json.stringify(error));
            }
        }
    }

    private static Map<String, Object> handleCommand(Map<String, Object> cmd) {
        String type = (String) cmd.get("type");

        switch (type) {
            case "init":
                return handleInit(cmd);
            case "create":
                return handleCreate(cmd);
            case "append":
                return handleAppend(cmd);
            case "read":
                return handleRead(cmd);
            case "head":
                return handleHead(cmd);
            case "delete":
                return handleDelete(cmd);
            case "connect":
                return handleConnect(cmd);
            case "idempotent-append":
                return handleIdempotentAppend(cmd);
            case "idempotent-append-batch":
                return handleIdempotentAppendBatch(cmd);
            case "set-dynamic-header":
                return handleSetDynamicHeader(cmd);
            case "set-dynamic-param":
                return handleSetDynamicParam(cmd);
            case "clear-dynamic":
                return handleClearDynamic(cmd);
            case "benchmark":
                return handleBenchmark(cmd);
            case "validate":
                return handleValidate(cmd);
            case "shutdown":
                return handleShutdown(cmd);
            default:
                return errorResult(type, "NOT_SUPPORTED", "Unknown command: " + type, 500);
        }
    }

    private static Map<String, Object> handleInit(Map<String, Object> cmd) {
        serverUrl = (String) cmd.get("serverUrl");

        // Create client
        client = DurableStream.builder().build();

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("type", "init");
        result.put("success", true);
        result.put("clientName", CLIENT_NAME);
        result.put("clientVersion", CLIENT_VERSION);

        Map<String, Object> features = new LinkedHashMap<>();
        features.put("batching", true);
        features.put("sse", true);
        features.put("longPoll", true);
        features.put("streaming", true);
        features.put("dynamicHeaders", true);
        result.put("features", features);

        return result;
    }

    private static Map<String, Object> handleCreate(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");
        String contentType = (String) cmd.get("contentType");
        Number ttlSecondsNum = (Number) cmd.get("ttlSeconds");
        Long ttlSeconds = ttlSecondsNum != null ? ttlSecondsNum.longValue() : null;

        Duration ttl = ttlSeconds != null ? Duration.ofSeconds(ttlSeconds) : null;

        String url = serverUrl + path;
        try {
            // Check if stream already exists (for idempotent behavior)
            boolean alreadyExists = false;
            try {
                client.head(url);
                alreadyExists = true;
            } catch (StreamNotFoundException ignored) {
                // Stream doesn't exist, we'll create it
            }

            client.create(url, contentType, ttl, null);
            Metadata meta = client.head(url);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "create");
            result.put("success", true);
            result.put("status", alreadyExists ? 200 : 201);  // 200 if existed, 201 if new
            if (meta.getNextOffset() != null) {
                result.put("offset", meta.getNextOffset().getValue());
            }
            return result;
        } catch (StreamExistsException e) {
            // Stream was created between our check and create call - treat as idempotent success
            try {
                Metadata meta = client.head(url);
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("type", "create");
                result.put("success", true);
                result.put("status", 200);  // Idempotent create
                if (meta.getNextOffset() != null) {
                    result.put("offset", meta.getNextOffset().getValue());
                }
                return result;
            } catch (DurableStreamException ex) {
                return errorResult("create", "CONFLICT", "Stream already exists", 409);
            }
        } catch (DurableStreamException e) {
            return errorResult("create", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    private static Map<String, Object> handleAppend(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");
        String data = (String) cmd.get("data");
        Boolean binary = (Boolean) cmd.get("binary");
        Number seqNum = (Number) cmd.get("seq");
        Long seq = seqNum != null ? seqNum.longValue() : null;

        byte[] bytes;
        if (Boolean.TRUE.equals(binary) && data != null) {
            bytes = Base64.getDecoder().decode(data);
        } else if (data != null) {
            bytes = data.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        } else {
            bytes = new byte[0];
        }

        String url = serverUrl + path;
        try {
            // Check if stream exists first for proper 404 handling
            if (bytes.length == 0) {
                // For empty data, check if stream exists first
                try {
                    client.head(url);  // Will throw 404 if not found
                    return errorResult("append", "INVALID_REQUEST", "Cannot append empty data", 400);
                } catch (StreamNotFoundException e) {
                    return errorResult("append", "NOT_FOUND", e.getMessage(), 404);
                }
            }

            // Evaluate dynamic headers/params ONCE for this command
            // Capture the values and create fixed suppliers (matching TypeScript behavior)
            Map<String, String> headersSent = new LinkedHashMap<>();
            Map<String, String> paramsSent = new LinkedHashMap<>();
            for (Map.Entry<String, DynamicValue> entry : dynamicHeaders.entrySet()) {
                String value = entry.getValue().getValue();  // Increment counter once
                headersSent.put(entry.getKey(), value);
                // Replace with fixed supplier for all requests in this command
                final String capturedValue = value;
                client.setDynamicHeader(entry.getKey(), () -> capturedValue);
            }
            for (Map.Entry<String, DynamicValue> entry : dynamicParams.entrySet()) {
                String value = entry.getValue().getValue();  // Increment counter once
                paramsSent.put(entry.getKey(), value);
                final String capturedValue = value;
                client.setDynamicParam(entry.getKey(), () -> capturedValue);
            }

            try {
                AppendResult appendResult = client.append(url, bytes, seq);

                // Get offset - prefer from AppendResult, fallback to head()
                String offset = null;
                if (appendResult.getNextOffset() != null) {
                    offset = appendResult.getNextOffset().getValue();
                } else {
                    // Fallback to head() if append didn't return offset
                    Metadata meta = client.head(url);
                    if (meta.getNextOffset() != null) {
                        offset = meta.getNextOffset().getValue();
                    }
                }

                Map<String, Object> result = new LinkedHashMap<>();
                result.put("type", "append");
                result.put("success", true);
                result.put("status", 200);  // Always 200 for successful append
                if (offset != null) {
                    result.put("offset", offset);
                }
                if (!headersSent.isEmpty()) {
                    result.put("headersSent", headersSent);
                }
                if (!paramsSent.isEmpty()) {
                    result.put("paramsSent", paramsSent);
                }
                return result;
            } finally {
                // Restore original dynamic suppliers for next command
                for (Map.Entry<String, DynamicValue> entry : dynamicHeaders.entrySet()) {
                    client.setDynamicHeader(entry.getKey(), entry.getValue()::getValue);
                }
                for (Map.Entry<String, DynamicValue> entry : dynamicParams.entrySet()) {
                    client.setDynamicParam(entry.getKey(), entry.getValue()::getValue);
                }
            }
        } catch (StreamNotFoundException e) {
            return errorResult("append", "NOT_FOUND", e.getMessage(), 404);
        } catch (SequenceConflictException e) {
            return errorResult("append", "SEQUENCE_CONFLICT", e.getMessage(), 409);
        } catch (DurableStreamException e) {
            return errorResult("append", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    private static Map<String, Object> handleRead(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");
        String offsetStr = (String) cmd.get("offset");
        Object liveValue = cmd.get("live");
        Number timeoutMsNum = (Number) cmd.get("timeoutMs");
        Long timeoutMs = timeoutMsNum != null ? timeoutMsNum.longValue() : null;
        Number maxChunksNum = (Number) cmd.get("maxChunks");
        int maxChunks = maxChunksNum != null ? maxChunksNum.intValue() : 100;
        Boolean waitForUpToDate = (Boolean) cmd.get("waitForUpToDate");

        Offset offset = offsetStr != null ? Offset.of(offsetStr) : Offset.BEGINNING;
        LiveMode liveMode = parseLiveMode(liveValue);
        // For SSE, use a shorter timeout for conformance tests
        Duration timeout;
        if (timeoutMs != null) {
            timeout = Duration.ofMillis(timeoutMs);
        } else if (liveMode == LiveMode.SSE) {
            timeout = Duration.ofSeconds(5);
        } else if (liveMode == LiveMode.LONG_POLL) {
            timeout = Duration.ofSeconds(30);
        } else {
            timeout = Duration.ofSeconds(30);
        }

        String url = serverUrl + path;
        try {
            List<Map<String, Object>> chunks = new ArrayList<>();
            // Initialize with the request offset
            String finalOffset = offsetStr != null ? offsetStr : "-1";
            boolean upToDate = false;
            int status = 200;

            // Track if this is a JSON stream (determined from first chunk's content-type)
            Boolean jsonStream = null;

            // SSE mode now uses true streaming
            LiveMode effectiveMode = liveMode;

            try (ChunkIterator iterator = client.read(url, ReadOptions.from(offset).live(effectiveMode).timeout(timeout))) {
                int count = 0;
                int emptyCount = 0;
                while (count < maxChunks && emptyCount < 2) {
                    Chunk chunk;
                    if (effectiveMode != LiveMode.OFF) {
                        chunk = iterator.poll(timeout);
                        if (chunk == null) {
                            // Timeout with no new data means we're up-to-date
                            // For long-poll, this is a 204 response
                            upToDate = true;
                            status = 204;
                            emptyCount++;
                            if (emptyCount >= 2) {
                                break;
                            }
                            continue;
                        }
                    } else {
                        if (!iterator.hasNext()) {
                            // No more data in catch-up mode
                            upToDate = true;
                            break;
                        }
                        chunk = iterator.next();
                    }

                    status = chunk.getStatusCode();
                    if (chunk.getNextOffset() != null) {
                        finalOffset = chunk.getNextOffset().getValue();
                    }
                    upToDate = chunk.isUpToDate();

                    if (chunk.getData() != null && chunk.getData().length > 0) {
                        String dataStr = chunk.getDataAsString();

                        // Determine if JSON stream from first chunk's content-type header
                        if (jsonStream == null) {
                            jsonStream = isJsonContentType(chunk);
                        }

                        // Validate JSON for JSON streams
                        if (Boolean.TRUE.equals(jsonStream) && !isValidJson(dataStr)) {
                            throw new ParseErrorException("Invalid JSON in stream response: " + dataStr);
                        }

                        Map<String, Object> chunkObj = new LinkedHashMap<>();
                        chunkObj.put("data", dataStr);
                        if (chunk.getNextOffset() != null) {
                            chunkObj.put("offset", chunk.getNextOffset().getValue());
                        }
                        chunks.add(chunkObj);
                        emptyCount = 0;
                        // Only count chunks with actual data toward maxChunks limit
                        count++;
                    } else if (upToDate && effectiveMode == LiveMode.OFF) {
                        // Empty data with upToDate means we're caught up (catch-up mode only)
                        break;
                    } else if (chunk.getData() == null || chunk.getData().length == 0) {
                        // Empty chunk in live mode - count toward emptyCount to avoid infinite loop
                        emptyCount++;
                    }

                    if (effectiveMode == LiveMode.OFF && upToDate) {
                        break;
                    }
                    if (Boolean.TRUE.equals(waitForUpToDate) && upToDate) {
                        break;
                    }
                }

                // Get the final offset from the iterator (handles offset="now" case)
                // The iterator tracks the actual offset from server responses
                if (iterator.getCurrentOffset() != null) {
                    String iterOffset = iterator.getCurrentOffset().getValue();
                    // Only use iterator offset if we haven't got a better one from chunks
                    // and it's not a special value like "-1"
                    if (!"-1".equals(iterOffset) && (chunks.isEmpty() || "now".equals(finalOffset) || "-1".equals(finalOffset))) {
                        finalOffset = iterOffset;
                    }
                }
            }

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "read");
            result.put("success", true);
            result.put("status", status);
            result.put("chunks", chunks);
            result.put("offset", finalOffset);  // Always return offset
            result.put("upToDate", upToDate);
            // Capture what dynamic headers/params were sent with this request
            Map<String, String> headersSent = new LinkedHashMap<>();
            Map<String, String> paramsSent = new LinkedHashMap<>();
            for (Map.Entry<String, DynamicValue> entry : dynamicHeaders.entrySet()) {
                headersSent.put(entry.getKey(), entry.getValue().getLastValue());
            }
            for (Map.Entry<String, DynamicValue> entry : dynamicParams.entrySet()) {
                paramsSent.put(entry.getKey(), entry.getValue().getLastValue());
            }
            if (!headersSent.isEmpty()) {
                result.put("headersSent", headersSent);
            }
            if (!paramsSent.isEmpty()) {
                result.put("paramsSent", paramsSent);
            }
            return result;
        } catch (ParseErrorException e) {
            return errorResult("read", "PARSE_ERROR", e.getMessage(), 500);
        } catch (StreamNotFoundException e) {
            return errorResult("read", "NOT_FOUND", e.getMessage(), 404);
        } catch (OffsetGoneException e) {
            return errorResult("read", "INVALID_OFFSET", e.getMessage(), 410);
        } catch (DurableStreamException e) {
            int statusCode = e.getStatusCode().orElse(500);
            String errorCode = errorCodeFromException(e);
            // Map both 400 and 410 to INVALID_OFFSET for offset-related errors
            if (statusCode == 410 || statusCode == 400) {
                errorCode = "INVALID_OFFSET";
            }
            return errorResult("read", errorCode, e.getMessage(), statusCode);
        } catch (RuntimeException e) {
            if (e.getCause() instanceof ParseErrorException) {
                ParseErrorException pe = (ParseErrorException) e.getCause();
                return errorResult("read", "PARSE_ERROR", pe.getMessage(), 500);
            }
            if (e.getCause() instanceof DurableStreamException) {
                DurableStreamException de = (DurableStreamException) e.getCause();
                int statusCode = de.getStatusCode().orElse(500);
                String errorCode = errorCodeFromException(de);
                // Map both 400 and 410 to INVALID_OFFSET for offset-related errors
                if (statusCode == 410 || statusCode == 400) {
                    errorCode = "INVALID_OFFSET";
                }
                return errorResult("read", errorCode, de.getMessage(), statusCode);
            }
            throw e;
        }
    }

    private static Map<String, Object> handleHead(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");
        String url = serverUrl + path;

        try {
            Metadata meta = client.head(url);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "head");
            result.put("success", true);
            result.put("status", 200);
            if (meta.getNextOffset() != null) {
                result.put("offset", meta.getNextOffset().getValue());
            }
            if (meta.getContentType() != null) {
                result.put("contentType", meta.getContentType());
            }
            return result;
        } catch (StreamNotFoundException e) {
            return errorResult("head", "NOT_FOUND", e.getMessage(), 404);
        } catch (DurableStreamException e) {
            return errorResult("head", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    private static Map<String, Object> handleDelete(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");
        String url = serverUrl + path;

        try {
            client.delete(url);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "delete");
            result.put("success", true);
            result.put("status", 200);
            return result;
        } catch (StreamNotFoundException e) {
            return errorResult("delete", "NOT_FOUND", e.getMessage(), 404);
        } catch (DurableStreamException e) {
            return errorResult("delete", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    private static Map<String, Object> handleConnect(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");
        String url = serverUrl + path;

        try {
            Metadata meta = client.head(url);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "connect");
            result.put("success", true);
            result.put("status", 200);
            if (meta.getNextOffset() != null) {
                result.put("offset", meta.getNextOffset().getValue());
            }
            return result;
        } catch (StreamNotFoundException e) {
            return errorResult("connect", "NOT_FOUND", e.getMessage(), 404);
        } catch (DurableStreamException e) {
            return errorResult("connect", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    private static Map<String, Object> handleIdempotentAppend(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");
        String producerId = (String) cmd.get("producerId");
        Number epochNum = (Number) cmd.get("epoch");
        long epoch = epochNum != null ? epochNum.longValue() : 0;
        Boolean autoClaim = (Boolean) cmd.get("autoClaim");
        String data = (String) cmd.get("data");

        // Create producer with proper config including autoClaim
        IdempotentProducer.Config config = IdempotentProducer.Config.builder()
                .epoch(epoch)
                .autoClaim(Boolean.TRUE.equals(autoClaim))
                .lingerMs(0)
                .maxBatchBytes(1024)
                .build();

        try (IdempotentProducer producer = client.producer(serverUrl + path, producerId, config)) {
            producer.append(data);
            producer.flush();

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "idempotent-append");
            result.put("success", true);
            result.put("status", 200);
            return result;
        } catch (StaleEpochException e) {
            return errorResult("idempotent-append", "STALE_EPOCH", e.getMessage(), 403);
        } catch (DurableStreamException e) {
            return errorResult("idempotent-append", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> handleIdempotentAppendBatch(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");
        String producerId = (String) cmd.get("producerId");
        Number epochNum = (Number) cmd.get("epoch");
        long epoch = epochNum != null ? epochNum.longValue() : 0;
        Number maxInFlightNum = (Number) cmd.get("maxInFlight");
        int maxInFlight = maxInFlightNum != null ? maxInFlightNum.intValue() : 5;
        Boolean autoClaim = (Boolean) cmd.get("autoClaim");
        List<Object> items = (List<Object>) cmd.get("items");

        IdempotentProducer.Config config = IdempotentProducer.Config.builder()
                .epoch(epoch)
                .maxInFlight(maxInFlight)
                .autoClaim(Boolean.TRUE.equals(autoClaim))
                .lingerMs(0)
                .maxBatchBytes(100)
                .build();

        try (IdempotentProducer producer = client.producer(serverUrl + path, producerId, config)) {
            for (Object item : items) {
                producer.append(item.toString());
            }
            producer.flush();

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "idempotent-append-batch");
            result.put("success", true);
            result.put("status", 200);
            return result;
        } catch (StaleEpochException e) {
            return errorResult("idempotent-append-batch", "STALE_EPOCH", e.getMessage(), 403);
        } catch (DurableStreamException e) {
            return errorResult("idempotent-append-batch", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    private static Map<String, Object> handleSetDynamicHeader(Map<String, Object> cmd) {
        String name = (String) cmd.get("name");
        String valueType = (String) cmd.get("valueType");
        String initialValue = (String) cmd.get("initialValue");

        DynamicValue dv = new DynamicValue(valueType, initialValue);
        dynamicHeaders.put(name, dv);
        client.setDynamicHeader(name, dv::getValue);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("type", "set-dynamic-header");
        result.put("success", true);
        return result;
    }

    private static Map<String, Object> handleSetDynamicParam(Map<String, Object> cmd) {
        String name = (String) cmd.get("name");
        String valueType = (String) cmd.get("valueType");
        String initialValue = (String) cmd.get("initialValue");

        DynamicValue dv = new DynamicValue(valueType, initialValue);
        dynamicParams.put(name, dv);
        client.setDynamicParam(name, dv::getValue);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("type", "set-dynamic-param");
        result.put("success", true);
        return result;
    }

    private static Map<String, Object> handleClearDynamic(Map<String, Object> cmd) {
        dynamicHeaders.clear();
        dynamicParams.clear();
        client.clearDynamic();

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("type", "clear-dynamic");
        result.put("success", true);
        return result;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> handleBenchmark(Map<String, Object> cmd) {
        String iterationId = (String) cmd.get("iterationId");
        Map<String, Object> operation = (Map<String, Object>) cmd.get("operation");
        String op = (String) operation.get("op");
        String path = (String) operation.get("path");

        try {
            long startTime = System.nanoTime();
            Map<String, Object> metrics = new LinkedHashMap<>();

            switch (op) {
                case "append": {
                    Number sizeNum = (Number) operation.get("size");
                    int size = sizeNum != null ? sizeNum.intValue() : 100;
                    String url = serverUrl + path;
                    byte[] payload = new byte[size];
                    java.util.Arrays.fill(payload, (byte) 42);
                    client.append(url, payload);
                    metrics.put("bytesTransferred", size);
                    break;
                }
                case "read": {
                    String offset = (String) operation.get("offset");
                    String url = serverUrl + path;
                    int totalBytes = 0;
                    try (ChunkIterator it = client.read(url, ReadOptions.from(offset != null ? Offset.of(offset) : Offset.BEGINNING))) {
                        while (it.hasNext()) {
                            Chunk chunk = it.next();
                            totalBytes += chunk.getData().length;
                        }
                    }
                    metrics.put("bytesTransferred", totalBytes);
                    break;
                }
                case "roundtrip": {
                    Number sizeNum = (Number) operation.get("size");
                    int size = sizeNum != null ? sizeNum.intValue() : 100;
                    String contentType = (String) operation.get("contentType");
                    String liveMode = (String) operation.get("live");

                    String url = serverUrl + path;
                    try {
                        client.create(url, contentType != null ? contentType : "application/octet-stream");
                    } catch (StreamExistsException ignored) {}

                    byte[] payload = new byte[size];
                    java.util.Arrays.fill(payload, (byte) 42);

                    try {
                        client.append(url, payload);
                    } catch (DurableStreamException e) {
                        // Append failed, but still return timing (like Go does)
                        metrics.put("bytesTransferred", 0);
                        break;
                    }

                    // Read back
                    LiveMode mode = "sse".equals(liveMode) ? LiveMode.SSE : LiveMode.LONG_POLL;
                    int readBytes = 0;
                    try (ChunkIterator it = client.read(url, ReadOptions.fromBeginning().live(mode).timeout(Duration.ofSeconds(5)))) {
                        Chunk chunk = it.poll(Duration.ofSeconds(5));
                        if (chunk != null) {
                            readBytes = chunk.getData().length;
                        }
                    } catch (Exception e) {
                        // Read failed, but still return timing (like Go does)
                    }
                    metrics.put("bytesTransferred", size + readBytes);
                    break;
                }
                case "create": {
                    String contentType = (String) operation.get("contentType");
                    String url = serverUrl + path;
                    try {
                        client.create(url, contentType != null ? contentType : "application/octet-stream");
                    } catch (StreamExistsException ignored) {}
                    break;
                }
                case "throughput_append": {
                    Number sizeNum = (Number) operation.get("size");
                    Number countNum = (Number) operation.get("count");
                    Number concurrencyNum = (Number) operation.get("concurrency");
                    int size = sizeNum != null ? sizeNum.intValue() : 100;
                    int count = countNum != null ? countNum.intValue() : 1000;
                    int concurrency = concurrencyNum != null ? concurrencyNum.intValue() : 10;

                    String url = serverUrl + path;
                    try {
                        client.create(url, "application/octet-stream");
                    } catch (StreamExistsException ignored) {}

                    byte[] payload = new byte[size];
                    java.util.Arrays.fill(payload, (byte) 42);

                    // Use IdempotentProducer for batching and pipelining (like Go)
                    IdempotentProducer.Config producerConfig = IdempotentProducer.Config.builder()
                            .lingerMs(0)  // Will normalize to 5ms like Go
                            .build();
                    IdempotentProducer producer = client.producer(url, "bench-producer", producerConfig);

                    try {
                        for (int i = 0; i < count; i++) {
                            producer.append(payload);
                        }
                        producer.flush();
                    } finally {
                        producer.close();
                    }

                    metrics.put("bytesTransferred", count * size);
                    metrics.put("messagesProcessed", count);
                    break;
                }
                case "throughput_read": {
                    String url = serverUrl + path;
                    int totalBytes = 0;
                    int msgCount = 0;
                    try (ChunkIterator it = client.read(url, ReadOptions.fromBeginning())) {
                        while (it.hasNext()) {
                            Chunk chunk = it.next();
                            totalBytes += chunk.getData().length;
                            msgCount++;
                        }
                    }
                    metrics.put("bytesTransferred", totalBytes);
                    metrics.put("messagesProcessed", msgCount);
                    break;
                }
                default:
                    return errorResult("benchmark", "NOT_SUPPORTED", "Unknown benchmark operation: " + op, 400);
            }

            long endTime = System.nanoTime();
            long durationNs = endTime - startTime;

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "benchmark");
            result.put("success", true);
            result.put("iterationId", iterationId);
            result.put("durationNs", String.valueOf(durationNs));
            result.put("metrics", metrics);
            return result;
        } catch (DurableStreamException e) {
            return errorResult("benchmark", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> handleValidate(Map<String, Object> cmd) {
        Map<String, Object> target = (Map<String, Object>) cmd.get("target");
        if (target == null) {
            return errorResult("validate", "PARSE_ERROR", "missing target", 400);
        }

        String targetType = (String) target.get("target");

        switch (targetType) {
            case "idempotent-producer": {
                Number epochNum = (Number) target.get("epoch");
                long epoch = epochNum != null ? epochNum.longValue() : 0;
                Number maxBatchBytesNum = (Number) target.get("maxBatchBytes");
                long maxBatchBytes = maxBatchBytesNum != null ? maxBatchBytesNum.longValue() : 1048576;

                if (epoch < 0) {
                    return errorResult("validate", "INVALID_ARGUMENT", "epoch must be non-negative, got: " + epoch, 400);
                }

                if (maxBatchBytes < 1) {
                    return errorResult("validate", "INVALID_ARGUMENT", "maxBatchBytes must be positive, got: " + maxBatchBytes, 400);
                }

                Map<String, Object> result = new LinkedHashMap<>();
                result.put("type", "validate");
                result.put("success", true);
                return result;
            }
            case "retry-options": {
                Number maxRetriesNum = (Number) target.get("maxRetries");
                long maxRetries = maxRetriesNum != null ? maxRetriesNum.longValue() : 3;
                Number initialDelayMsNum = (Number) target.get("initialDelayMs");
                long initialDelayMs = initialDelayMsNum != null ? initialDelayMsNum.longValue() : 100;
                Number maxDelayMsNum = (Number) target.get("maxDelayMs");
                long maxDelayMs = maxDelayMsNum != null ? maxDelayMsNum.longValue() : 5000;
                Number multiplierNum = (Number) target.get("multiplier");
                double multiplier = multiplierNum != null ? multiplierNum.doubleValue() : 2.0;

                if (maxRetries < 0) {
                    return errorResult("validate", "INVALID_ARGUMENT", "maxRetries must be non-negative, got: " + maxRetries, 400);
                }

                if (initialDelayMs < 1) {
                    return errorResult("validate", "INVALID_ARGUMENT", "initialDelayMs must be positive, got: " + initialDelayMs, 400);
                }

                if (maxDelayMs < 1) {
                    return errorResult("validate", "INVALID_ARGUMENT", "maxDelayMs must be positive, got: " + maxDelayMs, 400);
                }

                if (multiplier < 1.0) {
                    return errorResult("validate", "INVALID_ARGUMENT", "multiplier must be >= 1.0, got: " + multiplier, 400);
                }

                Map<String, Object> result = new LinkedHashMap<>();
                result.put("type", "validate");
                result.put("success", true);
                return result;
            }
            default:
                return errorResult("validate", "NOT_SUPPORTED", "Unknown validation target: " + targetType, 400);
        }
    }

    private static Map<String, Object> handleShutdown(Map<String, Object> cmd) {
        for (IdempotentProducer producer : producers.values()) {
            try {
                producer.close();
            } catch (Exception e) {
                // Ignore
            }
        }
        producers.clear();

        if (client != null) {
            client.close();
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("type", "shutdown");
        result.put("success", true);
        return result;
    }

    private static LiveMode parseLiveMode(Object value) {
        if (value == null) return LiveMode.OFF;
        if (value instanceof Boolean) {
            return ((Boolean) value) ? LiveMode.LONG_POLL : LiveMode.OFF;
        }
        String s = value.toString().toLowerCase();
        switch (s) {
            case "long-poll":
            case "longpoll":
                return LiveMode.LONG_POLL;
            case "sse":
                return LiveMode.SSE;
            case "true":
                return LiveMode.LONG_POLL;
            case "false":
            case "off":
            case "":
                return LiveMode.OFF;
            default:
                return LiveMode.OFF;
        }
    }

    private static String errorCodeFromException(DurableStreamException e) {
        if (e instanceof StreamNotFoundException) return "NOT_FOUND";
        if (e instanceof StreamExistsException) return "CONFLICT";
        if (e instanceof SequenceConflictException) return "SEQUENCE_CONFLICT";
        if (e instanceof StaleEpochException) return "STALE_EPOCH";
        if (e instanceof OffsetGoneException) return "INVALID_OFFSET";
        if (e instanceof ParseErrorException) return "PARSE_ERROR";
        return "UNEXPECTED_STATUS";
    }

    private static boolean isValidJson(String data) {
        if (data == null || data.trim().isEmpty()) {
            return false;
        }
        try {
            Json.parse(data);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isJsonContentType(Chunk chunk) {
        if (chunk == null) {
            return false;
        }
        Map<String, String> headers = chunk.getHeaders();
        if (headers == null) {
            return false;
        }
        String contentType = headers.get("content-type");
        return contentType != null && contentType.toLowerCase().contains("application/json");
    }

    private static Map<String, Object> errorResult(String commandType, String errorCode, String message, int status) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("type", "error");
        result.put("success", false);
        result.put("commandType", commandType);
        result.put("errorCode", errorCode);
        result.put("message", message);
        result.put("status", status);
        return result;
    }

    private static class DynamicValue {
        private final String type;
        private final AtomicLong counter;
        private String staticValue;
        private volatile String lastValue;

        DynamicValue(String type, String initialValue) {
            this.type = type != null ? type : "static";
            this.counter = new AtomicLong(0);
            this.staticValue = initialValue;
            this.lastValue = initialValue;
        }

        String getValue() {
            String value;
            switch (type) {
                case "counter":
                    value = String.valueOf(counter.incrementAndGet());
                    break;
                case "timestamp":
                    value = String.valueOf(System.currentTimeMillis());
                    break;
                case "static":
                default:
                    value = staticValue;
            }
            lastValue = value;
            return value;
        }

        // Get the last returned value without incrementing
        String getLastValue() {
            return lastValue;
        }
    }
}
