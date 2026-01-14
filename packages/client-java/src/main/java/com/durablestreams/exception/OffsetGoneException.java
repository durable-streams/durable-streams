package com.durablestreams.exception;

/**
 * Thrown when the requested offset is before the retention window (410).
 */
public class OffsetGoneException extends DurableStreamException {
    private final String offset;

    public OffsetGoneException(String offset) {
        super("Offset gone (before retention window): " + offset, 410, "OFFSET_GONE");
        this.offset = offset;
    }

    /**
     * Returns the offset that was requested but is no longer available.
     */
    public String getOffset() {
        return offset;
    }
}
