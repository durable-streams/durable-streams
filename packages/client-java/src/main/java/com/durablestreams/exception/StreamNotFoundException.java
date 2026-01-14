package com.durablestreams.exception;

/**
 * Thrown when a stream does not exist (404).
 */
public class StreamNotFoundException extends DurableStreamException {
    private final String url;

    public StreamNotFoundException(String url) {
        super("Stream not found: " + url, 404, "NOT_FOUND");
        this.url = url;
    }

    /**
     * Returns the URL of the stream that was not found.
     */
    public String getUrl() {
        return url;
    }
}
