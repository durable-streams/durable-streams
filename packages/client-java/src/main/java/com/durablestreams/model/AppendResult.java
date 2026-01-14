package com.durablestreams.model;

import java.util.Optional;

/**
 * Result of an append operation.
 */
public final class AppendResult {
    private final Offset nextOffset;
    private final String etag;
    private final boolean duplicate;

    public AppendResult(Offset nextOffset, String etag, boolean duplicate) {
        this.nextOffset = nextOffset;
        this.etag = etag;
        this.duplicate = duplicate;
    }

    public static AppendResult success(Offset nextOffset, String etag) {
        return new AppendResult(nextOffset, etag, false);
    }

    public static AppendResult duplicate() {
        return new AppendResult(null, null, true);
    }

    public Offset getNextOffset() {
        return nextOffset;
    }

    public Optional<String> getEtag() {
        return Optional.ofNullable(etag);
    }

    /**
     * True if this was an idempotent duplicate (204 response).
     */
    public boolean isDuplicate() {
        return duplicate;
    }

    @Override
    public String toString() {
        return "AppendResult{" +
               "nextOffset=" + nextOffset +
               ", etag='" + etag + '\'' +
               ", duplicate=" + duplicate +
               '}';
    }
}
