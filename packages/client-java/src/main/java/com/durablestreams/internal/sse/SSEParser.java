package com.durablestreams.internal.sse;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Parser for Server-Sent Events (SSE) streams.
 */
public final class SSEParser {

    private final BufferedReader reader;
    private boolean closed;

    public SSEParser(InputStream input) {
        this.reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8));
        this.closed = false;
    }

    /**
     * Read the next SSE event.
     * Returns null if the stream is closed.
     */
    public SSEEvent nextEvent() throws IOException {
        if (closed) return null;

        StringBuilder data = new StringBuilder();
        String eventType = "message";
        String id = null;
        Integer retry = null;

        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isEmpty()) {
                // Empty line marks end of event
                if (data.length() > 0) {
                    // Remove trailing newline if present
                    if (data.charAt(data.length() - 1) == '\n') {
                        data.setLength(data.length() - 1);
                    }
                    return new SSEEvent(eventType, data.toString(), id, retry);
                }
                continue;
            }

            if (line.startsWith(":")) {
                // Comment, ignore
                continue;
            }

            int colonIndex = line.indexOf(':');
            String field, value;
            if (colonIndex == -1) {
                field = line;
                value = "";
            } else {
                field = line.substring(0, colonIndex);
                value = line.substring(colonIndex + 1);
                // Remove leading space from value if present
                if (value.startsWith(" ")) {
                    value = value.substring(1);
                }
            }

            switch (field) {
                case "event":
                    eventType = value;
                    break;
                case "data":
                    data.append(value).append("\n");
                    break;
                case "id":
                    id = value;
                    break;
                case "retry":
                    try {
                        retry = Integer.parseInt(value);
                    } catch (NumberFormatException e) {
                        // Ignore invalid retry values
                    }
                    break;
                default:
                    // Unknown field, ignore
                    break;
            }
        }

        // End of stream
        closed = true;
        if (data.length() > 0) {
            if (data.charAt(data.length() - 1) == '\n') {
                data.setLength(data.length() - 1);
            }
            return new SSEEvent(eventType, data.toString(), id, retry);
        }
        return null;
    }

    /**
     * Check if the parser is closed.
     */
    public boolean isClosed() {
        return closed;
    }

    /**
     * Close the parser and underlying stream.
     */
    public void close() throws IOException {
        closed = true;
        reader.close();
    }

    /**
     * Represents a single SSE event.
     */
    public static final class SSEEvent {
        private final String event;
        private final String data;
        private final String id;
        private final Integer retry;

        public SSEEvent(String event, String data, String id, Integer retry) {
            this.event = event;
            this.data = data;
            this.id = id;
            this.retry = retry;
        }

        public String getEvent() {
            return event;
        }

        public String getData() {
            return data;
        }

        public Optional<String> getId() {
            return Optional.ofNullable(id);
        }

        public Optional<Integer> getRetry() {
            return Optional.ofNullable(retry);
        }

        /**
         * Check if this is a control event (contains stream metadata).
         */
        public boolean isControl() {
            return "control".equals(event);
        }

        @Override
        public String toString() {
            return "SSEEvent{" +
                   "event='" + event + '\'' +
                   ", data='" + data + '\'' +
                   ", id='" + id + '\'' +
                   ", retry=" + retry +
                   '}';
        }
    }
}
