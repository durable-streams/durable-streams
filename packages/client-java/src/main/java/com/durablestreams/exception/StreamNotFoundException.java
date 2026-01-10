package com.durablestreams.exception;

/**
 * Thrown when a stream does not exist (404).
 */
public class StreamNotFoundException extends DurableStreamException {
    public StreamNotFoundException(String url) {
        super("Stream not found: " + url, 404, "NOT_FOUND");
    }
}
