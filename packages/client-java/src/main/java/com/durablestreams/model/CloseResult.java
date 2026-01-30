package com.durablestreams.model;

/**
 * Result of closing a stream.
 */
public final class CloseResult {
    private final Offset finalOffset;

    public CloseResult(Offset finalOffset) {
        this.finalOffset = finalOffset;
    }

    /**
     * The final offset after closing (position after any appended data).
     */
    public Offset getFinalOffset() {
        return finalOffset;
    }

    @Override
    public String toString() {
        return "CloseResult{" +
               "finalOffset=" + finalOffset +
               '}';
    }
}
