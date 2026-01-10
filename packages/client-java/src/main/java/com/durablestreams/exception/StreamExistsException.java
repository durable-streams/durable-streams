package com.durablestreams.exception;

/**
 * Thrown when trying to create a stream that already exists (409).
 */
public class StreamExistsException extends DurableStreamException {
    public StreamExistsException(String url) {
        super("Stream already exists: " + url, 409, "CONFLICT");
    }
}
