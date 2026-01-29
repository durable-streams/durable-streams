package com.durablestreams.model;

import java.time.Duration;

/**
 * Options for reading from a stream.
 *
 * <p>Usage:
 * <pre>{@code
 * // Fluent API
 * client.read(url, ReadOptions.from(offset).live(LiveMode.SSE).timeout(Duration.ofSeconds(30)))
 *
 * // Or with builder
 * client.read(url, ReadOptions.builder()
 *     .offset(offset)
 *     .liveMode(LiveMode.SSE)
 *     .timeout(Duration.ofSeconds(30))
 *     .build())
 *
 * // For binary streams with SSE, use base64 encoding
 * client.read(url, ReadOptions.from(offset).live(LiveMode.SSE).encoding("base64"))
 * }</pre>
 */
public final class ReadOptions {

    private final Offset offset;
    private final LiveMode liveMode;
    private final Duration timeout;
    private final String cursor;
    private final String encoding;

    private ReadOptions(Offset offset, LiveMode liveMode, Duration timeout, String cursor, String encoding) {
        this.offset = offset;
        this.liveMode = liveMode;
        this.timeout = timeout;
        this.cursor = cursor;
        this.encoding = encoding;
    }

    /**
     * Create options starting from the beginning of the stream.
     */
    public static ReadOptions create() {
        return new ReadOptions(null, LiveMode.OFF, null, null, null);
    }

    /**
     * Create options starting from the specified offset.
     */
    public static ReadOptions from(Offset offset) {
        return new ReadOptions(offset, LiveMode.OFF, null, null, null);
    }

    /**
     * Create options starting from the beginning.
     */
    public static ReadOptions fromBeginning() {
        return new ReadOptions(Offset.BEGINNING, LiveMode.OFF, null, null, null);
    }

    /**
     * Create options starting from now (skip history).
     */
    public static ReadOptions fromNow() {
        return new ReadOptions(Offset.NOW, LiveMode.OFF, null, null, null);
    }

    /**
     * Create a builder for full control.
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Set the live mode.
     */
    public ReadOptions live(LiveMode mode) {
        return new ReadOptions(this.offset, mode, this.timeout, this.cursor, this.encoding);
    }

    /**
     * Set the timeout duration.
     */
    public ReadOptions timeout(Duration timeout) {
        return new ReadOptions(this.offset, this.liveMode, timeout, this.cursor, this.encoding);
    }

    /**
     * Set the CDN cursor.
     */
    public ReadOptions cursor(String cursor) {
        return new ReadOptions(this.offset, this.liveMode, this.timeout, cursor, this.encoding);
    }

    /**
     * Set the encoding for SSE data events.
     * Required for binary streams (content-type not text/* or application/json).
     * Must not be provided for text or JSON streams.
     *
     * <p>When set to "base64", the client will:
     * <ul>
     *   <li>Add ?encoding=base64 to SSE requests</li>
     *   <li>Decode base64-encoded data events before processing</li>
     * </ul>
     *
     * <p>The encoding parameter is only valid with live=SSE mode.
     * Using it with other modes will result in an error.
     *
     * @param encoding The encoding type (e.g., "base64")
     */
    public ReadOptions encoding(String encoding) {
        return new ReadOptions(this.offset, this.liveMode, this.timeout, this.cursor, encoding);
    }

    // Getters

    public Offset getOffset() {
        return offset;
    }

    public LiveMode getLiveMode() {
        return liveMode;
    }

    public Duration getTimeout() {
        return timeout;
    }

    public String getCursor() {
        return cursor;
    }

    public String getEncoding() {
        return encoding;
    }

    /**
     * Builder for ReadOptions.
     */
    public static final class Builder {
        private Offset offset;
        private LiveMode liveMode = LiveMode.OFF;
        private Duration timeout;
        private String cursor;
        private String encoding;

        public Builder offset(Offset offset) {
            this.offset = offset;
            return this;
        }

        public Builder liveMode(LiveMode liveMode) {
            this.liveMode = liveMode;
            return this;
        }

        public Builder timeout(Duration timeout) {
            this.timeout = timeout;
            return this;
        }

        public Builder cursor(String cursor) {
            this.cursor = cursor;
            return this;
        }

        public Builder encoding(String encoding) {
            this.encoding = encoding;
            return this;
        }

        public ReadOptions build() {
            return new ReadOptions(offset, liveMode, timeout, cursor, encoding);
        }
    }
}
