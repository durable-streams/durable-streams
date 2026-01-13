package com.durablestreams;

import com.durablestreams.exception.DurableStreamException;
import com.durablestreams.internal.sse.SSEStreamingReader;
import com.durablestreams.model.*;

import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.concurrent.TimeoutException;

/**
 * Iterator for reading chunks from a stream.
 * Implements both Iterator and Iterable for natural for-each usage.
 *
 * In SSE mode, maintains a single long-lived streaming connection.
 * In other modes, makes individual HTTP requests per chunk.
 */
public final class ChunkIterator implements Iterator<Chunk>, Iterable<Chunk>, AutoCloseable {

    private final DurableStream client;
    private final String url;
    private final LiveMode liveMode;
    private final Duration timeout;

    private Offset currentOffset;
    private String cursor;
    private boolean upToDate;
    private boolean closed;
    private Chunk nextChunk;
    private boolean hasNextComputed;

    // SSE streaming state
    private SSEStreamingReader sseReader;
    private boolean sseStarted;

    ChunkIterator(DurableStream client, String url, Offset offset, LiveMode liveMode, Duration timeout, String cursor) {
        this.client = client;
        this.url = url;
        this.currentOffset = offset != null ? offset : Offset.BEGINNING;
        this.liveMode = liveMode != null ? liveMode : LiveMode.OFF;
        this.timeout = timeout;
        this.cursor = cursor;
        this.upToDate = false;
        this.closed = false;
        this.hasNextComputed = false;
        this.sseStarted = false;
    }

    @Override
    public Iterator<Chunk> iterator() {
        return this;
    }

    /**
     * Returns true if there are more chunks available.
     *
     * <p><strong>Note:</strong> This method may block and perform network I/O.
     * In live modes (SSE, long-poll), it will wait for data from the server.
     * For non-blocking checks, use {@link #poll(Duration)} instead.
     *
     * @throws DurableStreamException if a network or server error occurs
     */
    @Override
    public boolean hasNext() {
        if (closed) return false;
        if (hasNextComputed) return nextChunk != null;

        // In catch-up mode, stop when up-to-date
        if (liveMode == LiveMode.OFF && upToDate) {
            return false;
        }

        try {
            nextChunk = fetchNext();
            hasNextComputed = true;
            return nextChunk != null;
        } catch (DurableStreamException e) {
            throw e;
        }
    }

    @Override
    public Chunk next() {
        if (!hasNext()) {
            throw new NoSuchElementException();
        }
        hasNextComputed = false;
        Chunk chunk = nextChunk;
        nextChunk = null;
        updateStateFromChunk(chunk);
        return chunk;
    }

    private void updateStateFromChunk(Chunk chunk) {
        if (chunk.getNextOffset() != null) {
            currentOffset = chunk.getNextOffset();
        }
        cursor = chunk.getCursor().orElse(null);
        upToDate = chunk.isUpToDate();
    }

    /**
     * Poll for the next chunk with a timeout.
     * Returns null if no data is available within the timeout.
     */
    public Chunk poll(Duration timeout) throws DurableStreamException {
        if (closed) return null;
        if (liveMode == LiveMode.OFF && upToDate) return null;

        // Use SSE streaming for SSE mode
        if (liveMode == LiveMode.SSE) {
            return pollSSE(timeout);
        }

        Chunk chunk;
        try {
            chunk = client.readOnce(url,currentOffset, liveMode, timeout, cursor);
        } catch (DurableStreamException e) {
            Throwable cause = e.getCause();
            if (cause instanceof HttpTimeoutException || cause instanceof TimeoutException) {
                upToDate = true;
                return null;
            }
            throw e;
        }

        if (chunk.getStatusCode() == 204) {
            if (chunk.getNextOffset() != null) {
                currentOffset = chunk.getNextOffset();
            }
            upToDate = true;
            return null;
        }

        updateStateFromChunk(chunk);
        return chunk;
    }

    private Chunk pollSSE(Duration timeout) throws DurableStreamException {
        ensureSSEStarted();

        if (sseReader.isClosed()) {
            return null;
        }

        long timeoutMs = timeout != null ? timeout.toMillis() : 30000;
        Chunk chunk = sseReader.poll(timeoutMs);

        if (chunk != null) {
            updateStateFromChunk(chunk);
        }

        return chunk;
    }

    private void ensureSSEStarted() throws DurableStreamException {
        if (sseStarted) return;

        sseReader = client.openSSEStream(url,currentOffset, cursor);
        sseReader.start();
        sseStarted = true;
    }

    private Chunk fetchNext() throws DurableStreamException {
        // Use SSE streaming for SSE mode
        if (liveMode == LiveMode.SSE) {
            return fetchNextSSE();
        }

        Chunk chunk = client.readOnce(url,currentOffset, liveMode, timeout, cursor);

        // 204 No Content - in live modes, this means timeout with no data
        if (chunk.getStatusCode() == 204) {
            if (liveMode == LiveMode.OFF) {
                upToDate = true;
                return null;
            }
            return chunk;
        }

        // Empty body with 200 in catch-up mode means we're at the end
        if (liveMode == LiveMode.OFF && chunk.getData().length == 0 && chunk.isUpToDate()) {
            if (chunk.getNextOffset() != null) {
                currentOffset = chunk.getNextOffset();
            }
            upToDate = true;
            return null;
        }

        return chunk;
    }

    private Chunk fetchNextSSE() throws DurableStreamException {
        ensureSSEStarted();

        if (sseReader.isClosed()) {
            return null;
        }

        // For SSE, use the configured timeout or a reasonable default
        long timeoutMs = timeout != null ? timeout.toMillis() : 60000;
        return sseReader.poll(timeoutMs);
    }

    /**
     * Current offset position.
     */
    public Offset getCurrentOffset() {
        // For SSE mode, get offset from the reader
        if (sseReader != null && sseReader.getCurrentOffset() != null) {
            return sseReader.getCurrentOffset();
        }
        return currentOffset;
    }

    /**
     * Whether we've caught up to the stream tail.
     */
    public boolean isUpToDate() {
        if (sseReader != null) {
            return sseReader.isUpToDate();
        }
        return upToDate;
    }

    @Override
    public void close() {
        closed = true;
        if (sseReader != null) {
            sseReader.close();
        }
    }
}
