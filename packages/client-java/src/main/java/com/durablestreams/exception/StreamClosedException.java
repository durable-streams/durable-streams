package com.durablestreams.exception;

/**
 * Exception thrown when attempting to append to a closed stream.
 */
public class StreamClosedException extends DurableStreamException {

    public StreamClosedException(String url) {
        super("Stream is closed: " + url, 409);
    }

    public StreamClosedException(String message, int statusCode) {
        super(message, statusCode);
    }
}
