package com.durablestreams.exception;

import java.util.Map;
import java.util.Optional;

/**
 * Base exception for all Durable Streams errors.
 */
public class DurableStreamException extends RuntimeException {
    private final Integer statusCode;
    private final String errorCode;
    private final Map<String, String> responseHeaders;

    public DurableStreamException(String message) {
        this(message, null, null, null, null);
    }

    public DurableStreamException(String message, Throwable cause) {
        this(message, cause, null, null, null);
    }

    public DurableStreamException(String message, Integer statusCode) {
        this(message, null, statusCode, null, null);
    }

    public DurableStreamException(String message, Integer statusCode, String errorCode) {
        this(message, null, statusCode, errorCode, null);
    }

    public DurableStreamException(String message, Throwable cause, Integer statusCode,
                                   String errorCode, Map<String, String> responseHeaders) {
        super(message, cause);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.responseHeaders = responseHeaders;
    }

    public Optional<Integer> getStatusCode() {
        return Optional.ofNullable(statusCode);
    }

    public Optional<String> getErrorCode() {
        return Optional.ofNullable(errorCode);
    }

    public Map<String, String> getResponseHeaders() {
        return responseHeaders != null ? responseHeaders : Map.of();
    }
}
