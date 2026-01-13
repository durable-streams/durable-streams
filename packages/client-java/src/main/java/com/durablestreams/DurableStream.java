package com.durablestreams;

import com.durablestreams.exception.*;
import com.durablestreams.internal.RetryPolicy;
import com.durablestreams.model.*;

import java.io.*;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

/**
 * Handle for stream operations (create, append, read, delete, head).
 */
public final class DurableStream {

    private final DurableStreamClient client;
    private final String url;

    DurableStream(DurableStreamClient client, String url) {
        this.client = client;
        this.url = url;
    }

    /**
     * Create the stream with default content type (application/octet-stream).
     */
    public void create() throws DurableStreamException {
        create(null, null, null);
    }

    /**
     * Create the stream with specified content type.
     */
    public void create(String contentType) throws DurableStreamException {
        create(contentType, null, null);
    }

    /**
     * Create the stream with full options.
     *
     * @param contentType MIME type for the stream
     * @param ttl Time-to-live duration
     * @param expiresAt Absolute expiration time
     */
    public void create(String contentType, Duration ttl, Instant expiresAt) throws DurableStreamException {
        HttpRequest request = buildCreateRequest(contentType, ttl, expiresAt);
        executeWithRetry(request, "create", this::parseCreateResponse);
    }

    /**
     * Append data to the stream.
     */
    public AppendResult append(byte[] data) throws DurableStreamException {
        return append(data, null);
    }

    /**
     * Append data with optional sequence number.
     */
    public AppendResult append(byte[] data, Long seq) throws DurableStreamException {
        if (data == null || data.length == 0) {
            throw new DurableStreamException("Cannot append empty data");
        }

        HttpRequest request = buildAppendRequest(data, seq);
        return executeWithRetry(request, "append", response -> parseAppendResponse(response, seq));
    }

    /**
     * Get stream metadata.
     */
    public Metadata head() throws DurableStreamException {
        HttpRequest request = buildHeadRequest();
        return executeWithRetry(request, "head", this::parseHeadResponse);
    }

    /**
     * Delete the stream.
     */
    public void delete() throws DurableStreamException {
        HttpRequest request = buildDeleteRequest();
        executeWithRetry(request, "delete", this::parseDeleteResponse);
    }

    /**
     * Read from the stream (catch-up mode).
     */
    public ChunkIterator read() throws DurableStreamException {
        return read(null, LiveMode.OFF, null, null);
    }

    /**
     * Read from the stream with offset.
     */
    public ChunkIterator read(Offset offset) throws DurableStreamException {
        return read(offset, LiveMode.OFF, null, null);
    }

    /**
     * Read from the stream with full options.
     */
    public ChunkIterator read(Offset offset, LiveMode liveMode, Duration timeout, String cursor)
            throws DurableStreamException {
        return new ChunkIterator(this, offset, liveMode, timeout, cursor);
    }

    /**
     * Read JSON from the stream with type-safe parsing.
     *
     * <p>Example with Gson:
     * <pre>{@code
     * Gson gson = new Gson();
     * Type listType = new TypeToken<List<Event>>(){}.getType();
     *
     * try (var iter = stream.readJson(json -> gson.fromJson(json, listType))) {
     *     for (Event event : iter.items()) {
     *         process(event);
     *     }
     * }
     * }</pre>
     *
     * @param parser Function that parses JSON string into a list of items
     * @param <T> The type of items in the JSON stream
     */
    public <T> JsonIterator<T> readJson(Function<String, List<T>> parser) throws DurableStreamException {
        return readJson(parser, null, LiveMode.OFF, null, null);
    }

    /**
     * Read JSON from the stream with offset.
     */
    public <T> JsonIterator<T> readJson(Function<String, List<T>> parser, Offset offset)
            throws DurableStreamException {
        return readJson(parser, offset, LiveMode.OFF, null, null);
    }

    /**
     * Read JSON from the stream with full options.
     */
    public <T> JsonIterator<T> readJson(Function<String, List<T>> parser, Offset offset,
                                         LiveMode liveMode, Duration timeout, String cursor)
            throws DurableStreamException {
        ChunkIterator chunkIterator = new ChunkIterator(this, offset, liveMode, timeout, cursor);
        return new JsonIterator<>(chunkIterator, parser);
    }

    // ==================== Async API ====================

    /**
     * Create the stream asynchronously.
     */
    public CompletableFuture<Void> createAsync() {
        return createAsync(null, null, null);
    }

    /**
     * Create the stream asynchronously with content type.
     */
    public CompletableFuture<Void> createAsync(String contentType) {
        return createAsync(contentType, null, null);
    }

    /**
     * Create the stream asynchronously with full options.
     */
    public CompletableFuture<Void> createAsync(String contentType, Duration ttl, Instant expiresAt) {
        try {
            HttpRequest request = buildCreateRequest(contentType, ttl, expiresAt);

            return client.getHttpClient()
                    .sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
                    .thenApply(this::parseCreateResponse);
        } catch (Exception e) {
            return CompletableFuture.failedFuture(
                    e instanceof DurableStreamException ? e : new DurableStreamException("Failed to build request", e));
        }
    }

    /**
     * Append data to the stream asynchronously.
     */
    public CompletableFuture<AppendResult> appendAsync(byte[] data) {
        return appendAsync(data, null);
    }

    /**
     * Append data to the stream asynchronously with optional sequence number.
     */
    public CompletableFuture<AppendResult> appendAsync(byte[] data, Long seq) {
        try {
            if (data == null || data.length == 0) {
                return CompletableFuture.failedFuture(new DurableStreamException("Cannot append empty data"));
            }

            HttpRequest request = buildAppendRequest(data, seq);

            return client.getHttpClient()
                    .sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
                    .thenApply(response -> parseAppendResponse(response, seq));
        } catch (Exception e) {
            return CompletableFuture.failedFuture(
                    e instanceof DurableStreamException ? e : new DurableStreamException("Failed to build request", e));
        }
    }

    /**
     * Get stream metadata asynchronously.
     */
    public CompletableFuture<Metadata> headAsync() {
        try {
            HttpRequest request = buildHeadRequest();

            return client.getHttpClient()
                    .sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
                    .thenApply(this::parseHeadResponse);
        } catch (Exception e) {
            return CompletableFuture.failedFuture(
                    e instanceof DurableStreamException ? e : new DurableStreamException("Failed to build request", e));
        }
    }

    /**
     * Delete the stream asynchronously.
     */
    public CompletableFuture<Void> deleteAsync() {
        try {
            HttpRequest request = buildDeleteRequest();

            return client.getHttpClient()
                    .sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
                    .thenApply(this::parseDeleteResponse);
        } catch (Exception e) {
            return CompletableFuture.failedFuture(
                    e instanceof DurableStreamException ? e : new DurableStreamException("Failed to build request", e));
        }
    }

    /**
     * Read once from the stream asynchronously.
     */
    public CompletableFuture<Chunk> readOnceAsync() {
        return readOnceAsync(null, LiveMode.OFF, null, null);
    }

    /**
     * Read once from the stream asynchronously with offset.
     */
    public CompletableFuture<Chunk> readOnceAsync(Offset offset) {
        return readOnceAsync(offset, LiveMode.OFF, null, null);
    }

    /**
     * Read once from the stream asynchronously with full options.
     */
    public CompletableFuture<Chunk> readOnceAsync(Offset offset, LiveMode liveMode,
                                                   Duration timeout, String cursor) {
        try {
            HttpRequest request = buildReadRequest(offset, liveMode, timeout, cursor);

            return client.getHttpClient()
                    .sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
                    .thenApply(response -> parseReadResponse(response, offset));
        } catch (Exception e) {
            return CompletableFuture.failedFuture(
                    e instanceof DurableStreamException ? e : new DurableStreamException("Failed to build request", e));
        }
    }

    // Package-private for ChunkIterator
    Chunk readOnce(Offset offset, LiveMode liveMode, Duration timeout, String cursor)
            throws DurableStreamException {
        HttpRequest request = buildReadRequest(offset, liveMode, timeout, cursor);

        return executeWithRetry(request, "read", response -> parseReadResponse(response, offset));
    }

    // Package-private for ChunkIterator - creates SSE streaming connection
    com.durablestreams.internal.sse.SSEStreamingReader openSSEStream(Offset offset, String cursor)
            throws DurableStreamException {
        HttpRequest request = buildSSERequest(offset, cursor);
        return new com.durablestreams.internal.sse.SSEStreamingReader(
                client.getHttpClient(), request, offset);
    }

    private HttpRequest buildSSERequest(Offset offset, String cursor) {
        StringBuilder urlBuilder = new StringBuilder(url);
        List<String> params = new ArrayList<>();

        Map<String, String> extraParams = client.resolveParams();
        extraParams.forEach((k, v) -> params.add(encode(k) + "=" + encode(v)));

        if (offset != null) {
            params.add("offset=" + encode(offset.getValue()));
        }
        params.add("live=sse");
        if (cursor != null) {
            params.add("cursor=" + encode(cursor));
        }

        if (!params.isEmpty()) {
            Collections.sort(params);
            urlBuilder.append("?").append(String.join("&", params));
        }

        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(urlBuilder.toString()))
                .GET()
                .header("Accept", "text/event-stream");

        // SSE connections are long-lived, don't set a short timeout
        // The connection will be closed by the server after ~60 seconds per protocol

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        return builder.build();
    }

    private HttpRequest buildReadRequest(Offset offset, LiveMode liveMode, Duration timeout, String cursor) {
        StringBuilder urlBuilder = new StringBuilder(url);
        List<String> params = new ArrayList<>();

        Map<String, String> extraParams = client.resolveParams();
        extraParams.forEach((k, v) -> params.add(encode(k) + "=" + encode(v)));

        if (offset != null) {
            params.add("offset=" + encode(offset.getValue()));
        }
        if (liveMode != null && liveMode != LiveMode.OFF) {
            params.add("live=" + liveMode.getWireValue());
        }
        if (cursor != null) {
            params.add("cursor=" + encode(cursor));
        }

        if (!params.isEmpty()) {
            // Sort parameters lexicographically for optimal CDN cache behavior per protocol spec
            Collections.sort(params);
            urlBuilder.append("?").append(String.join("&", params));
        }

        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(urlBuilder.toString()))
                .GET();

        if (timeout != null) {
            builder.timeout(timeout);
        } else if (liveMode == LiveMode.LONG_POLL) {
            builder.timeout(Duration.ofSeconds(65));
        } else {
            builder.timeout(Duration.ofSeconds(30));
        }

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        if (liveMode == LiveMode.SSE) {
            builder.header("Accept", "text/event-stream");
        }

        return builder.build();
    }

    private Chunk parseReadResponse(HttpResponse<byte[]> response, Offset requestOffset) throws DurableStreamException {
        int status = response.statusCode();

        if (status == 200) {
            byte[] body = response.body();
            String nextOffset = response.headers().firstValue("Stream-Next-Offset").orElse(null);
            String upToDateStr = response.headers().firstValue("Stream-Up-To-Date").orElse(null);
            String newCursor = response.headers().firstValue("Stream-Cursor").orElse(null);

            response.headers().firstValue("Content-Type")
                    .ifPresent(ct -> client.cacheContentType(url, ct));

            boolean upToDate = "true".equalsIgnoreCase(upToDateStr);

            Map<String, String> respHeaders = new HashMap<>();
            response.headers().map().forEach((k, v) -> {
                if (!v.isEmpty()) respHeaders.put(k.toLowerCase(), v.get(0));
            });

            return new Chunk(body, nextOffset != null ? Offset.of(nextOffset) : null,
                    upToDate, newCursor, status, respHeaders);
        } else if (status == 204) {
            String nextOffset = response.headers().firstValue("Stream-Next-Offset").orElse(null);
            return new Chunk(new byte[0], nextOffset != null ? Offset.of(nextOffset) : null,
                    true, null, status, Map.of());
        } else if (status == 404) {
            throw new StreamNotFoundException(url);
        } else if (status == 410) {
            String offsetStr = requestOffset != null ? requestOffset.getValue() : "unknown";
            throw new OffsetGoneException(offsetStr);
        } else {
            throw new DurableStreamException("Read failed with status: " + status, status);
        }
    }

    DurableStreamClient getClient() {
        return client;
    }

    String getUrl() {
        return url;
    }

    // ==================== Request Builders ====================

    /**
     * Build URL with query parameters applied.
     * Query params are applied to ALL operations for auth gateway compatibility.
     */
    private String buildUrlWithParams() {
        Map<String, String> params = client.resolveParams();
        if (params.isEmpty()) {
            return url;
        }

        List<String> paramList = new ArrayList<>();
        params.forEach((k, v) -> paramList.add(encode(k) + "=" + encode(v)));
        Collections.sort(paramList);
        return url + "?" + String.join("&", paramList);
    }

    private HttpRequest buildCreateRequest(String contentType, Duration ttl, Instant expiresAt) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(buildUrlWithParams()))
                .method("PUT", HttpRequest.BodyPublishers.noBody())
                .timeout(Duration.ofSeconds(30));

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        if (contentType != null) {
            builder.header("Content-Type", contentType);
        }
        if (ttl != null) {
            builder.header("Stream-TTL", String.valueOf(ttl.getSeconds()));
        }
        if (expiresAt != null) {
            builder.header("Stream-Expires-At", expiresAt.toString());
        }

        return builder.build();
    }

    private HttpRequest buildAppendRequest(byte[] data, Long seq) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(buildUrlWithParams()))
                .POST(HttpRequest.BodyPublishers.ofByteArray(data))
                .timeout(Duration.ofSeconds(30));

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        String contentType = client.getCachedContentType(url);
        builder.header("Content-Type", contentType != null ? contentType : "application/octet-stream");
        if (seq != null) {
            builder.header("Stream-Seq", String.valueOf(seq));
        }

        return builder.build();
    }

    private HttpRequest buildHeadRequest() {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(buildUrlWithParams()))
                .method("HEAD", HttpRequest.BodyPublishers.noBody())
                .timeout(Duration.ofSeconds(30));

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        return builder.build();
    }

    private HttpRequest buildDeleteRequest() {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(buildUrlWithParams()))
                .DELETE()
                .timeout(Duration.ofSeconds(30));

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        return builder.build();
    }

    // ==================== Response Parsers ====================

    private Void parseCreateResponse(HttpResponse<byte[]> response) throws DurableStreamException {
        int status = response.statusCode();
        if (status == 201 || status == 200) {
            response.headers().firstValue("Content-Type")
                    .ifPresent(ct -> client.cacheContentType(url, ct));
            return null;
        } else if (status == 409) {
            throw new StreamExistsException(url);
        } else {
            throw new DurableStreamException("Create failed with status: " + status, status);
        }
    }

    private AppendResult parseAppendResponse(HttpResponse<byte[]> response, Long seq) throws DurableStreamException {
        int status = response.statusCode();
        String nextOffset = response.headers().firstValue("Stream-Next-Offset").orElse(null);
        String etag = response.headers().firstValue("ETag").orElse(null);

        response.headers().firstValue("Content-Type")
                .ifPresent(ct -> client.cacheContentType(url, ct));

        if (status == 200 || status == 201) {
            return new AppendResult(
                    nextOffset != null ? Offset.of(nextOffset) : null,
                    etag,
                    false
            );
        } else if (status == 204) {
            return AppendResult.duplicate();
        } else if (status == 404) {
            throw new StreamNotFoundException(url);
        } else if (status == 409) {
            throw new SequenceConflictException(
                    response.headers().firstValue("Stream-Seq").orElse("unknown"),
                    seq != null ? String.valueOf(seq) : "unknown"
            );
        } else {
            throw new DurableStreamException("Append failed with status: " + status, status);
        }
    }

    private Metadata parseHeadResponse(HttpResponse<byte[]> response) throws DurableStreamException {
        int status = response.statusCode();
        if (status == 200) {
            String contentType = response.headers().firstValue("Content-Type").orElse(null);
            String nextOffset = response.headers().firstValue("Stream-Next-Offset").orElse(null);
            String ttlStr = response.headers().firstValue("Stream-TTL").orElse(null);
            String expiresStr = response.headers().firstValue("Stream-Expires-At").orElse(null);
            String etag = response.headers().firstValue("ETag").orElse(null);

            client.cacheContentType(url, contentType);

            Duration ttl = ttlStr != null ? Duration.ofSeconds(Long.parseLong(ttlStr)) : null;
            Instant expiresAt = expiresStr != null ? Instant.parse(expiresStr) : null;

            return new Metadata(
                    contentType,
                    nextOffset != null ? Offset.of(nextOffset) : null,
                    ttl,
                    expiresAt,
                    etag
            );
        } else if (status == 404) {
            throw new StreamNotFoundException(url);
        } else {
            throw new DurableStreamException("Head failed with status: " + status, status);
        }
    }

    private Void parseDeleteResponse(HttpResponse<byte[]> response) throws DurableStreamException {
        int status = response.statusCode();
        if (status == 200 || status == 204) {
            return null;
        } else if (status == 404) {
            throw new StreamNotFoundException(url);
        } else {
            throw new DurableStreamException("Delete failed with status: " + status, status);
        }
    }

    // ==================== Internal Utilities ====================

    private <T> T executeWithRetry(HttpRequest request, String operation,
                                    ResponseHandler<T> handler) throws DurableStreamException {
        RetryPolicy policy = client.getRetryPolicy();
        int attempt = 0;

        while (true) {
            try {
                HttpResponse<byte[]> response = client.getHttpClient()
                        .send(request, HttpResponse.BodyHandlers.ofByteArray());
                return handler.handle(response);
            } catch (DurableStreamException e) {
                if (e.getStatusCode().isPresent()) {
                    int status = e.getStatusCode().get();
                    if (policy.shouldRetry(status, attempt)) {
                        attempt++;
                        sleepForRetry(policy.getDelay(attempt), e);
                        continue;
                    }
                }
                throw e;
            } catch (IOException e) {
                if (attempt < policy.getMaxRetries()) {
                    attempt++;
                    sleepForRetry(policy.getDelay(attempt), new DurableStreamException("Request interrupted", e));
                    continue;
                }
                throw new DurableStreamException(operation + " failed: " + e.getMessage(), e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new DurableStreamException("Request interrupted", e);
            }
        }
    }

    private void sleepForRetry(Duration delay, DurableStreamException fallbackException) throws DurableStreamException {
        try {
            Thread.sleep(delay.toMillis());
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw fallbackException;
        }
    }

    private static String encode(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    @FunctionalInterface
    private interface ResponseHandler<T> {
        T handle(HttpResponse<byte[]> response) throws DurableStreamException;
    }
}
