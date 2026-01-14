package com.durablestreams.model;

/**
 * Live streaming mode for read operations.
 */
public enum LiveMode {
    /** Catch-up only, stop at stream end. */
    OFF(null),

    /** HTTP long-polling for live updates. */
    LONG_POLL("long-poll"),

    /** Server-Sent Events for real-time streaming. */
    SSE("sse");

    private final String wireValue;

    LiveMode(String wireValue) {
        this.wireValue = wireValue;
    }

    /**
     * Value to send in the 'live' query parameter.
     * Returns null for OFF mode (don't include parameter).
     */
    public String getWireValue() {
        return wireValue;
    }

    /**
     * Parse live mode from various input formats (for adapter compatibility).
     */
    public static LiveMode parse(Object value) {
        if (value == null) return OFF;
        if (value instanceof Boolean) {
            return ((Boolean) value) ? LONG_POLL : OFF;
        }
        String s = value.toString().toLowerCase();
        switch (s) {
            case "long-poll":
            case "longpoll":
                return LONG_POLL;
            case "sse":
                return SSE;
            case "true":
                return LONG_POLL;
            case "false":
            case "off":
            case "":
                return OFF;
            default:
                return OFF;
        }
    }
}
