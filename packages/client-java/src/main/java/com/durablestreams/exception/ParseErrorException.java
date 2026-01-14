package com.durablestreams.exception;

/**
 * Exception thrown when there is a parsing error in the stream data.
 * This includes malformed SSE control events and invalid JSON responses.
 */
public class ParseErrorException extends DurableStreamException {
    public ParseErrorException(String message) {
        super(message);
    }

    public ParseErrorException(String message, Throwable cause) {
        super(message, cause);
    }
}
