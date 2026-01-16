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

    public Metadata(String contentType, Offset nextOffset, Duration ttl,
                    Instant expiresAt, String etag) {
        this.contentType = contentType;
        this.nextOffset = nextOffset;
        this.ttl = ttl;
        this.expiresAt = expiresAt;
        this.etag = etag;
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

    @Override
    public String toString() {
        return "Metadata{" +
               "contentType='" + contentType + '\'' +
               ", nextOffset=" + nextOffset +
               ", ttl=" + ttl +
               ", expiresAt=" + expiresAt +
               ", etag='" + etag + '\'' +
               '}';
    }
}
