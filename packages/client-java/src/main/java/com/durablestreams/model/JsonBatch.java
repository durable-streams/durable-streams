package com.durablestreams.model;

import java.util.Iterator;
import java.util.List;
import java.util.Optional;

/**
 * A batch of parsed JSON items from a single chunk.
 *
 * <p>In the Durable Streams protocol, JSON streams may contain arrays that get
 * flattened on the server. A single HTTP response (chunk) may contain multiple
 * JSON values. This class represents those parsed values with their metadata.
 *
 * @param <T> The type of items in the batch
 */
public final class JsonBatch<T> implements Iterable<T> {

    private final List<T> items;
    private final Offset nextOffset;
    private final boolean upToDate;
    private final String cursor;

    public JsonBatch(List<T> items, Offset nextOffset, boolean upToDate, String cursor) {
        // Defensive copy - List.copyOf creates an unmodifiable copy
        this.items = items != null ? List.copyOf(items) : List.of();
        this.nextOffset = nextOffset;
        this.upToDate = upToDate;
        this.cursor = cursor;
    }

    /**
     * The parsed JSON items from this chunk.
     */
    public List<T> getItems() {
        return items;
    }

    /**
     * Number of items in this batch.
     */
    public int size() {
        return items.size();
    }

    /**
     * Whether this batch is empty.
     */
    public boolean isEmpty() {
        return items.isEmpty();
    }

    /**
     * The offset to use for the next read.
     */
    public Offset getNextOffset() {
        return nextOffset;
    }

    /**
     * Whether the stream has caught up to the tail.
     */
    public boolean isUpToDate() {
        return upToDate;
    }

    /**
     * CDN cursor for collapsing, if present.
     */
    public Optional<String> getCursor() {
        return Optional.ofNullable(cursor);
    }

    @Override
    public Iterator<T> iterator() {
        return items.iterator();
    }

    @Override
    public String toString() {
        return "JsonBatch{" +
               "itemCount=" + items.size() +
               ", nextOffset=" + nextOffset +
               ", upToDate=" + upToDate +
               '}';
    }
}
