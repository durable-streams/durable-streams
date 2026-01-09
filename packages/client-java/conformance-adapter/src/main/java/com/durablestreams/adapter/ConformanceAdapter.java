package com.durablestreams.adapter;

import com.durablestreams.*;
import com.durablestreams.exception.*;
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

    private static DurableStreamClient client;
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
            case "shutdown":
                return handleShutdown(cmd);
            default:
                return errorResult(type, "NOT_SUPPORTED", "Unknown command: " + type, 500);
        }
    }

    private static Map<String, Object> handleInit(Map<String, Object> cmd) {
        serverUrl = (String) cmd.get("serverUrl");

        // Create client
        client = DurableStreamClient.builder().build();

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

        try {
            Stream stream = client.stream(serverUrl + path);

            // Check if stream already exists (for idempotent behavior)
            boolean alreadyExists = false;
            try {
                stream.head();
                alreadyExists = true;
            } catch (StreamNotFoundException ignored) {
                // Stream doesn't exist, we'll create it
            }

            stream.create(contentType, ttl, null);
            Metadata meta = stream.head();

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
                Stream stream = client.stream(serverUrl + path);
                Metadata meta = stream.head();
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

        try {
            // Check if stream exists first for proper 404 handling
            if (bytes.length == 0) {
                // For empty data, check if stream exists first
                Stream stream = client.stream(serverUrl + path);
                try {
                    stream.head();  // Will throw 404 if not found
                    return errorResult("append", "INVALID_REQUEST", "Cannot append empty data", 400);
                } catch (StreamNotFoundException e) {
                    return errorResult("append", "NOT_FOUND", "Stream not found", 404);
                }
            }
            Stream stream = client.stream(serverUrl + path);
            stream.append(bytes, seq);

            // Capture what dynamic headers/params were sent with this request
            // Do this BEFORE head() because head() makes another request which increments counters
            Map<String, String> headersSent = new LinkedHashMap<>();
            Map<String, String> paramsSent = new LinkedHashMap<>();
            for (Map.Entry<String, DynamicValue> entry : dynamicHeaders.entrySet()) {
                headersSent.put(entry.getKey(), entry.getValue().getLastValue());
            }
            for (Map.Entry<String, DynamicValue> entry : dynamicParams.entrySet()) {
                paramsSent.put(entry.getKey(), entry.getValue().getLastValue());
            }

            // Get current offset from head (like TypeScript adapter)
            Metadata meta = stream.head();

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "append");
            result.put("success", true);
            result.put("status", 200);  // Always 200 for successful append
            if (meta.getNextOffset() != null) {
                result.put("offset", meta.getNextOffset().getValue());
            }
            if (!headersSent.isEmpty()) {
                result.put("headersSent", headersSent);
            }
            if (!paramsSent.isEmpty()) {
                result.put("paramsSent", paramsSent);
            }
            return result;
        } catch (StreamNotFoundException e) {
            return errorResult("append", "NOT_FOUND", "Stream not found", 404);
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

        try {
            Stream stream = client.stream(serverUrl + path);
            List<Map<String, Object>> chunks = new ArrayList<>();
            // Initialize with the request offset
            String finalOffset = offsetStr != null ? offsetStr : "-1";
            boolean upToDate = false;
            int status = 200;

            // For SSE mode, treat it as long-poll since we don't have true SSE streaming
            LiveMode effectiveMode = (liveMode == LiveMode.SSE) ? LiveMode.LONG_POLL : liveMode;

            try (ChunkIterator iterator = stream.read(offset, effectiveMode, timeout, null)) {
                int count = 0;
                int emptyCount = 0;
                while (count < maxChunks && emptyCount < 2) {
                    Chunk chunk;
                    if (effectiveMode != LiveMode.OFF) {
                        chunk = iterator.poll(timeout);
                        if (chunk == null) {
                            // Timeout with no new data means we're up-to-date
                            upToDate = true;
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
                        Map<String, Object> chunkObj = new LinkedHashMap<>();
                        chunkObj.put("data", chunk.getDataAsString());
                        if (chunk.getNextOffset() != null) {
                            chunkObj.put("offset", chunk.getNextOffset().getValue());
                        }
                        chunks.add(chunkObj);
                        emptyCount = 0;
                    } else if (upToDate) {
                        // Empty data with upToDate means we're caught up
                        break;
                    }

                    count++;

                    if (effectiveMode == LiveMode.OFF && upToDate) {
                        break;
                    }
                    if (Boolean.TRUE.equals(waitForUpToDate) && upToDate) {
                        break;
                    }
                }
            }

            // If no chunks were read, get offset from head
            if (chunks.isEmpty() && "-1".equals(finalOffset)) {
                try {
                    Metadata meta = stream.head();
                    if (meta.getNextOffset() != null) {
                        finalOffset = meta.getNextOffset().getValue();
                    }
                    upToDate = true;  // Empty stream is up-to-date
                } catch (StreamNotFoundException ignored) {
                    // Stream may have been deleted
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
        } catch (StreamNotFoundException e) {
            return errorResult("read", "NOT_FOUND", "Stream not found", 404);
        } catch (OffsetGoneException e) {
            return errorResult("read", "INVALID_OFFSET", e.getMessage(), 410);
        } catch (DurableStreamException e) {
            int statusCode = e.getStatusCode().orElse(500);
            String errorCode = errorCodeFromException(e);
            if (statusCode == 410) {
                errorCode = "INVALID_OFFSET";
            }
            return errorResult("read", errorCode, e.getMessage(), statusCode);
        } catch (RuntimeException e) {
            if (e.getCause() instanceof DurableStreamException) {
                DurableStreamException de = (DurableStreamException) e.getCause();
                int statusCode = de.getStatusCode().orElse(500);
                String errorCode = errorCodeFromException(de);
                if (statusCode == 410) {
                    errorCode = "INVALID_OFFSET";
                }
                return errorResult("read", errorCode, de.getMessage(), statusCode);
            }
            throw e;
        }
    }

    private static Map<String, Object> handleHead(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");

        try {
            Stream stream = client.stream(serverUrl + path);
            Metadata meta = stream.head();

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
            return errorResult("head", "NOT_FOUND", "Stream not found", 404);
        } catch (DurableStreamException e) {
            return errorResult("head", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    private static Map<String, Object> handleDelete(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");

        try {
            Stream stream = client.stream(serverUrl + path);
            stream.delete();

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "delete");
            result.put("success", true);
            result.put("status", 200);
            return result;
        } catch (StreamNotFoundException e) {
            return errorResult("delete", "NOT_FOUND", "Stream not found", 404);
        } catch (DurableStreamException e) {
            return errorResult("delete", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    private static Map<String, Object> handleConnect(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");

        try {
            Stream stream = client.stream(serverUrl + path);
            Metadata meta = stream.head();

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "connect");
            result.put("success", true);
            result.put("status", 200);
            if (meta.getNextOffset() != null) {
                result.put("offset", meta.getNextOffset().getValue());
            }
            return result;
        } catch (StreamNotFoundException e) {
            return errorResult("connect", "NOT_FOUND", "Stream not found", 404);
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
        String data = (String) cmd.get("data");

        String key = path + ":" + producerId;
        IdempotentProducer producer = producers.computeIfAbsent(key, k -> {
            IdempotentProducer.Config config = IdempotentProducer.Config.builder()
                    .epoch(epoch)
                    .build();
            return client.idempotentProducer(serverUrl + path, producerId, config);
        });

        try {
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

        try (IdempotentProducer producer = client.idempotentProducer(serverUrl + path, producerId, config)) {
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

    private static Map<String, Object> handleBenchmark(Map<String, Object> cmd) {
        String path = (String) cmd.get("path");
        String operation = (String) cmd.get("operation");
        Number iterationsNum = (Number) cmd.get("iterations");
        int iterations = iterationsNum != null ? iterationsNum.intValue() : 1000;
        Number warmupNum = (Number) cmd.get("warmup");
        int warmup = warmupNum != null ? warmupNum.intValue() : 100;

        try {
            Stream stream = client.stream(serverUrl + path);

            // Warmup
            for (int i = 0; i < warmup; i++) {
                runBenchmarkOp(stream, operation, i);
            }

            // Benchmark
            long startTime = System.nanoTime();
            for (int i = 0; i < iterations; i++) {
                runBenchmarkOp(stream, operation, i);
            }
            long endTime = System.nanoTime();

            double durationMs = (endTime - startTime) / 1_000_000.0;
            double opsPerSec = iterations / (durationMs / 1000.0);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "benchmark");
            result.put("success", true);
            result.put("iterations", iterations);
            result.put("durationMs", durationMs);
            result.put("opsPerSec", opsPerSec);
            return result;
        } catch (DurableStreamException e) {
            return errorResult("benchmark", errorCodeFromException(e), e.getMessage(),
                    e.getStatusCode().orElse(500));
        }
    }

    private static void runBenchmarkOp(Stream stream, String operation, int i) throws DurableStreamException {
        switch (operation) {
            case "append":
                stream.append(("{\"i\":" + i + "}").getBytes());
                break;
            case "head":
                stream.head();
                break;
            case "read":
                try (ChunkIterator it = stream.read(Offset.BEGINNING)) {
                    while (it.hasNext()) {
                        it.next();
                    }
                }
                break;
            default:
                throw new DurableStreamException("Unknown benchmark operation: " + operation);
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
        return "UNEXPECTED_STATUS";
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
