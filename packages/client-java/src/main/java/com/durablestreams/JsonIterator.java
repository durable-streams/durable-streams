package com.durablestreams;

import com.durablestreams.exception.DurableStreamException;
import com.durablestreams.model.Chunk;
import com.durablestreams.model.JsonBatch;
import com.durablestreams.model.Offset;

import java.time.Duration;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.function.Function;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;

/**
 * Type-safe iterator for JSON streams.
 *
 * <p>Wraps a {@link ChunkIterator} and parses each chunk into typed objects
 * using a user-provided parser function. This keeps the library zero-dependency
 * while enabling type-safe iteration.
 *
 * <p>Usage with Gson:
 * <pre>{@code
 * Gson gson = new Gson();
 * Type listType = new TypeToken<List<Event>>(){}.getType();
 *
 * try (var iter = stream.readJson(json -> gson.fromJson(json, listType))) {
 *     for (Event event : iter.items()) {
 *         process(event);
 *     }
 * }
 * }</pre>
 *
 * <p>Usage with Jackson:
 * <pre>{@code
 * ObjectMapper mapper = new ObjectMapper();
 *
 * try (var iter = stream.readJson(json -> mapper.readValue(json,
 *         mapper.getTypeFactory().constructCollectionType(List.class, Event.class)))) {
 *     for (var batch : iter) {
 *         for (Event event : batch) {
 *             process(event);
 *         }
 *     }
 * }
 * }</pre>
 *
 * @param <T> The type of items in the JSON stream
 */
public final class JsonIterator<T> implements Iterator<JsonBatch<T>>, Iterable<JsonBatch<T>>, AutoCloseable {

    private final ChunkIterator chunkIterator;
    private final Function<String, List<T>> parser;

    private JsonBatch<T> nextBatch;
    private boolean hasNextComputed;

    /**
     * Create a JsonIterator wrapping a ChunkIterator.
     *
     * @param chunkIterator The underlying chunk iterator
     * @param parser Function that parses a JSON string into a list of items.
     *               For single-object streams, return a single-element list.
     */
    public JsonIterator(ChunkIterator chunkIterator, Function<String, List<T>> parser) {
        this.chunkIterator = chunkIterator;
        this.parser = parser;
        this.hasNextComputed = false;
    }

    @Override
    public Iterator<JsonBatch<T>> iterator() {
        return this;
    }

    @Override
    public boolean hasNext() {
        if (hasNextComputed) {
            return nextBatch != null;
        }

        hasNextComputed = true;

        if (!chunkIterator.hasNext()) {
            nextBatch = null;
            return false;
        }

        Chunk chunk = chunkIterator.next();
        nextBatch = parseChunk(chunk);
        return true;
    }

    @Override
    public JsonBatch<T> next() {
        if (!hasNext()) {
            throw new NoSuchElementException();
        }

        hasNextComputed = false;
        JsonBatch<T> result = nextBatch;
        nextBatch = null;
        return result;
    }

    /**
     * Poll for the next batch with a timeout.
     *
     * @param timeout Maximum time to wait for data
     * @return The next batch, or null if no data available within timeout
     * @throws DurableStreamException if an error occurs while reading
     */
    public JsonBatch<T> poll(Duration timeout) throws DurableStreamException {
        Chunk chunk = chunkIterator.poll(timeout);
        if (chunk == null) {
            return null;
        }
        return parseChunk(chunk);
    }

    /**
     * Returns an iterator over individual items, flattening all batches.
     *
     * <p>Example:
     * <pre>{@code
     * for (Event event : jsonIterator.items()) {
     *     process(event);
     * }
     * }</pre>
     */
    public Iterable<T> items() {
        return () -> new FlattenedIterator<>(this);
    }

    /**
     * Returns a stream of individual items, flattening all batches.
     *
     * <p>Example:
     * <pre>{@code
     * jsonIterator.itemStream()
     *     .filter(e -> e.getType().equals("order"))
     *     .forEach(this::processOrder);
     * }</pre>
     */
    public Stream<T> itemStream() {
        return StreamSupport.stream(items().spliterator(), false);
    }

    /**
     * Returns a stream of batches.
     */
    public Stream<JsonBatch<T>> stream() {
        return StreamSupport.stream(this.spliterator(), false);
    }

    /**
     * Current offset position in the stream.
     */
    public Offset getCurrentOffset() {
        return chunkIterator.getCurrentOffset();
    }

    /**
     * Whether we've caught up to the stream tail.
     */
    public boolean isUpToDate() {
        return chunkIterator.isUpToDate();
    }

    @Override
    public void close() {
        chunkIterator.close();
    }

    private JsonBatch<T> parseChunk(Chunk chunk) {
        String json = chunk.getDataAsString();
        List<T> items;

        if (json == null || json.isEmpty()) {
            items = List.of();
        } else {
            try {
                items = parser.apply(json);
            } catch (Exception e) {
                throw new RuntimeException("Failed to parse JSON: " + e.getMessage(), e);
            }
        }

        return new JsonBatch<>(
            items,
            chunk.getNextOffset(),
            chunk.isUpToDate(),
            chunk.getCursor().orElse(null)
        );
    }

    /**
     * Iterator that flattens batches into individual items.
     */
    private static class FlattenedIterator<T> implements Iterator<T> {
        private final JsonIterator<T> jsonIterator;
        private Iterator<T> currentBatch;

        FlattenedIterator(JsonIterator<T> jsonIterator) {
            this.jsonIterator = jsonIterator;
            this.currentBatch = null;
        }

        @Override
        public boolean hasNext() {
            // Advance through empty batches
            while (currentBatch == null || !currentBatch.hasNext()) {
                if (!jsonIterator.hasNext()) {
                    return false;
                }
                currentBatch = jsonIterator.next().iterator();
            }
            return true;
        }

        @Override
        public T next() {
            if (!hasNext()) {
                throw new NoSuchElementException();
            }
            return currentBatch.next();
        }
    }
}
