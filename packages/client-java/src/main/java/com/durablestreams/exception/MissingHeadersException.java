package com.durablestreams.exception;

/**
 * Thrown when a successful stream response is missing required protocol headers.
 */
public class MissingHeadersException extends DurableStreamException {
    public MissingHeadersException(String message) {
        super(message);
    }
}
