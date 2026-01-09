package com.durablestreams.exception;

/**
 * Thrown when the requested offset is before the retention window (410).
 */
public class OffsetGoneException extends DurableStreamException {
    public OffsetGoneException(String offset) {
        super("Offset gone (before retention window): " + offset, 410, "OFFSET_GONE");
    }
}
