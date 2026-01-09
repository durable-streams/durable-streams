package com.durablestreams.model;

import java.util.Objects;

/**
 * Opaque offset token identifying a position within a stream.
 *
 * <p><b>Comparison scope</b>: Offsets are only comparable within the SAME stream.
 * Comparing offsets from different streams is undefined behavior.
 *
 * <p><b>Sentinel values</b>: {@link #BEGINNING} (-1) and {@link #NOW} are protocol-defined
 * special values. All other offsets are opaque server-issued tokens.
 */
public final class Offset implements Comparable<Offset> {
    /** Start of stream. Equivalent to omitting offset parameter. */
    public static final Offset BEGINNING = new Offset("-1");

    /** Current tail position. Skips existing data, reads only future appends. */
    public static final Offset NOW = new Offset("now");

    private final String value;

    public Offset(String value) {
        this.value = Objects.requireNonNull(value, "offset value cannot be null");
    }

    public static Offset of(String value) {
        if ("-1".equals(value)) return BEGINNING;
        if ("now".equals(value)) return NOW;
        return new Offset(value);
    }

    public String getValue() {
        return value;
    }

    /**
     * Lexicographic comparison. Valid ONLY for offsets from the same stream.
     */
    @Override
    public int compareTo(Offset other) {
        return this.value.compareTo(other.value);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Offset)) return false;
        return value.equals(((Offset) o).value);
    }

    @Override
    public int hashCode() {
        return value.hashCode();
    }

    @Override
    public String toString() {
        return value;
    }
}
