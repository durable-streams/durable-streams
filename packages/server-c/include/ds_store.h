/**
 * Durable Streams Server - Stream Store
 *
 * Thread-safe in-memory storage for durable streams.
 */

#ifndef DS_STORE_H
#define DS_STORE_H

#include "ds_types.h"
#include "ds_buffer.h"

/* Default hash table size */
#define DS_STORE_DEFAULT_BUCKETS 256

/**
 * Create a new stream store.
 * Returns NULL on allocation failure.
 */
ds_store_t *ds_store_create(size_t bucket_count);

/**
 * Destroy a stream store and free all resources.
 */
void ds_store_destroy(ds_store_t *store);

/**
 * Create a new stream.
 * Returns the stream on success (may be existing if idempotent).
 * Returns NULL and sets *error on failure.
 */
ds_stream_t *ds_store_create_stream(
    ds_store_t *store,
    const char *path,
    const char *content_type,
    int64_t ttl_seconds,
    const char *expires_at,
    const uint8_t *initial_data,
    size_t initial_data_len,
    bool closed,
    char *error,
    size_t error_len
);

/**
 * Get a stream by path.
 * Returns NULL if not found or expired.
 * Note: Caller must hold store read lock or call this under store lock.
 */
ds_stream_t *ds_store_get(ds_store_t *store, const char *path);

/**
 * Check if a stream exists.
 */
bool ds_store_has(ds_store_t *store, const char *path);

/**
 * Delete a stream.
 * Returns true if deleted, false if not found.
 */
bool ds_store_delete(ds_store_t *store, const char *path);

/**
 * Append data to a stream.
 * Thread-safe, handles producer validation and JSON processing.
 */
ds_append_result_t ds_store_append(
    ds_store_t *store,
    const char *path,
    const uint8_t *data,
    size_t data_len,
    const ds_append_options_t *options
);

/**
 * Read messages from a stream starting at the given offset.
 * Returns formatted response data (JSON array for JSON mode).
 */
ds_read_result_t ds_store_read(
    ds_store_t *store,
    const char *path,
    const char *offset
);

/**
 * Close a stream without appending data.
 * Returns true if closed, false if not found.
 */
bool ds_store_close_stream(
    ds_store_t *store,
    const char *path,
    char *final_offset,
    bool *already_closed
);

/**
 * Close a stream with producer headers (idempotent).
 */
bool ds_store_close_stream_with_producer(
    ds_store_t *store,
    const char *path,
    const char *producer_id,
    uint64_t epoch,
    uint64_t seq,
    char *final_offset,
    bool *already_closed,
    ds_producer_result_t *result
);

/**
 * Wait for new messages (long-poll).
 * Returns true if new data arrived, false on timeout.
 * Blocks until data is available or timeout.
 */
bool ds_store_wait_for_messages(
    ds_store_t *store,
    const char *path,
    const char *offset,
    int timeout_ms,
    ds_read_result_t *result
);

/**
 * Clear all streams from the store.
 */
void ds_store_clear(ds_store_t *store);

/**
 * Get current time in milliseconds.
 */
uint64_t ds_time_now_ms(void);

/**
 * Generate a cursor value for CDN collapsing.
 */
uint64_t ds_generate_cursor(uint64_t cursor_epoch, int interval_sec, uint64_t client_cursor);

/**
 * Format offset string.
 */
void ds_format_offset(char *buf, size_t buf_len, uint64_t read_seq, uint64_t byte_offset);

/**
 * Parse offset string.
 * Returns true on success.
 */
bool ds_parse_offset(const char *offset, uint64_t *read_seq, uint64_t *byte_offset);

#endif /* DS_STORE_H */
