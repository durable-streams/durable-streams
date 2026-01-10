package com.durablestreams;

import com.durablestreams.exception.*;
import com.durablestreams.model.*;

import java.io.*;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * Idempotent producer for exactly-once write semantics.
 *
 * <p>Uses fire-and-forget batching: {@link #append(Object)} returns immediately,
 * and data is batched and sent according to configuration.
 *
 * <p>Call {@link #flush()} to wait for all pending batches, or {@link #close()}
 * to flush and clean up resources.
 */
public final class IdempotentProducer implements AutoCloseable {

    private final DurableStreamClient client;
    private final String url;
    private final String producerId;
    private final Config config;

    private final AtomicLong epoch;
    private final AtomicLong nextSeq;
    private final AtomicInteger inFlight;
    private final AtomicBoolean closed;

    private final Object batchLock = new Object();
    private List<byte[]> pendingBatch;  // Store byte[] directly to avoid wrapper allocation
    private int batchBytes;
    private ScheduledFuture<?> lingerTimer;

    private final ScheduledExecutorService scheduler;

    // Track in-flight futures for true fire-and-forget with flush
    private final ConcurrentLinkedQueue<CompletableFuture<Void>> inFlightFutures;

    private final BlockingQueue<DurableStreamException> errors;

    public IdempotentProducer(DurableStreamClient client, String url, String producerId, Config config) {
        this.client = client;
        this.url = url;
        this.producerId = producerId;
        // Normalize config like Go: lingerMs=0 means use default (5ms)
        this.config = config.lingerMs == 0 ? config.withLingerMs(5) : config;

        this.epoch = new AtomicLong(config.epoch);
        this.nextSeq = new AtomicLong(config.startingSeq);
        this.inFlight = new AtomicInteger(0);
        this.closed = new AtomicBoolean(false);

        this.pendingBatch = new ArrayList<>(1024);  // Pre-size for typical batch
        this.batchBytes = 0;

        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "durable-streams-producer-scheduler");
            t.setDaemon(true);
            return t;
        });

        // Track futures for true fire-and-forget
        this.inFlightFutures = new ConcurrentLinkedQueue<>();

        this.errors = new LinkedBlockingQueue<>();
    }

    /**
     * Append data asynchronously. Returns immediately.
     * Data will be batched and sent according to configuration.
     */
    public void append(Object data) throws DurableStreamException {
        if (closed.get()) {
            throw new DurableStreamException("Producer is closed");
        }

        byte[] bytes = serialize(data);

        synchronized (batchLock) {
            pendingBatch.add(bytes);
            batchBytes += bytes.length;

            // Check if we should send immediately
            if (batchBytes >= config.maxBatchBytes) {
                sendBatch();
            } else if (lingerTimer == null && config.lingerMs > 0) {
                // Schedule linger timeout
                lingerTimer = scheduler.schedule(this::onLingerTimeout, config.lingerMs, TimeUnit.MILLISECONDS);
            }
        }
    }

    /**
     * Wait for all pending batches to complete.
     */
    public void flush() throws DurableStreamException {
        // Keep sending until all batches are dispatched and completed
        while (true) {
            boolean hasPending;
            boolean hasInFlight;

            synchronized (batchLock) {
                // Cancel any pending linger timer
                if (lingerTimer != null) {
                    lingerTimer.cancel(false);
                    lingerTimer = null;
                }

                // Send any pending batch
                if (!pendingBatch.isEmpty()) {
                    sendBatchForFlush();
                }

                hasPending = !pendingBatch.isEmpty();
                hasInFlight = inFlight.get() > 0;
            }
            // Lock released - allow new appends to proceed

            if (!hasPending && !hasInFlight) {
                break;
            }

            // Wait for at least one in-flight to complete
            if (hasInFlight) {
                CompletableFuture<Void> anyFuture = inFlightFutures.peek();
                if (anyFuture != null) {
                    try {
                        anyFuture.get(100, TimeUnit.MILLISECONDS);
                    } catch (Exception ignored) {
                        // Timeout or completion - either way, loop again
                    }
                }
            }
        }

        // Check for errors
        DurableStreamException error = errors.poll();
        if (error != null) {
            throw error;
        }
    }

    private void sendBatchForFlush() {
        // Like sendBatch but always sends (used by flush)
        if (pendingBatch.isEmpty()) return;

        List<byte[]> batch = pendingBatch;
        pendingBatch = new ArrayList<>(1024);
        batchBytes = 0;

        long seq = nextSeq.getAndIncrement();
        long currentEpoch = epoch.get();

        inFlight.incrementAndGet();

        CompletableFuture<Void> future = sendBatchFireAndForget(batch, currentEpoch, seq);
        inFlightFutures.add(future);
        future.whenComplete((v, ex) -> {
            inFlight.decrementAndGet();
            inFlightFutures.remove(future);
        });
    }

    /**
     * Flush and close the producer.
     */
    @Override
    public void close() throws DurableStreamException {
        if (closed.getAndSet(true)) {
            return; // Already closed
        }

        try {
            flush();
        } finally {
            scheduler.shutdown();
            try {
                scheduler.awaitTermination(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * Start a new epoch (for zombie fencing after restart).
     */
    public void restart() {
        epoch.incrementAndGet();
        nextSeq.set(0);
    }

    public String getProducerId() {
        return producerId;
    }

    public long getCurrentEpoch() {
        return epoch.get();
    }

    public long getCurrentSeq() {
        return nextSeq.get();
    }

    private void onLingerTimeout() {
        synchronized (batchLock) {
            lingerTimer = null;
            if (!pendingBatch.isEmpty()) {
                sendBatch();
            }
        }
    }

    private void sendBatch() {
        // Must be called with batchLock held
        if (pendingBatch.isEmpty()) return;

        // Cancel linger timer
        if (lingerTimer != null) {
            lingerTimer.cancel(false);
            lingerTimer = null;
        }

        // Like Go: don't block if at capacity - let linger timer retry later
        if (inFlight.get() >= config.maxInFlight) {
            // Reschedule linger timer to retry soon
            if (lingerTimer == null) {
                lingerTimer = scheduler.schedule(this::onLingerTimeout, 1, TimeUnit.MILLISECONDS);
            }
            return;
        }

        // Take the current batch
        List<byte[]> batch = pendingBatch;
        pendingBatch = new ArrayList<>(1024);
        batchBytes = 0;

        // Get sequence number for this batch
        long seq = nextSeq.getAndIncrement();
        long currentEpoch = epoch.get();

        inFlight.incrementAndGet();

        // True fire-and-forget: send async and track the future
        CompletableFuture<Void> future = sendBatchFireAndForget(batch, currentEpoch, seq);
        inFlightFutures.add(future);
        future.whenComplete((v, ex) -> {
            inFlight.decrementAndGet();
            inFlightFutures.remove(future);
        });
    }

    private CompletableFuture<Void> sendBatchFireAndForget(List<byte[]> batch, long batchEpoch, long seq) {
        // Serialize batch data
        byte[] data = serializeBatch(batch);

        // Build request
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .POST(HttpRequest.BodyPublishers.ofByteArray(data))
                .timeout(Duration.ofSeconds(30))
                .header("Producer-Id", producerId)
                .header("Producer-Epoch", String.valueOf(batchEpoch))
                .header("Producer-Seq", String.valueOf(seq));

        String contentType = client.getCachedContentType(url);
        if (contentType != null) {
            builder.header("Content-Type", contentType);
        }

        Map<String, String> headers = client.resolveHeaders();
        headers.forEach(builder::header);

        // True async - no blocking .join()
        return client.getHttpClient()
                .sendAsync(builder.build(), HttpResponse.BodyHandlers.ofByteArray())
                .thenAccept(response -> {
                    int status = response.statusCode();

                    if (status == 200 || status == 201 || status == 204) {
                        // Success or duplicate (idempotent)
                        return;
                    } else if (status == 403) {
                        // Stale epoch
                        if (config.autoClaim) {
                            epoch.incrementAndGet();
                            nextSeq.set(0);
                        }
                        long currentEpoch = parseEpochFromResponse(response);
                        errors.offer(new StaleEpochException(currentEpoch));
                    } else if (status == 409) {
                        // Sequence conflict
                        handleSequenceConflict(batch, batchEpoch, seq, response);
                    } else {
                        errors.offer(new DurableStreamException("Batch failed with status: " + status, status));
                    }

                    if (config.onError != null) {
                        config.onError.accept(new DurableStreamException("Batch failed with status: " + status, status));
                    }
                })
                .exceptionally(ex -> {
                    Throwable cause = ex.getCause() != null ? ex.getCause() : ex;
                    DurableStreamException err = new DurableStreamException("Batch send failed: " + cause.getMessage(), cause);
                    errors.offer(err);
                    if (config.onError != null) {
                        config.onError.accept(err);
                    }
                    return null;
                });
    }

    private void handleSequenceConflict(List<byte[]> batch, long batchEpoch, long seq,
                                         HttpResponse<byte[]> response) {
        // Get expected sequence from response
        String expectedSeqStr = response.headers().firstValue("Producer-Expected-Seq").orElse(null);
        if (expectedSeqStr == null) {
            errors.offer(new SequenceConflictException("unknown", String.valueOf(seq)));
            return;
        }

        long expectedSeq = Long.parseLong(expectedSeqStr);

        // If expected >= our seq, this is unrecoverable
        if (expectedSeq >= seq) {
            errors.offer(new SequenceConflictException(expectedSeqStr, String.valueOf(seq)));
            return;
        }

        // Otherwise, wait for earlier sequences and retry
        // For simplicity in this implementation, we just report the error
        // A full implementation would track pending sequences and retry
        errors.offer(new SequenceConflictException(expectedSeqStr, String.valueOf(seq)));
    }

    private long parseEpochFromResponse(HttpResponse<byte[]> response) {
        return response.headers().firstValue("Producer-Epoch")
                .map(Long::parseLong)
                .orElse(0L);
    }

    private byte[] serialize(Object data) {
        if (data instanceof byte[]) {
            return (byte[]) data;
        } else if (data instanceof String) {
            return ((String) data).getBytes(StandardCharsets.UTF_8);
        } else {
            // For other objects, assume JSON (requires Gson at runtime)
            try {
                Class<?> gsonClass = Class.forName("com.google.gson.Gson");
                Object gson = gsonClass.getDeclaredConstructor().newInstance();
                String json = (String) gsonClass.getMethod("toJson", Object.class).invoke(gson, data);
                return json.getBytes(StandardCharsets.UTF_8);
            } catch (Exception e) {
                throw new RuntimeException("Cannot serialize object without Gson on classpath", e);
            }
        }
    }

    private byte[] serializeBatch(List<byte[]> batch) {
        if (batch.size() == 1) {
            return batch.get(0);
        }

        // Check if this is a JSON stream
        String contentType = client.getCachedContentType(url);
        boolean isJson = contentType != null && contentType.contains("json");

        if (isJson) {
            // Wrap in JSON array
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < batch.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append(new String(batch.get(i), StandardCharsets.UTF_8));
            }
            sb.append("]");
            return sb.toString().getBytes(StandardCharsets.UTF_8);
        } else {
            // Concatenate binary data - avoid stream for efficiency
            int totalLen = 0;
            for (int i = 0; i < batch.size(); i++) {
                totalLen += batch.get(i).length;
            }
            byte[] result = new byte[totalLen];
            int pos = 0;
            for (int i = 0; i < batch.size(); i++) {
                byte[] data = batch.get(i);
                System.arraycopy(data, 0, result, pos, data.length);
                pos += data.length;
            }
            return result;
        }
    }

    /**
     * Configuration for idempotent producer.
     */
    public static final class Config {
        final long epoch;
        final long startingSeq;
        final boolean autoClaim;
        final int maxBatchBytes;
        final int lingerMs;
        final int maxInFlight;
        final String contentType;
        final Consumer<DurableStreamException> onError;

        private Config(Builder builder) {
            this.epoch = builder.epoch;
            this.startingSeq = builder.startingSeq;
            this.autoClaim = builder.autoClaim;
            this.maxBatchBytes = builder.maxBatchBytes;
            this.lingerMs = builder.lingerMs;
            this.maxInFlight = builder.maxInFlight;
            this.contentType = builder.contentType;
            this.onError = builder.onError;
        }

        public static Config defaults() {
            return builder().build();
        }

        public static Builder builder() {
            return new Builder();
        }

        Config withLingerMs(int newLingerMs) {
            return new Config(Builder.from(this).lingerMs(newLingerMs));
        }

        public static final class Builder {
            private long epoch = 0;
            private long startingSeq = 0;
            private boolean autoClaim = false;
            private int maxBatchBytes = 1024 * 1024; // 1MB
            private int lingerMs = 5;
            private int maxInFlight = 5;
            private String contentType;
            private Consumer<DurableStreamException> onError;

            static Builder from(Config config) {
                Builder b = new Builder();
                b.epoch = config.epoch;
                b.startingSeq = config.startingSeq;
                b.autoClaim = config.autoClaim;
                b.maxBatchBytes = config.maxBatchBytes;
                b.lingerMs = config.lingerMs;
                b.maxInFlight = config.maxInFlight;
                b.contentType = config.contentType;
                b.onError = config.onError;
                return b;
            }

            public Builder epoch(long epoch) {
                this.epoch = epoch;
                return this;
            }

            public Builder startingSeq(long startingSeq) {
                this.startingSeq = startingSeq;
                return this;
            }

            public Builder autoClaim(boolean autoClaim) {
                this.autoClaim = autoClaim;
                return this;
            }

            public Builder maxBatchBytes(int maxBatchBytes) {
                this.maxBatchBytes = maxBatchBytes;
                return this;
            }

            public Builder lingerMs(int lingerMs) {
                this.lingerMs = lingerMs;
                return this;
            }

            public Builder maxInFlight(int maxInFlight) {
                this.maxInFlight = maxInFlight;
                return this;
            }

            public Builder contentType(String contentType) {
                this.contentType = contentType;
                return this;
            }

            public Builder onError(Consumer<DurableStreamException> onError) {
                this.onError = onError;
                return this;
            }

            public Config build() {
                return new Config(this);
            }
        }
    }
}
