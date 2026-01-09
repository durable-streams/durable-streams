package com.durablestreams.model;

import java.util.Map;
import java.util.Optional;

/**
 * A chunk represents one HTTP response body from the server.
 * For binary streams, this is raw bytes.
 * For JSON streams, a chunk may contain multiple JSON messages (as a JSON array).
 */
public final class Chunk {
    private final byte[] data;
    private final Offset nextOffset;
    private final boolean upToDate;
    private final String cursor;
    private final int statusCode;
    private final Map<String, String> headers;

    public Chunk(byte[] data, Offset nextOffset, boolean upToDate,
                 String cursor, int statusCode, Map<String, String> headers) {
        this.data = data;
        this.nextOffset = nextOffset;
        this.upToDate = upToDate;
        this.cursor = cursor;
        this.statusCode = statusCode;
        this.headers = headers != null ? headers : Map.of();
    }

    public byte[] getData() {
        return data;
    }

    public String getDataAsString() {
        return data != null ? new String(data, java.nio.charset.StandardCharsets.UTF_8) : "";
    }

    public Offset getNextOffset() {
        return nextOffset;
    }

    public boolean isUpToDate() {
        return upToDate;
    }

    public Optional<String> getCursor() {
        return Optional.ofNullable(cursor);
    }

    public int getStatusCode() {
        return statusCode;
    }

    public Map<String, String> getHeaders() {
        return headers;
    }

    @Override
    public String toString() {
        return "Chunk{" +
               "dataLength=" + (data != null ? data.length : 0) +
               ", nextOffset=" + nextOffset +
               ", upToDate=" + upToDate +
               ", statusCode=" + statusCode +
               '}';
    }
}
