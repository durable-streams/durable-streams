package com.durablestreams.model;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

/**
 * Stream metadata returned from HEAD requests.
 */
public final class Metadata {
    private final String contentType;
    private final Offset nextOffset;
    private final Duration ttl;
    private final Instant expiresAt;
    private final String etag;
    private final boolean streamClosed;

    public Metadata(String contentType, Offset nextOffset, Duration ttl,
                    Instant expiresAt, String etag) {
        this(contentType, nextOffset, ttl, expiresAt, etag, false);
    }

    public Metadata(String contentType, Offset nextOffset, Duration ttl,
                    Instant expiresAt, String etag, boolean streamClosed) {
        this.contentType = contentType;
        this.nextOffset = nextOffset;
        this.ttl = ttl;
        this.expiresAt = expiresAt;
        this.etag = etag;
        this.streamClosed = streamClosed;
    }

    public String getContentType() {
        return contentType;
    }

    public Offset getNextOffset() {
        return nextOffset;
    }

    public Optional<Duration> getTtl() {
        return Optional.ofNullable(ttl);
    }

    public Optional<Instant> getExpiresAt() {
        return Optional.ofNullable(expiresAt);
    }

    public Optional<String> getEtag() {
        return Optional.ofNullable(etag);
    }

    public boolean isStreamClosed() {
        return streamClosed;
    }

    @Override
    public String toString() {
        return "Metadata{" +
               "contentType='" + contentType + '\'' +
               ", nextOffset=" + nextOffset +
               ", ttl=" + ttl +
               ", expiresAt=" + expiresAt +
               ", etag='" + etag + '\'' +
               ", streamClosed=" + streamClosed +
               '}';
    }
}
