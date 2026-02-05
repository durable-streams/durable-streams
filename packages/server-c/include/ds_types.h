/**
 * Durable Streams Server - Core Type Definitions
 *
 * High-performance C implementation of the Durable Streams protocol.
 */

#ifndef DS_TYPES_H
#define DS_TYPES_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <pthread.h>
#include <time.h>

/* Maximum sizes */
#define DS_MAX_PATH_LEN 4096
#define DS_MAX_CONTENT_TYPE_LEN 256
#define DS_MAX_OFFSET_LEN 64
#define DS_MAX_PRODUCER_ID_LEN 256
#define DS_MAX_HEADERS 64
#define DS_INITIAL_BUFFER_SIZE 4096
#define DS_OFFSET_FORMAT "%016lu_%016lu"

/* Producer state TTL (7 days in seconds) */
#define DS_PRODUCER_STATE_TTL_SEC (7 * 24 * 60 * 60)

/* Cursor interval for CDN collapsing (20 seconds) */
#define DS_CURSOR_INTERVAL_SEC 20

/* Long-poll default timeout (30 seconds) */
#define DS_LONGPOLL_TIMEOUT_SEC 30

/* SSE connection timeout (60 seconds) */
#define DS_SSE_TIMEOUT_SEC 60

/**
 * Dynamic buffer for variable-length data.
 */
typedef struct ds_buffer {
    uint8_t *data;
    size_t len;
    size_t capacity;
} ds_buffer_t;

/**
 * A single message in a stream.
 */
typedef struct ds_message {
    ds_buffer_t data;           /* Message payload */
    char offset[DS_MAX_OFFSET_LEN];  /* Offset after this message */
    uint64_t timestamp;         /* Unix timestamp (ms) when appended */
    struct ds_message *next;    /* Linked list pointer */
} ds_message_t;

/**
 * Producer state for idempotent writes.
 */
typedef struct ds_producer_state {
    char producer_id[DS_MAX_PRODUCER_ID_LEN];
    uint64_t epoch;
    uint64_t last_seq;
    uint64_t last_updated;      /* Unix timestamp (ms) */
    struct ds_producer_state *next;
} ds_producer_state_t;

/**
 * Producer that closed this stream (for idempotent close).
 */
typedef struct ds_closed_by {
    char producer_id[DS_MAX_PRODUCER_ID_LEN];
    uint64_t epoch;
    uint64_t seq;
} ds_closed_by_t;

/**
 * Stream metadata and data.
 */
typedef struct ds_stream {
    char path[DS_MAX_PATH_LEN];
    char content_type[DS_MAX_CONTENT_TYPE_LEN];
    ds_message_t *messages;     /* Linked list head */
    ds_message_t *messages_tail; /* Linked list tail for O(1) append */
    size_t message_count;
    char current_offset[DS_MAX_OFFSET_LEN];
    uint64_t read_seq;          /* Current read sequence */
    uint64_t byte_offset;       /* Current byte offset */
    char last_seq[DS_MAX_OFFSET_LEN]; /* Last Stream-Seq for writer coordination */
    int64_t ttl_seconds;        /* TTL in seconds (-1 = no TTL) */
    char expires_at[64];        /* ISO 8601 timestamp */
    uint64_t created_at;        /* Unix timestamp (ms) */
    bool closed;                /* Whether stream is closed */
    ds_closed_by_t *closed_by;  /* Producer that closed the stream */
    ds_producer_state_t *producers; /* Producer states for idempotent writes */
    pthread_mutex_t lock;       /* Per-stream lock */
    pthread_cond_t cond;        /* Condition variable for long-poll */
    struct ds_stream *next;     /* Hash table chain */
} ds_stream_t;

/**
 * Producer validation result status.
 */
typedef enum ds_producer_status {
    DS_PRODUCER_ACCEPTED,
    DS_PRODUCER_DUPLICATE,
    DS_PRODUCER_STALE_EPOCH,
    DS_PRODUCER_INVALID_EPOCH_SEQ,
    DS_PRODUCER_SEQUENCE_GAP,
    DS_PRODUCER_STREAM_CLOSED
} ds_producer_status_t;

/**
 * Producer validation result.
 */
typedef struct ds_producer_result {
    ds_producer_status_t status;
    uint64_t last_seq;          /* For duplicate detection */
    uint64_t current_epoch;     /* For stale epoch */
    uint64_t expected_seq;      /* For sequence gap */
    uint64_t received_seq;      /* For sequence gap */
} ds_producer_result_t;

/**
 * Append operation options.
 */
typedef struct ds_append_options {
    const char *seq;            /* Stream-Seq header */
    const char *content_type;   /* Content-Type header */
    const char *producer_id;    /* Producer-Id header */
    int64_t producer_epoch;     /* Producer-Epoch (-1 = not set) */
    int64_t producer_seq;       /* Producer-Seq (-1 = not set) */
    bool close;                 /* Close stream after append */
} ds_append_options_t;

/**
 * Append operation result.
 */
typedef struct ds_append_result {
    bool success;
    char offset[DS_MAX_OFFSET_LEN];
    ds_producer_result_t producer_result;
    bool stream_closed;
    char error[256];
} ds_append_result_t;

/**
 * Read operation result.
 */
typedef struct ds_read_result {
    ds_buffer_t data;
    char next_offset[DS_MAX_OFFSET_LEN];
    bool up_to_date;
    bool stream_closed;
} ds_read_result_t;

/**
 * Stream store (hash table of streams).
 */
typedef struct ds_store {
    ds_stream_t **buckets;
    size_t bucket_count;
    size_t stream_count;
    pthread_rwlock_t lock;      /* Store-level read-write lock */
} ds_store_t;

/**
 * Pending long-poll request.
 */
typedef struct ds_pending_poll {
    ds_stream_t *stream;
    char offset[DS_MAX_OFFSET_LEN];
    pthread_cond_t *cond;
    bool notified;
    bool canceled;
    struct ds_pending_poll *next;
} ds_pending_poll_t;

/**
 * Server configuration.
 */
typedef struct ds_server_config {
    uint16_t port;
    const char *host;
    int long_poll_timeout_ms;
    int sse_timeout_sec;
    bool compression;
    int cursor_interval_sec;
    uint64_t cursor_epoch;      /* Unix timestamp for cursor calculation */
} ds_server_config_t;

/* Initialize default config */
static inline void ds_config_init(ds_server_config_t *config) {
    config->port = 4437;
    config->host = "127.0.0.1";
    config->long_poll_timeout_ms = DS_LONGPOLL_TIMEOUT_SEC * 1000;
    config->sse_timeout_sec = DS_SSE_TIMEOUT_SEC;
    config->compression = true;
    config->cursor_interval_sec = DS_CURSOR_INTERVAL_SEC;
    /* October 9, 2024 00:00:00 UTC */
    config->cursor_epoch = 1728432000ULL;
}

#endif /* DS_TYPES_H */
