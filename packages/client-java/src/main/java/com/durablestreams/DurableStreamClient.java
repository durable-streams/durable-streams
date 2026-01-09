package com.durablestreams;

import com.durablestreams.exception.*;
import com.durablestreams.internal.RetryPolicy;
import com.durablestreams.model.*;

import java.io.*;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * Main client for the Durable Streams protocol.
 *
 * <p>Usage:
 * <pre>{@code
 * var client = DurableStreamClient.create();
 * var stream = client.stream("http://localhost:3000/streams/my-stream");
 * stream.create("application/json");
 * stream.append("{\"hello\":\"world\"}".getBytes());
 * }</pre>
 */
public final class DurableStreamClient implements AutoCloseable {

    private final HttpClient httpClient;
    private final RetryPolicy retryPolicy;
    private final Map<String, String> defaultHeaders;
    private final Map<String, Supplier<String>> dynamicHeaders;
    private final Map<String, String> defaultParams;
    private final Map<String, Supplier<String>> dynamicParams;
    private final Map<String, String> contentTypeCache;

    private DurableStreamClient(Builder builder) {
        this.httpClient = builder.httpClient != null ? builder.httpClient : createDefaultHttpClient();
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
    public static DurableStreamClient create() {
        return builder().build();
    }

    /**
     * Create a builder for custom configuration.
     */
    public static Builder builder() {
        return new Builder();
    }

    private static HttpClient createDefaultHttpClient() {
        return HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_2)
                .connectTimeout(Duration.ofSeconds(30))
                .followRedirects(HttpClient.Redirect.NORMAL)
                // Use a cached thread pool for parallel requests
                .executor(java.util.concurrent.Executors.newCachedThreadPool(r -> {
                    Thread t = new Thread(r, "durable-streams-http");
                    t.setDaemon(true);
                    return t;
                }))
                .build();
    }

    /**
     * Get a stream handle for operations.
     */
    public Stream stream(String url) {
        return new Stream(this, url);
    }

    /**
     * Get a stream handle for operations.
     */
    public Stream stream(URI url) {
        return new Stream(this, url.toString());
    }

    /**
     * Create an idempotent producer for exactly-once writes.
     */
    public IdempotentProducer idempotentProducer(String url, String producerId) {
        return idempotentProducer(url, producerId, IdempotentProducer.Config.defaults());
    }

    /**
     * Create an idempotent producer with custom configuration.
     */
    public IdempotentProducer idempotentProducer(String url, String producerId, IdempotentProducer.Config config) {
        return new IdempotentProducer(this, url, producerId, config);
    }

    // Dynamic header/param management for conformance adapter
    public void setDynamicHeader(String name, Supplier<String> supplier) {
        dynamicHeaders.put(name, supplier);
    }

    public void setDynamicParam(String name, Supplier<String> supplier) {
        dynamicParams.put(name, supplier);
    }

    public void clearDynamic() {
        dynamicHeaders.clear();
        dynamicParams.clear();
    }

    // Package-private methods for Stream class
    HttpClient getHttpClient() {
        return httpClient;
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
        // HttpClient doesn't need explicit closing in Java 11+
    }

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

        public DurableStreamClient build() {
            return new DurableStreamClient(this);
        }
    }
}
