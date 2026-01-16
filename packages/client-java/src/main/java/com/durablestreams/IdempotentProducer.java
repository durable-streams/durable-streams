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
 *
 * <p><strong>Thread Safety:</strong> This class is thread-safe. Multiple threads
 * may call {@link #append(Object)} concurrently. The producer uses internal
 * synchronization to ensure batches are sent atomically.
 */
public final class IdempotentProducer implements AutoCloseable {

    private final DurableStream client;
    private final String url;
    private final String producerId;
    private final Config config;

    private final AtomicLong epoch;
    private final AtomicLong nextSeq;
    private final AtomicInteger inFlight;
    private final AtomicBoolean closed;

    // Lock for batch accumulation and dispatch
    private final Object batchLock = new Object();
    // Lock for epoch transitions during auto-claim retry
    private final Object epochLock = new Object();

    // Guarded by batchLock
    private List<byte[]> pendingBatch;
    private int batchBytes;
    private ScheduledFuture<?> lingerTimer;

    private final ScheduledExecutorService scheduler;

    // Track in-flight futures for true fire-and-forget with flush
    private final ConcurrentLinkedQueue<CompletableFuture<Void>> inFlightFutures;

    private final BlockingQueue<DurableStreamException> errors;

    // Track sequence completions for 409 retry coordination
    // When HTTP requests arrive out of order, we get 409 errors.
    // Maps epoch -> (seq -> CompletableFuture that completes when seq is done)
    private final ConcurrentHashMap<Long, ConcurrentHashMap<Long, CompletableFuture<Void>>> seqState;

    public IdempotentProducer(DurableStream client, String url, String producerId, Config config) {
        this.client = client;
        this.url = url;
        this.producerId = producerId;
        // LingerMs=0 treated as default (5ms) for backward compatibility
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

        // Track sequence completions for 409 retry
        this.seqState = new ConcurrentHashMap<>();
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
     *
     * @throws DurableStreamException if any batch failed during flush
     * @throws DurableStreamException with cause InterruptedException if thread was interrupted
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
                    } catch (TimeoutException e) {
                        // Expected - just continue polling
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        throw new DurableStreamException("Flush interrupted", e);
                    } catch (ExecutionException e) {
                        // Batch failure - error is already queued via whenComplete handler
                        // Continue to drain remaining in-flight operations
                    } catch (CancellationException e) {
                        // Task was cancelled - continue draining
                    }
                }
            }
        }

        // Collect all errors, using suppressed exceptions for multiple failures
        DurableStreamException firstError = null;
        DurableStreamException error;
        while ((error = errors.poll()) != null) {
            if (firstError == null) {
                firstError = error;
            } else {
                firstError.addSuppressed(error);
            }
        }
        if (firstError != null) {
            throw firstError;
        }
    }

    private void sendBatchForFlush() {
        if (pendingBatch.isEmpty()) return;
        dispatchBatch();
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
            sendBatch();
        }
    }

    private void sendBatch() {
        if (pendingBatch.isEmpty()) return;

        cancelLingerTimer();

        // Like Go: don't block if at capacity - let linger timer retry later
        if (inFlight.get() >= config.maxInFlight) {
            if (lingerTimer == null) {
                lingerTimer = scheduler.schedule(this::onLingerTimeout, 1, TimeUnit.MILLISECONDS);
            }
            return;
        }

        dispatchBatch();
    }

    private void dispatchBatch() {
        List<byte[]> batch = pendingBatch;
        pendingBatch = new ArrayList<>(1024);
        batchBytes = 0;

        long seq = nextSeq.getAndIncrement();
        long currentEpoch = epoch.get();

        inFlight.incrementAndGet();

        // Create a CompletableFuture that we control, and add it to the queue
        // BEFORE starting the async operation. This prevents a race where the
        // HTTP completes before we add to the queue.
        CompletableFuture<Void> trackedFuture = new CompletableFuture<>();
        inFlightFutures.add(trackedFuture);

        sendBatchFireAndForget(batch, currentEpoch, seq)
            .whenComplete((v, ex) -> {
                inFlight.decrementAndGet();
                inFlightFutures.remove(trackedFuture);
                if (ex != null) {
                    trackedFuture.completeExceptionally(ex);
                } else {
                    trackedFuture.complete(null);
                }
            });
    }

    private void cancelLingerTimer() {
        if (lingerTimer != null) {
            lingerTimer.cancel(false);
            lingerTimer = null;
        }
    }

    /**
     * Get or create the future for tracking a sequence completion.
     */
    private CompletableFuture<Void> getSeqFuture(long epochVal, long seq) {
        return seqState
            .computeIfAbsent(epochVal, k -> new ConcurrentHashMap<>())
            .computeIfAbsent(seq, k -> new CompletableFuture<>());
    }

    /**
     * Signal that a sequence has completed (success or failure).
     */
    private void signalSeqComplete(long epochVal, long seq, Throwable error) {
        ConcurrentHashMap<Long, CompletableFuture<Void>> epochMap = seqState.get(epochVal);
        if (epochMap == null) return;

        CompletableFuture<Void> future = epochMap.get(seq);
        if (future != null) {
            if (error != null) {
                future.completeExceptionally(error);
            } else {
                future.complete(null);
            }
        }

        // Clean up old entries to prevent unbounded memory growth
        long cleanupThreshold = seq - config.maxInFlight * 3;
        if (cleanupThreshold > 0) {
            epochMap.keySet().removeIf(oldSeq -> oldSeq < cleanupThreshold);
        }
    }

    /**
     * Wait for a specific sequence to complete.
     */
    private CompletableFuture<Void> waitForSeq(long epochVal, long seq) {
        return getSeqFuture(epochVal, seq);
    }

    private CompletableFuture<Void> sendBatchFireAndForget(List<byte[]> batch, long batchEpoch, long seq) {
        // Register this sequence before sending
        getSeqFuture(batchEpoch, seq);
        return sendBatchWithRetry(batch, batchEpoch, seq, false);
    }

    private CompletableFuture<Void> sendBatchWithRetry(List<byte[]> batch, long batchEpoch, long seq, boolean isRetry) {
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
                .thenCompose(response -> {
                    int status = response.statusCode();

                    if (status == 200 || status == 201 || status == 204) {
                        // Success or duplicate (idempotent)
                        signalSeqComplete(batchEpoch, seq, null);
                        return CompletableFuture.completedFuture(null);
                    } else if (status == 403) {
                        // Stale epoch
                        long serverEpoch = parseEpochFromResponse(response);

                        if (config.autoClaim && !isRetry) {
                            // Auto-claim: retry with epoch+1
                            // Synchronize to prevent multiple concurrent batches from racing
                            long retrySeq;
                            synchronized (epochLock) {
                                long currentEpoch = epoch.get();
                                // Only claim if we haven't already moved past this epoch
                                if (currentEpoch <= serverEpoch) {
                                    long newEpoch = serverEpoch + 1;
                                    epoch.set(newEpoch);
                                    nextSeq.set(0);  // Reset sequence for new epoch
                                }
                                // Get next sequence atomically within lock to prevent
                                // multiple retried batches from using the same seq
                                retrySeq = nextSeq.getAndIncrement();
                            }
                            // Retry with new epoch and proper sequence
                            return sendBatchWithRetry(batch, epoch.get(), retrySeq, true);
                        }

                        StaleEpochException err = new StaleEpochException(serverEpoch);
                        signalSeqComplete(batchEpoch, seq, err);
                        errors.offer(err);
                        if (config.onError != null) {
                            config.onError.accept(err);
                        }
                        return CompletableFuture.failedFuture(err);
                    } else if (status == 409) {
                        // Parse expected sequence from response header
                        long expectedSeq = response.headers()
                            .firstValue("Producer-Expected-Seq")
                            .map(Long::parseLong)
                            .orElse(-1L);

                        // If expectedSeq < seq, it means earlier sequences haven't completed yet
                        // Wait for them, then retry with the same seq (server expects this seq)
                        if (expectedSeq >= 0 && expectedSeq < seq) {
                            // Build list of futures to wait for
                            List<CompletableFuture<Void>> waitFutures = new ArrayList<>();
                            for (long s = expectedSeq; s < seq; s++) {
                                waitFutures.add(waitForSeq(batchEpoch, s));
                            }

                            // Wait for all earlier sequences, then retry
                            return CompletableFuture.allOf(waitFutures.toArray(new CompletableFuture[0]))
                                .thenCompose(v -> sendBatchWithRetry(batch, batchEpoch, seq, false));
                        }

                        // Can't retry - permanent conflict
                        SequenceConflictException err = handleSequenceConflict(seq, response);
                        signalSeqComplete(batchEpoch, seq, err);
                        errors.offer(err);
                        if (config.onError != null) {
                            config.onError.accept(err);
                        }
                        return CompletableFuture.failedFuture(err);
                    } else {
                        DurableStreamException err = new DurableStreamException("Batch failed with status: " + status, status);
                        signalSeqComplete(batchEpoch, seq, err);
                        errors.offer(err);
                        if (config.onError != null) {
                            config.onError.accept(err);
                        }
                        return CompletableFuture.failedFuture(err);
                    }
                })
                .exceptionally(ex -> {
                    Throwable cause = ex.getCause() != null ? ex.getCause() : ex;
                    DurableStreamException err = new DurableStreamException("Batch send failed: " + cause.getMessage(), cause);
                    signalSeqComplete(batchEpoch, seq, err);
                    errors.offer(err);
                    if (config.onError != null) {
                        config.onError.accept(err);
                    }
                    return null;
                });
    }

    private SequenceConflictException handleSequenceConflict(long seq, HttpResponse<byte[]> response) {
        String expectedSeqStr = response.headers()
                .firstValue("Producer-Expected-Seq")
                .orElse("unknown");
        return new SequenceConflictException(expectedSeqStr, String.valueOf(seq));
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
            throw new IllegalArgumentException(
                "append() accepts byte[] or String only. Serialize objects before appending: " +
                "producer.append(gson.toJson(myObject))");
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
            int totalLen = 0;
            for (byte[] bytes : batch) {
                totalLen += bytes.length;
            }
            byte[] result = new byte[totalLen];
            int pos = 0;
            for (byte[] bytes : batch) {
                System.arraycopy(bytes, 0, result, pos, bytes.length);
                pos += bytes.length;
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
