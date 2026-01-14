package com.durablestreams.internal.sse;

import com.durablestreams.exception.DurableStreamException;
import com.durablestreams.exception.StreamNotFoundException;
import com.durablestreams.model.Chunk;
import com.durablestreams.model.Offset;

import java.io.IOException;
import java.io.InputStream;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Reads chunks from an SSE streaming connection.
 *
 * SSE events come in pairs:
 * - event: data - contains the stream data
 * - event: control - contains JSON with streamNextOffset, streamCursor, upToDate
 *
 * This reader parses the stream and produces Chunk objects.
 */
public final class SSEStreamingReader implements AutoCloseable {

    private final HttpClient httpClient;
    private final HttpRequest request;
    private final BlockingQueue<ChunkOrError> chunkQueue;
    private final AtomicBoolean closed;
    private final AtomicBoolean started;

    private volatile Thread readerThread;
    private volatile InputStream inputStream;
    private volatile HttpResponse<InputStream> response;
    private volatile Offset currentOffset;
    private volatile String currentCursor;
    private volatile boolean upToDate;

    public SSEStreamingReader(HttpClient httpClient, HttpRequest request, Offset initialOffset) {
        this.httpClient = httpClient;
        this.request = request;
        this.chunkQueue = new LinkedBlockingQueue<>();
        this.closed = new AtomicBoolean(false);
        this.started = new AtomicBoolean(false);
        this.currentOffset = initialOffset;
        this.upToDate = false;
    }

    /**
     * Start the SSE streaming connection.
     * Must be called before reading chunks.
     */
    public void start() throws DurableStreamException {
        if (!started.compareAndSet(false, true)) {
            return; // Already started
        }

        try {
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
            int status = response.statusCode();

            if (status == 404) {
                throw new StreamNotFoundException(request.uri().toString());
            } else if (status != 200) {
                throw new DurableStreamException("SSE connection failed with status: " + status, status);
            }

            inputStream = response.body();

            // Start background thread to read SSE events
            readerThread = new Thread(this::readLoop, "sse-reader");
            readerThread.setDaemon(true);
            readerThread.start();

        } catch (IOException e) {
            throw new DurableStreamException("Failed to open SSE connection: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DurableStreamException("SSE connection interrupted", e);
        }
    }

    /**
     * Poll for the next chunk.
     * Returns null if no chunk is available within the timeout.
     */
    public Chunk poll(long timeoutMs) throws DurableStreamException {
        if (closed.get()) {
            return null;
        }

        try {
            ChunkOrError result = chunkQueue.poll(timeoutMs, TimeUnit.MILLISECONDS);
            if (result == null) {
                return null;
            }
            if (result.error != null) {
                throw result.error;
            }
            return result.chunk;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    /**
     * Get the current offset position.
     */
    public Offset getCurrentOffset() {
        return currentOffset;
    }

    /**
     * Get the current cursor.
     */
    public String getCurrentCursor() {
        return currentCursor;
    }

    /**
     * Whether the stream is caught up.
     */
    public boolean isUpToDate() {
        return upToDate;
    }

    /**
     * Check if the reader is closed.
     */
    public boolean isClosed() {
        return closed.get();
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return; // Already closed
        }

        // Interrupt the reader thread
        if (readerThread != null) {
            readerThread.interrupt();
        }

        // Close the input stream
        if (inputStream != null) {
            try {
                inputStream.close();
            } catch (IOException e) {
                // Ignore close errors
            }
        }
    }

    private void readLoop() {
        SSEParser parser = new SSEParser(inputStream);
        // Accumulate data from multiple data events until control event
        List<String> pendingDataList = new ArrayList<>();

        try {
            while (!closed.get() && !Thread.currentThread().isInterrupted()) {
                SSEParser.SSEEvent event = parser.nextEvent();
                if (event == null) {
                    // Stream ended
                    break;
                }

                if ("data".equals(event.getEvent())) {
                    // Accumulate data events until we see a control event
                    pendingDataList.add(event.getData());
                } else if ("control".equals(event.getEvent())) {
                    // Combine all accumulated data and create chunk
                    String allData = String.join("", pendingDataList);
                    Chunk chunk = createChunkFromControl(
                        allData.isEmpty() ? null : allData,
                        event.getData()
                    );
                    if (chunk != null) {
                        chunkQueue.offer(new ChunkOrError(chunk));

                        // Update state
                        if (chunk.getNextOffset() != null) {
                            currentOffset = chunk.getNextOffset();
                        }
                        currentCursor = chunk.getCursor().orElse(null);
                        upToDate = chunk.isUpToDate();
                    }
                    pendingDataList.clear();
                }
                // Ignore other event types
            }
        } catch (IOException e) {
            if (!closed.get()) {
                chunkQueue.offer(new ChunkOrError(
                    new DurableStreamException("SSE read error: " + e.getMessage(), e)));
            }
        } finally {
            // Signal end of stream
            if (!closed.get()) {
                closed.set(true);
            }
        }
    }

    private Chunk createChunkFromControl(String data, String controlJson) {
        // Parse control JSON: {"streamNextOffset":"...", "streamCursor":"...", "upToDate":...}
        String nextOffset = null;
        String cursor = null;
        boolean isUpToDate = false;

        // Simple JSON parsing (avoid external dependencies)
        if (controlJson != null) {
            nextOffset = extractJsonString(controlJson, "streamNextOffset");
            cursor = extractJsonString(controlJson, "streamCursor");
            isUpToDate = extractJsonBoolean(controlJson, "upToDate");
        }

        byte[] dataBytes = data != null ? data.getBytes(StandardCharsets.UTF_8) : new byte[0];

        Map<String, String> headers = new HashMap<>();
        if (nextOffset != null) {
            headers.put("stream-next-offset", nextOffset);
        }
        if (cursor != null) {
            headers.put("stream-cursor", cursor);
        }

        return new Chunk(
            dataBytes,
            nextOffset != null ? Offset.of(nextOffset) : null,
            isUpToDate,
            cursor,
            200,
            headers
        );
    }

    private static String extractJsonString(String json, String key) {
        // Look for "key":"value" or "key": "value"
        String pattern = "\"" + key + "\"\\s*:\\s*\"";
        int keyStart = json.indexOf("\"" + key + "\"");
        if (keyStart < 0) return null;

        int colonPos = json.indexOf(':', keyStart);
        if (colonPos < 0) return null;

        int valueStart = json.indexOf('"', colonPos + 1);
        if (valueStart < 0) return null;

        int valueEnd = json.indexOf('"', valueStart + 1);
        if (valueEnd < 0) return null;

        return json.substring(valueStart + 1, valueEnd);
    }

    private static boolean extractJsonBoolean(String json, String key) {
        String pattern = "\"" + key + "\"";
        int keyStart = json.indexOf(pattern);
        if (keyStart < 0) return false;

        int colonPos = json.indexOf(':', keyStart);
        if (colonPos < 0) return false;

        // Look for true/false after colon
        String remainder = json.substring(colonPos + 1).trim();
        return remainder.startsWith("true");
    }

    private static class ChunkOrError {
        final Chunk chunk;
        final DurableStreamException error;

        ChunkOrError(Chunk chunk) {
            this.chunk = chunk;
            this.error = null;
        }

        ChunkOrError(DurableStreamException error) {
            this.chunk = null;
            this.error = error;
        }
    }
}
