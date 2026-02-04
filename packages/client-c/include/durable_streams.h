/**
 * Durable Streams C Client Library
 *
 * A pure C client for the Durable Streams protocol using libcurl.
 */

#ifndef DURABLE_STREAMS_H
#define DURABLE_STREAMS_H

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Version info */
#define DS_VERSION "0.1.0"
#define DS_CLIENT_NAME "durable-streams-c"

/* Error codes */
typedef enum {
    DS_OK = 0,
    DS_ERR_INVALID_ARGUMENT = -1,
    DS_ERR_OUT_OF_MEMORY = -2,
    DS_ERR_NETWORK = -3,
    DS_ERR_HTTP = -4,
    DS_ERR_NOT_FOUND = -5,
    DS_ERR_CONFLICT = -6,
    DS_ERR_STREAM_CLOSED = -7,
    DS_ERR_INVALID_OFFSET = -8,
    DS_ERR_PARSE_ERROR = -9,
    DS_ERR_TIMEOUT = -10,
    DS_ERR_STALE_EPOCH = -11,
    DS_ERR_SEQUENCE_GAP = -12,
    DS_ERR_DONE = -13,
    DS_ERR_INTERNAL = -99
} ds_error_t;

/* Live mode for reading */
typedef enum {
    DS_LIVE_NONE = 0,
    DS_LIVE_LONG_POLL = 1,
    DS_LIVE_SSE = 2
} ds_live_mode_t;

/* Forward declarations */
typedef struct ds_client ds_client_t;
typedef struct ds_stream ds_stream_t;
typedef struct ds_iterator ds_iterator_t;
typedef struct ds_producer ds_producer_t;

/* Response/result structures */
typedef struct {
    int status_code;
    char *next_offset;
    char *content_type;
    bool up_to_date;
    bool stream_closed;
    char *cursor;
    char *error_message;
    ds_error_t error_code;
    /* For idempotent producer */
    int expected_seq;
    int received_seq;
    int current_epoch;
} ds_result_t;

typedef struct {
    char *data;
    size_t data_len;
    bool is_binary;
    char *offset;
    int status_code;
    bool up_to_date;
    bool stream_closed;
    char *cursor;
} ds_chunk_t;

typedef struct {
    char *final_offset;
    bool stream_closed;
} ds_close_result_t;

/* Client configuration */
typedef struct {
    const char *base_url;
    long timeout_ms;
    bool verbose;
} ds_client_config_t;

/* Stream options */
typedef struct {
    const char *content_type;
    int ttl_seconds;
    const char *expires_at;
    bool closed;
    const char *initial_data;
    size_t initial_data_len;
    /* Custom headers: NULL-terminated array of "key: value" strings */
    const char **headers;
} ds_create_options_t;

typedef struct {
    const char *seq;
    const char **headers;
} ds_append_options_t;

typedef struct {
    const char *offset;
    ds_live_mode_t live;
    long timeout_ms;
    const char **headers;
    int max_chunks;
} ds_read_options_t;

typedef struct {
    const char *data;
    size_t data_len;
    const char *content_type;
} ds_close_options_t;

/* Idempotent producer configuration */
typedef struct {
    int epoch;
    bool auto_claim;
    int max_in_flight;
    int linger_ms;
    int max_batch_bytes;
    const char *content_type;
} ds_producer_config_t;

/* ========== Client API ========== */

/**
 * Create a new client instance.
 */
ds_client_t *ds_client_new(const ds_client_config_t *config);

/**
 * Free a client instance and all associated resources.
 */
void ds_client_free(ds_client_t *client);

/**
 * Get the base URL of the client.
 */
const char *ds_client_base_url(const ds_client_t *client);

/* ========== Stream API ========== */

/**
 * Create a stream handle for a given path.
 * The path should be relative to the client's base URL.
 */
ds_stream_t *ds_stream_new(ds_client_t *client, const char *path);

/**
 * Free a stream handle.
 */
void ds_stream_free(ds_stream_t *stream);

/**
 * Set the content type for this stream (used for appends).
 */
void ds_stream_set_content_type(ds_stream_t *stream, const char *content_type);

/**
 * Get the content type of this stream.
 */
const char *ds_stream_get_content_type(const ds_stream_t *stream);

/**
 * Create a new stream (PUT request).
 */
ds_error_t ds_stream_create(ds_stream_t *stream, const ds_create_options_t *options, ds_result_t *result);

/**
 * Append data to a stream (POST request).
 */
ds_error_t ds_stream_append(ds_stream_t *stream, const char *data, size_t data_len,
                            const ds_append_options_t *options, ds_result_t *result);

/**
 * Close a stream (POST with Stream-Closed: true).
 */
ds_error_t ds_stream_close(ds_stream_t *stream, const ds_close_options_t *options, ds_close_result_t *result);

/**
 * Get stream metadata (HEAD request).
 */
ds_error_t ds_stream_head(ds_stream_t *stream, const char **headers, ds_result_t *result);

/**
 * Delete a stream (DELETE request).
 */
ds_error_t ds_stream_delete(ds_stream_t *stream, const char **headers, ds_result_t *result);

/* ========== Iterator API (for reading) ========== */

/**
 * Create a read iterator for a stream.
 */
ds_iterator_t *ds_stream_read(ds_stream_t *stream, const ds_read_options_t *options);

/**
 * Get the next chunk from an iterator.
 * Returns DS_OK on success, DS_ERR_DONE when no more data, or another error code.
 */
ds_error_t ds_iterator_next(ds_iterator_t *iter, ds_chunk_t *chunk);

/**
 * Get the current offset of the iterator.
 */
const char *ds_iterator_offset(const ds_iterator_t *iter);

/**
 * Check if the iterator has reached the end of currently available data.
 */
bool ds_iterator_up_to_date(const ds_iterator_t *iter);

/**
 * Check if the stream is closed.
 */
bool ds_iterator_stream_closed(const ds_iterator_t *iter);

/**
 * Close and free an iterator.
 */
void ds_iterator_free(ds_iterator_t *iter);

/* ========== Idempotent Producer API ========== */

/**
 * Create a new idempotent producer.
 */
ds_producer_t *ds_producer_new(ds_client_t *client, const char *url, const char *producer_id,
                               const ds_producer_config_t *config);

/**
 * Append data through the idempotent producer.
 * This queues the data for batching.
 */
ds_error_t ds_producer_append(ds_producer_t *producer, const char *data, size_t data_len);

/**
 * Flush all queued data and wait for acknowledgment.
 */
ds_error_t ds_producer_flush(ds_producer_t *producer, long timeout_ms);

/**
 * Close the stream via the producer.
 */
ds_error_t ds_producer_close_stream(ds_producer_t *producer, const char *final_data, size_t data_len,
                                    ds_close_result_t *result, long timeout_ms);

/**
 * Get the current epoch of the producer.
 */
int ds_producer_epoch(const ds_producer_t *producer);

/**
 * Get the last error from the producer.
 */
ds_error_t ds_producer_last_error(const ds_producer_t *producer);

/**
 * Get the last error message from the producer.
 */
const char *ds_producer_last_error_message(const ds_producer_t *producer);

/**
 * Free a producer.
 */
void ds_producer_free(ds_producer_t *producer);

/* ========== Result/Chunk Cleanup ========== */

/**
 * Free resources allocated in a result structure.
 */
void ds_result_cleanup(ds_result_t *result);

/**
 * Free resources allocated in a chunk structure.
 */
void ds_chunk_cleanup(ds_chunk_t *chunk);

/**
 * Free resources allocated in a close result structure.
 */
void ds_close_result_cleanup(ds_close_result_t *result);

/* ========== Utility Functions ========== */

/**
 * Get a human-readable error message for an error code.
 */
const char *ds_error_string(ds_error_t error);

/**
 * URL-encode a string. Returns a newly allocated string that must be freed.
 */
char *ds_url_encode(const char *str);

#ifdef __cplusplus
}
#endif

#endif /* DURABLE_STREAMS_H */
