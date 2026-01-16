package com.durablestreams;

import com.durablestreams.exception.*;
import com.durablestreams.internal.RetryPolicy;
import com.durablestreams.internal.sse.SSEStreamingReader;
import com.durablestreams.model.*;

import java.io.*;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * Client for the Durable Streams protocol.
 *
 * <p>Usage:
 * <pre>{@code
 * var client = DurableStream.create();
 * client.create("http://localhost:3000/streams/my-stream", "application/json");
 * client.append("http://localhost:3000/streams/my-stream", "{\"hello\":\"world\"}".getBytes());
 * }</pre>
 *
 * <p><strong>Thread Safety:</strong> This class is thread-safe. All operations can be
 * called concurrently from multiple threads.
 */
public final class DurableStream implements AutoCloseable {

    private final HttpClient httpClient;
    private final ExecutorService ownedExecutor;
    private final RetryPolicy retryPolicy;
    private final Map<String, String> defaultHeaders;
    private final Map<String, Supplier<String>> dynamicHeaders;
    private final Map<String, String> defaultParams;
    private final Map<String, Supplier<String>> dynamicParams;
    private final Map<String, String> contentTypeCache;

    private DurableStream(Builder builder) {
        if (builder.httpClient != null) {
            this.httpClient = builder.httpClient;
            this.ownedExecutor = null;
        } else {
            this.ownedExecutor = Executors.newCachedThreadPool(r -> {
                Thread t = new Thread(r, "durable-streams-http");
                t.setDaemon(true);
                return t;
            });
            this.httpClient = createDefaultHttpClient(this.ownedExecutor);
        }
        this.retryPolicy = builder.retryPolicy != null ? builder.retryPolicy : RetryPolicy.defaults();
        this.defaultHeaders = new HashMap<>(builder.defaultHeaders);
        this.dynamicHeaders = new ConcurrentHashMap<>(builder.dynamicHeaders);
        this.defaultParams = new HashMap<>(builder.defaultParams);
        this.dynamicParams = new ConcurrentHashMap<>(builder.dynamicParams);
        this.contentTypeCache = new ConcurrentHashMap<>();
    }

    /**
     * Create a client with default settings.
     */
    public static DurableStream create() {
        return new DurableStream(new Builder());
    }

    /**
     * Create a builder for custom configuration.
     */
    public static Builder builder() {
        return new Builder();
    }

    private static HttpClient createDefaultHttpClient(ExecutorService executor) {
        return HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_2)
                .connectTimeout(Duration.ofSeconds(30))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .executor(executor)
                .build();
    }

    // ==================== Create ====================

    /**
     * Create a stream with default content type (application/octet-stream).
     *
     * @param url Stream URL
     */
    public void create(String url) throws DurableStreamException {
        create(url, "application/octet-stream", null, null);
    }

    /**
     * Create a stream with the specified content type.
     *
     * @param url Stream URL
     * @param contentType MIME type (e.g., "application/json")
     */
    public void create(String url, String contentType) throws DurableStreamException {
        create(url, contentType, null, null);
    }

    /**
     * Create a stream with full options.
     *
     * @param url Stream URL
     * @param contentType MIME type (e.g., "application/json")
     * @param ttl Time-to-live duration
     * @param expiresAt Absolute expiration time
     */
    public void create(String url, String contentType, Duration ttl, Instant expiresAt)
            throws DurableStreamException {
        HttpRequest request = buildCreateRequest(url, contentType, ttl, expiresAt);
        executeWithRetry(request, "create", response -> parseCreateResponse(response, url));
    }

    // ==================== Append ====================

    /**
     * Append data to a stream.
     */
    public AppendResult append(String url, byte[] data) throws DurableStreamException {
        return append(url, data, null);
    }

    /**
     * Append data with sequence number (package-private for testing).
     */
    AppendResult append(String url, byte[] data, Long seq) throws DurableStreamException {
        if (data == null || data.length == 0) {
            throw new DurableStreamException("Cannot append empty data");
        }
        HttpRequest request = buildAppendRequest(url, data, seq);
        return executeWithRetry(request, "append", response -> parseAppendResponse(response, url, seq));
    }

    /**
     * Append data to a stream asynchronously.
     */
    public CompletableFuture<AppendResult> appendAsync(String url, byte[] data) {
        try {
            if (data == null || data.length == 0) {
                return CompletableFuture.failedFuture(new DurableStreamException("Cannot append empty data"));
            }
            HttpRequest request = buildAppendRequest(url, data, null);
            return httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
                    .thenApply(response -> parseAppendResponse(response, url, null));
        } catch (Exception e) {
            return CompletableFuture.failedFuture(wrapException(e));
        }
    }

    // ==================== Head ====================

    /**
     * Get stream metadata.
     */
    public Metadata head(String url) throws DurableStreamException {
        HttpRequest request = buildHeadRequest(url);
        return executeWithRetry(request, "head", response -> parseHeadResponse(response, url));
    }

    // ==================== Delete ====================

    /**
     * Delete a stream.
     */
    public void delete(String url) throws DurableStreamException {
        HttpRequest request = buildDeleteRequest(url);
        executeWithRetry(request, "delete", response -> parseDeleteResponse(response, url));
    }

    // ==================== Read ====================

    /**
     * Read from a stream (catch-up mode, from beginning).
     */
    public ChunkIterator read(String url) throws DurableStreamException {
        return read(url, ReadOptions.create());
    }

    /**
     * Read from a stream with options.
     *
     * <p>Example:
     * <pre>{@code
     * // Live tail with SSE
     * client.read(url, ReadOptions.from(offset).live(LiveMode.SSE).timeout(Duration.ofSeconds(30)))
     *
     * // Or using builder
     * client.read(url, ReadOptions.builder().offset(offset).liveMode(LiveMode.SSE).build())
     * }</pre>
     *
     * @param url Stream URL
     * @param options Read options (offset, live mode, timeout, cursor)
     */
    public ChunkIterator read(String url, ReadOptions options) throws DurableStreamException {
        return new ChunkIterator(this, url,
                options.getOffset(),
                options.getLiveMode(),
                options.getTimeout(),
                options.getCursor());
    }

    // ==================== Read JSON ====================

    /**
     * Read JSON from a stream with type-safe parsing.
     *
     * <p>Example with Gson:
     * <pre>{@code
     * Gson gson = new Gson();
     * Type listType = new TypeToken<List<Event>>(){}.getType();
     *
     * try (var iter = client.readJson(url, json -> gson.fromJson(json, listType))) {
     *     for (Event event : iter.items()) {
     *         process(event);
     *     }
     * }
     * }</pre>
     */
    public <T> JsonIterator<T> readJson(String url, Function<String, List<T>> parser)
            throws DurableStreamException {
        return readJson(url, parser, ReadOptions.create());
    }

    /**
     * Read JSON from a stream with options.
     */
    public <T> JsonIterator<T> readJson(String url, Function<String, List<T>> parser, ReadOptions options)
            throws DurableStreamException {
        ChunkIterator chunkIterator = new ChunkIterator(this, url,
                options.getOffset(),
                options.getLiveMode(),
                options.getTimeout(),
                options.getCursor());
        return new JsonIterator<>(chunkIterator, parser);
    }

    // ==================== Producer ====================

    /**
     * Create an idempotent producer for exactly-once writes.
     */
    public IdempotentProducer producer(String url, String producerId) {
        return producer(url, producerId, IdempotentProducer.Config.defaults());
    }

    /**
     * Create an idempotent producer with custom configuration.
     */
    public IdempotentProducer producer(String url, String producerId,
                                                  IdempotentProducer.Config config) {
        return new IdempotentProducer(this, url, producerId, config);
    }

    // ==================== Package-private for internal use ====================

    HttpClient getHttpClient() {
        return httpClient;
    }

    Chunk readOnce(String url, Offset offset, LiveMode liveMode, Duration timeout, String cursor)
            throws DurableStreamException {
        HttpRequest request = buildReadRequest(url, offset, liveMode, timeout, cursor);
        return executeWithRetry(request, "read", response -> parseReadResponse(response, url, offset));
    }

    SSEStreamingReader openSSEStream(String url, Offset offset, String cursor)
            throws DurableStreamException {
        HttpRequest request = buildSSERequest(url, offset, cursor);
        return new SSEStreamingReader(httpClient, request, offset);
    }

    // ==================== Dynamic header/param management (package-private for testing) ====================

    void setDynamicHeader(String name, Supplier<String> supplier) {
        dynamicHeaders.put(name, supplier);
    }

    void setDynamicParam(String name, Supplier<String> supplier) {
        dynamicParams.put(name, supplier);
    }

    void clearDynamic() {
        dynamicHeaders.clear();
        dynamicParams.clear();
    }

    RetryPolicy getRetryPolicy() {
        return retryPolicy;
    }

    Map<String, String> resolveHeaders() {
        Map<String, String> headers = new HashMap<>(defaultHeaders);
        dynamicHeaders.forEach((name, supplier) -> headers.put(name, supplier.get()));
        return headers;
    }

    Map<String, String> resolveParams() {
        Map<String, String> params = new HashMap<>(defaultParams);
        dynamicParams.forEach((name, supplier) -> params.put(name, supplier.get()));
        return params;
    }

    String getCachedContentType(String url) {
        return contentTypeCache.get(url);
    }

    void cacheContentType(String url, String contentType) {
        if (contentType != null) {
            contentTypeCache.put(url, contentType);
        }
    }

    @Override
    public void close() {
        if (ownedExecutor != null) {
            ownedExecutor.shutdown();
            try {
                if (!ownedExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                    ownedExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                ownedExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }
    }

    // ==================== Request Builders ====================

    private String buildUrlWithParams(String url) {
        Map<String, String> params = resolveParams();
        if (params.isEmpty()) {
            return url;
        }
        List<String> paramList = new ArrayList<>();
        params.forEach((k, v) -> paramList.add(encode(k) + "=" + encode(v)));
        Collections.sort(paramList);
        return url + "?" + String.join("&", paramList);
    }

    private HttpRequest buildCreateRequest(String url, String contentType, Duration ttl, Instant expiresAt) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(buildUrlWithParams(url)))
                .method("PUT", HttpRequest.BodyPublishers.noBody())
                .timeout(Duration.ofSeconds(30));

        resolveHeaders().forEach(builder::header);

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

    private HttpRequest buildAppendRequest(String url, byte[] data, Long seq) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(buildUrlWithParams(url)))
                .POST(HttpRequest.BodyPublishers.ofByteArray(data))
                .timeout(Duration.ofSeconds(30));

        resolveHeaders().forEach(builder::header);

        String contentType = getCachedContentType(url);
        builder.header("Content-Type", contentType != null ? contentType : "application/octet-stream");
        if (seq != null) {
            builder.header("Stream-Seq", String.valueOf(seq));
        }

        return builder.build();
    }

    private HttpRequest buildHeadRequest(String url) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(buildUrlWithParams(url)))
                .method("HEAD", HttpRequest.BodyPublishers.noBody())
                .timeout(Duration.ofSeconds(30));

        resolveHeaders().forEach(builder::header);

        return builder.build();
    }

    private HttpRequest buildDeleteRequest(String url) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(buildUrlWithParams(url)))
                .DELETE()
                .timeout(Duration.ofSeconds(30));

        resolveHeaders().forEach(builder::header);

        return builder.build();
    }

    private HttpRequest buildReadRequest(String url, Offset offset, LiveMode liveMode,
                                          Duration timeout, String cursor) {
        StringBuilder urlBuilder = new StringBuilder(url);
        List<String> params = new ArrayList<>();

        resolveParams().forEach((k, v) -> params.add(encode(k) + "=" + encode(v)));

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

        resolveHeaders().forEach(builder::header);

        if (liveMode == LiveMode.SSE) {
            builder.header("Accept", "text/event-stream");
        }

        return builder.build();
    }

    private HttpRequest buildSSERequest(String url, Offset offset, String cursor) {
        StringBuilder urlBuilder = new StringBuilder(url);
        List<String> params = new ArrayList<>();

        resolveParams().forEach((k, v) -> params.add(encode(k) + "=" + encode(v)));

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

        resolveHeaders().forEach(builder::header);

        return builder.build();
    }

    // ==================== Response Parsers ====================

    private Void parseCreateResponse(HttpResponse<byte[]> response, String url) throws DurableStreamException {
        int status = response.statusCode();
        if (status == 201 || status == 200) {
            response.headers().firstValue("Content-Type")
                    .ifPresent(ct -> cacheContentType(url, ct));
            return null;
        } else if (status == 409) {
            throw new StreamExistsException(url);
        } else {
            throw new DurableStreamException("Create failed with status: " + status, status);
        }
    }

    private AppendResult parseAppendResponse(HttpResponse<byte[]> response, String url, Long seq)
            throws DurableStreamException {
        int status = response.statusCode();
        String nextOffset = response.headers().firstValue("Stream-Next-Offset").orElse(null);
        String etag = response.headers().firstValue("ETag").orElse(null);

        response.headers().firstValue("Content-Type")
                .ifPresent(ct -> cacheContentType(url, ct));

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

    private Metadata parseHeadResponse(HttpResponse<byte[]> response, String url) throws DurableStreamException {
        int status = response.statusCode();
        if (status == 200) {
            String contentType = response.headers().firstValue("Content-Type").orElse(null);
            String nextOffset = response.headers().firstValue("Stream-Next-Offset").orElse(null);
            String ttlStr = response.headers().firstValue("Stream-TTL").orElse(null);
            String expiresStr = response.headers().firstValue("Stream-Expires-At").orElse(null);
            String etag = response.headers().firstValue("ETag").orElse(null);

            cacheContentType(url, contentType);

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

    private Void parseDeleteResponse(HttpResponse<byte[]> response, String url) throws DurableStreamException {
        int status = response.statusCode();
        if (status == 200 || status == 204) {
            return null;
        } else if (status == 404) {
            throw new StreamNotFoundException(url);
        } else {
            throw new DurableStreamException("Delete failed with status: " + status, status);
        }
    }

    Chunk parseReadResponse(HttpResponse<byte[]> response, String url, Offset requestOffset)
            throws DurableStreamException {
        int status = response.statusCode();

        if (status == 200) {
            byte[] body = response.body();
            String nextOffset = response.headers().firstValue("Stream-Next-Offset").orElse(null);
            String upToDateStr = response.headers().firstValue("Stream-Up-To-Date").orElse(null);
            String newCursor = response.headers().firstValue("Stream-Cursor").orElse(null);

            response.headers().firstValue("Content-Type")
                    .ifPresent(ct -> cacheContentType(url, ct));

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

    // ==================== Internal Utilities ====================

    private <T> T executeWithRetry(HttpRequest request, String operation,
                                    ResponseHandler<T> handler) throws DurableStreamException {
        int attempt = 0;

        while (true) {
            try {
                HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
                return handler.handle(response);
            } catch (DurableStreamException e) {
                if (e.getStatusCode().isPresent()) {
                    int status = e.getStatusCode().get();
                    if (retryPolicy.shouldRetry(status, attempt)) {
                        attempt++;
                        sleepForRetry(retryPolicy.getDelay(attempt), e);
                        continue;
                    }
                }
                throw e;
            } catch (IOException e) {
                if (attempt < retryPolicy.getMaxRetries()) {
                    attempt++;
                    sleepForRetry(retryPolicy.getDelay(attempt),
                            new DurableStreamException("Request interrupted", e));
                    continue;
                }
                throw new DurableStreamException(operation + " failed: " + e.getMessage(), e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new DurableStreamException("Request interrupted", e);
            }
        }
    }

    private void sleepForRetry(Duration delay, DurableStreamException fallbackException)
            throws DurableStreamException {
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

    private static DurableStreamException wrapException(Exception e) {
        return e instanceof DurableStreamException
                ? (DurableStreamException) e
                : new DurableStreamException("Failed to build request", e);
    }

    @FunctionalInterface
    private interface ResponseHandler<T> {
        T handle(HttpResponse<byte[]> response) throws DurableStreamException;
    }

    // ==================== Builder ====================

    public static final class Builder {
        private HttpClient httpClient;
        private RetryPolicy retryPolicy;
        private final Map<String, String> defaultHeaders = new HashMap<>();
        private final Map<String, Supplier<String>> dynamicHeaders = new HashMap<>();
        private final Map<String, String> defaultParams = new HashMap<>();
        private final Map<String, Supplier<String>> dynamicParams = new HashMap<>();

        public Builder httpClient(HttpClient httpClient) {
            this.httpClient = httpClient;
            return this;
        }

        public Builder retryPolicy(RetryPolicy retryPolicy) {
            this.retryPolicy = retryPolicy;
            return this;
        }

        public Builder header(String name, String value) {
            defaultHeaders.put(name, value);
            return this;
        }

        public Builder header(String name, Supplier<String> supplier) {
            dynamicHeaders.put(name, supplier);
            return this;
        }

        public Builder param(String name, String value) {
            defaultParams.put(name, value);
            return this;
        }

        public Builder param(String name, Supplier<String> supplier) {
            dynamicParams.put(name, supplier);
            return this;
        }

        public DurableStream build() {
            return new DurableStream(this);
        }
    }
}
