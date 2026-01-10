package com.durablestreams;

import com.durablestreams.exception.DurableStreamException;
import com.durablestreams.model.*;

import java.time.Duration;
import java.util.Iterator;
import java.util.NoSuchElementException;

/**
 * Iterator for reading chunks from a stream.
 * Implements both Iterator and Iterable for natural for-each usage.
 */
public final class ChunkIterator implements Iterator<Chunk>, Iterable<Chunk>, AutoCloseable {

    private final Stream stream;
    private final LiveMode liveMode;
    private final Duration timeout;

    private Offset currentOffset;
    private String cursor;
    private boolean upToDate;
    private boolean closed;
    private Chunk nextChunk;
    private boolean hasNextComputed;

    ChunkIterator(Stream stream, Offset offset, LiveMode liveMode, Duration timeout, String cursor) {
        this.stream = stream;
        this.currentOffset = offset != null ? offset : Offset.BEGINNING;
        this.liveMode = liveMode != null ? liveMode : LiveMode.OFF;
        this.timeout = timeout;
        this.cursor = cursor;
        this.upToDate = false;
        this.closed = false;
        this.hasNextComputed = false;
    }

    @Override
    public Iterator<Chunk> iterator() {
        return this;
    }

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
            throw new RuntimeException(e);
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

        Chunk chunk;
        try {
            chunk = stream.readOnce(currentOffset, liveMode, timeout, cursor);
        } catch (DurableStreamException e) {
            // Check if this is a timeout exception
            Throwable cause = e.getCause();
            if (cause != null && cause.getClass().getName().contains("Timeout")) {
                // Treat timeout as 204 - no new data
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

    private Chunk fetchNext() throws DurableStreamException {
        Chunk chunk = stream.readOnce(currentOffset, liveMode, timeout, cursor);

        // 204 No Content - in live modes, this means timeout with no data
        if (chunk.getStatusCode() == 204) {
            if (liveMode == LiveMode.OFF) {
                // Catch-up mode: we're done
                upToDate = true;
                return null;
            }
            // Live mode: return empty chunk to indicate timeout
            return chunk;
        }

        // Empty body with 200 in catch-up mode means we're at the end
        if (liveMode == LiveMode.OFF && chunk.getData().length == 0 && chunk.isUpToDate()) {
            // Update offset from response even though we're returning null
            // This is important for offset="now" which returns empty data but valid offset
            if (chunk.getNextOffset() != null) {
                currentOffset = chunk.getNextOffset();
            }
            upToDate = true;
            return null;
        }

        return chunk;
    }

    /**
     * Current offset position.
     */
    public Offset getCurrentOffset() {
        return currentOffset;
    }

    /**
     * Whether we've caught up to the stream tail.
     */
    public boolean isUpToDate() {
        return upToDate;
    }

    @Override
    public void close() {
        closed = true;
    }
}
