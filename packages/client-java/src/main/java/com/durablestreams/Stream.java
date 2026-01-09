package com.durablestreams;

import com.durablestreams.exception.*;
import com.durablestreams.internal.RetryPolicy;
import com.durablestreams.internal.sse.SSEParser;
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

/**
 * Handle for stream operations (create, append, read, delete, head).
 */
public final class Stream {

    private final DurableStreamClient client;
    private final String url;

    Stream(DurableStreamClient client, String url) {
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
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .method("PUT", HttpRequest.BodyPublishers.noBody())
                .timeout(Duration.ofSeconds(30));

        // Add headers
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

        executeWithRetry(builder.build(), "create", response -> {
            int status = response.statusCode();
            if (status == 201 || status == 200) {
                String ct = response.headers().firstValue("Content-Type").orElse(null);
                client.cacheContentType(url, ct);
                return null;
            } else if (status == 409) {
                throw new StreamExistsException(url);
            } else {
                throw new DurableStreamException("Create failed with status: " + status, status);
            }
        });
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

        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .POST(HttpRequest.BodyPublishers.ofByteArray(data))
                .timeout(Duration.ofSeconds(30));

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        // Use cached content type or default to application/octet-stream
        String contentType = client.getCachedContentType(url);
        builder.header("Content-Type", contentType != null ? contentType : "application/octet-stream");
        if (seq != null) {
            builder.header("Stream-Seq", String.valueOf(seq));
        }

        return executeWithRetry(builder.build(), "append", response -> {
            int status = response.statusCode();
            String nextOffset = response.headers().firstValue("Stream-Next-Offset").orElse(null);
            String etag = response.headers().firstValue("ETag").orElse(null);

            // Cache content type from response
            response.headers().firstValue("Content-Type")
                    .ifPresent(ct -> client.cacheContentType(url, ct));

            if (status == 200 || status == 201) {
                return new AppendResult(
                        nextOffset != null ? Offset.of(nextOffset) : null,
                        etag,
                        false
                );
            } else if (status == 204) {
                // Duplicate (idempotent)
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
        });
    }

    /**
     * Get stream metadata.
     */
    public Metadata head() throws DurableStreamException {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .method("HEAD", HttpRequest.BodyPublishers.noBody())
                .timeout(Duration.ofSeconds(30));

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        return executeWithRetry(builder.build(), "head", response -> {
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
        });
    }

    /**
     * Delete the stream.
     */
    public void delete() throws DurableStreamException {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .DELETE()
                .timeout(Duration.ofSeconds(30));

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        executeWithRetry(builder.build(), "delete", response -> {
            int status = response.statusCode();
            if (status == 200 || status == 204) {
                return null;
            } else if (status == 404) {
                throw new StreamNotFoundException(url);
            } else {
                throw new DurableStreamException("Delete failed with status: " + status, status);
            }
        });
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

    // Package-private for ChunkIterator
    Chunk readOnce(Offset offset, LiveMode liveMode, Duration timeout, String cursor)
            throws DurableStreamException {
        StringBuilder urlBuilder = new StringBuilder(url);
        List<String> params = new ArrayList<>();

        // Add query params
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
            urlBuilder.append("?").append(String.join("&", params));
        }

        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(urlBuilder.toString()))
                .GET();

        if (timeout != null) {
            builder.timeout(timeout);
        } else if (liveMode == LiveMode.LONG_POLL) {
            builder.timeout(Duration.ofSeconds(65)); // Server timeout + buffer
        } else {
            builder.timeout(Duration.ofSeconds(30));
        }

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        if (liveMode == LiveMode.SSE) {
            builder.header("Accept", "text/event-stream");
        }

        return executeWithRetry(builder.build(), "read", response -> {
            int status = response.statusCode();
            if (status == 200) {
                byte[] body = response.body();
                String nextOffset = response.headers().firstValue("Stream-Next-Offset").orElse(null);
                String upToDateStr = response.headers().firstValue("Stream-Up-To-Date").orElse(null);
                String newCursor = response.headers().firstValue("Stream-Cursor").orElse(null);

                // Cache content type
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
                // No content (long-poll timeout)
                String nextOffset = response.headers().firstValue("Stream-Next-Offset").orElse(null);
                return new Chunk(new byte[0], nextOffset != null ? Offset.of(nextOffset) : null,
                        true, null, status, Map.of());
            } else if (status == 404) {
                throw new StreamNotFoundException(url);
            } else if (status == 410) {
                String offsetStr = offset != null ? offset.getValue() : "unknown";
                throw new OffsetGoneException(offsetStr);
            } else {
                throw new DurableStreamException("Read failed with status: " + status, status);
            }
        });
    }

    DurableStreamClient getClient() {
        return client;
    }

    String getUrl() {
        return url;
    }

    private <T> T executeWithRetry(HttpRequest request, String operation,
                                    ResponseHandler<T> handler) throws DurableStreamException {
        RetryPolicy policy = client.getRetryPolicy();
        int attempt = 0;
        Exception lastError = null;

        while (true) {
            try {
                HttpResponse<byte[]> response = client.getHttpClient()
                        .send(request, HttpResponse.BodyHandlers.ofByteArray());
                return handler.handle(response);
            } catch (DurableStreamException e) {
                // Don't retry client errors
                if (e.getStatusCode().isPresent()) {
                    int status = e.getStatusCode().get();
                    if (policy.shouldRetry(status, attempt)) {
                        lastError = e;
                        attempt++;
                        try {
                            Thread.sleep(policy.getDelay(attempt).toMillis());
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            throw e;
                        }
                        continue;
                    }
                }
                throw e;
            } catch (IOException e) {
                lastError = e;
                if (attempt < policy.getMaxRetries()) {
                    attempt++;
                    try {
                        Thread.sleep(policy.getDelay(attempt).toMillis());
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw new DurableStreamException("Request interrupted", ie);
                    }
                    continue;
                }
                throw new DurableStreamException(operation + " failed: " + e.getMessage(), e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new DurableStreamException("Request interrupted", e);
            }
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
