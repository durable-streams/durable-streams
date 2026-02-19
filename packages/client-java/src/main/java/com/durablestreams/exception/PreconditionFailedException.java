package com.durablestreams.exception;

import com.durablestreams.model.Offset;

/**
 * Exception thrown when an If-Match precondition fails (412 response).
 *
 * <p>This occurs when using optimistic concurrency control and another writer
 * has modified the stream since the last read.
 */
public class PreconditionFailedException extends DurableStreamException {

    private final String currentETag;
    private final Offset currentOffset;
    private final boolean streamClosed;

    public PreconditionFailedException(String currentETag, Offset currentOffset, boolean streamClosed) {
        super("Precondition failed: stream was modified by another writer", 412);
        this.currentETag = currentETag;
        this.currentOffset = currentOffset;
        this.streamClosed = streamClosed;
    }

    /**
     * Get the current ETag of the stream.
     */
    public String getCurrentETag() {
        return currentETag;
    }

    /**
     * Get the current tail offset of the stream.
     */
    public Offset getCurrentOffset() {
        return currentOffset;
    }

    /**
     * Check if the stream is closed.
     */
    public boolean isStreamClosed() {
        return streamClosed;
    }
}
