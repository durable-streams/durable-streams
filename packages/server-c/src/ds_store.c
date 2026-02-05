/**
 * Durable Streams Server - Stream Store Implementation
 *
 * Thread-safe in-memory storage with JSON support.
 */

#include "ds_store.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <sys/time.h>

/* Simple hash function (djb2) */
static uint64_t hash_string(const char *str) {
    uint64_t hash = 5381;
    int c;
    while ((c = (unsigned char)*str++)) {
        hash = ((hash << 5) + hash) + c;
    }
    return hash;
}

/* Get current time in milliseconds */
uint64_t ds_time_now_ms(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

/* Format offset string */
void ds_format_offset(char *buf, size_t buf_len, uint64_t read_seq, uint64_t byte_offset) {
    snprintf(buf, buf_len, "%016lu_%016lu", read_seq, byte_offset);
}

/* Parse offset string */
bool ds_parse_offset(const char *offset, uint64_t *read_seq, uint64_t *byte_offset) {
    if (!offset || strlen(offset) != 33) {
        return false;
    }
    if (offset[16] != '_') {
        return false;
    }
    char *end;
    *read_seq = strtoull(offset, &end, 10);
    if (*end != '_') {
        return false;
    }
    *byte_offset = strtoull(offset + 17, &end, 10);
    return *end == '\0';
}

/* Normalize content type (extract media type before semicolon) */
static void normalize_content_type(const char *ct, char *out, size_t out_len) {
    if (!ct || !*ct) {
        out[0] = '\0';
        return;
    }

    const char *semi = strchr(ct, ';');
    size_t len = semi ? (size_t)(semi - ct) : strlen(ct);

    /* Trim whitespace */
    while (len > 0 && isspace((unsigned char)ct[len - 1])) {
        len--;
    }
    while (len > 0 && isspace((unsigned char)*ct)) {
        ct++;
        len--;
    }

    if (len >= out_len) {
        len = out_len - 1;
    }

    for (size_t i = 0; i < len; i++) {
        out[i] = (char)tolower((unsigned char)ct[i]);
    }
    out[len] = '\0';
}

/* Check if content type is JSON */
static bool is_json_content_type(const char *ct) {
    char normalized[DS_MAX_CONTENT_TYPE_LEN];
    normalize_content_type(ct, normalized, sizeof(normalized));
    return strcmp(normalized, "application/json") == 0;
}

/* Create a new message */
static ds_message_t *create_message(const uint8_t *data, size_t len, const char *offset) {
    ds_message_t *msg = (ds_message_t *)calloc(1, sizeof(ds_message_t));
    if (!msg) {
        return NULL;
    }

    ds_buffer_init(&msg->data);
    if (len > 0 && ds_buffer_set(&msg->data, data, len) != 0) {
        free(msg);
        return NULL;
    }

    strncpy(msg->offset, offset, sizeof(msg->offset) - 1);
    msg->timestamp = ds_time_now_ms();
    msg->next = NULL;

    return msg;
}

/* Free a message */
static void free_message(ds_message_t *msg) {
    if (msg) {
        ds_buffer_free(&msg->data);
        free(msg);
    }
}

/* Free message list */
static void free_message_list(ds_message_t *head) {
    while (head) {
        ds_message_t *next = head->next;
        free_message(head);
        head = next;
    }
}

/* Create a new stream */
static ds_stream_t *create_stream(const char *path, const char *content_type) {
    ds_stream_t *stream = (ds_stream_t *)calloc(1, sizeof(ds_stream_t));
    if (!stream) {
        return NULL;
    }

    strncpy(stream->path, path, sizeof(stream->path) - 1);
    if (content_type) {
        strncpy(stream->content_type, content_type, sizeof(stream->content_type) - 1);
    } else {
        strcpy(stream->content_type, "application/octet-stream");
    }

    stream->messages = NULL;
    stream->messages_tail = NULL;
    stream->message_count = 0;
    stream->read_seq = 0;
    stream->byte_offset = 0;
    ds_format_offset(stream->current_offset, sizeof(stream->current_offset), 0, 0);
    stream->last_seq[0] = '\0';
    stream->ttl_seconds = -1;
    stream->expires_at[0] = '\0';
    stream->created_at = ds_time_now_ms();
    stream->closed = false;
    stream->closed_by = NULL;
    stream->producers = NULL;
    stream->next = NULL;

    pthread_mutex_init(&stream->lock, NULL);
    pthread_cond_init(&stream->cond, NULL);

    return stream;
}

/* Free a stream */
static void free_stream(ds_stream_t *stream) {
    if (!stream) {
        return;
    }

    free_message_list(stream->messages);

    /* Free producer states */
    ds_producer_state_t *prod = stream->producers;
    while (prod) {
        ds_producer_state_t *next = prod->next;
        free(prod);
        prod = next;
    }

    if (stream->closed_by) {
        free(stream->closed_by);
    }

    pthread_mutex_destroy(&stream->lock);
    pthread_cond_destroy(&stream->cond);

    free(stream);
}

/* Check if stream is expired */
static bool is_stream_expired(ds_stream_t *stream) {
    uint64_t now = ds_time_now_ms();

    /* Check TTL */
    if (stream->ttl_seconds >= 0) {
        uint64_t expiry = stream->created_at + (uint64_t)stream->ttl_seconds * 1000;
        if (now >= expiry) {
            return true;
        }
    }

    /* Check expires_at (ISO 8601 parsing simplified) */
    if (stream->expires_at[0]) {
        struct tm tm;
        memset(&tm, 0, sizeof(tm));
        if (strptime(stream->expires_at, "%Y-%m-%dT%H:%M:%S", &tm)) {
            time_t expiry = timegm(&tm);
            if (expiry != -1 && now >= (uint64_t)expiry * 1000) {
                return true;
            }
        }
    }

    return false;
}

/* Find producer state */
static ds_producer_state_t *find_producer(ds_stream_t *stream, const char *producer_id) {
    ds_producer_state_t *prod = stream->producers;
    while (prod) {
        if (strcmp(prod->producer_id, producer_id) == 0) {
            return prod;
        }
        prod = prod->next;
    }
    return NULL;
}

/* Create or update producer state */
static ds_producer_state_t *upsert_producer(ds_stream_t *stream, const char *producer_id,
                                             uint64_t epoch, uint64_t seq) {
    ds_producer_state_t *prod = find_producer(stream, producer_id);
    if (prod) {
        prod->epoch = epoch;
        prod->last_seq = seq;
        prod->last_updated = ds_time_now_ms();
        return prod;
    }

    prod = (ds_producer_state_t *)calloc(1, sizeof(ds_producer_state_t));
    if (!prod) {
        return NULL;
    }

    strncpy(prod->producer_id, producer_id, sizeof(prod->producer_id) - 1);
    prod->epoch = epoch;
    prod->last_seq = seq;
    prod->last_updated = ds_time_now_ms();
    prod->next = stream->producers;
    stream->producers = prod;

    return prod;
}

/* Validate producer (does NOT mutate state) */
static ds_producer_result_t validate_producer(ds_stream_t *stream, const char *producer_id,
                                               uint64_t epoch, uint64_t seq) {
    ds_producer_result_t result = {0};

    ds_producer_state_t *state = find_producer(stream, producer_id);

    if (!state) {
        /* New producer - must start at seq=0 */
        if (seq != 0) {
            result.status = DS_PRODUCER_SEQUENCE_GAP;
            result.expected_seq = 0;
            result.received_seq = seq;
            return result;
        }
        result.status = DS_PRODUCER_ACCEPTED;
        return result;
    }

    /* Epoch validation */
    if (epoch < state->epoch) {
        result.status = DS_PRODUCER_STALE_EPOCH;
        result.current_epoch = state->epoch;
        return result;
    }

    if (epoch > state->epoch) {
        /* New epoch must start at seq=0 */
        if (seq != 0) {
            result.status = DS_PRODUCER_INVALID_EPOCH_SEQ;
            return result;
        }
        result.status = DS_PRODUCER_ACCEPTED;
        return result;
    }

    /* Same epoch: sequence validation */
    if (seq <= state->last_seq) {
        result.status = DS_PRODUCER_DUPLICATE;
        result.last_seq = state->last_seq;
        return result;
    }

    if (seq == state->last_seq + 1) {
        result.status = DS_PRODUCER_ACCEPTED;
        return result;
    }

    /* Sequence gap */
    result.status = DS_PRODUCER_SEQUENCE_GAP;
    result.expected_seq = state->last_seq + 1;
    result.received_seq = seq;
    return result;
}

/* Simple JSON validation - returns true if valid */
static bool is_valid_json(const char *data, size_t len) __attribute__((unused));
static bool is_valid_json(const char *data, size_t len) {
    if (len == 0) {
        return false;
    }

    /* Skip whitespace */
    size_t i = 0;
    while (i < len && isspace((unsigned char)data[i])) {
        i++;
    }

    if (i >= len) {
        return false;
    }

    /* Must start with { or [ or " or digit or true/false/null */
    char c = data[i];
    return c == '{' || c == '[' || c == '"' || c == '-' ||
           (c >= '0' && c <= '9') || c == 't' || c == 'f' || c == 'n';
}

/* Process JSON for append - handles array flattening */
static int process_json_append(const uint8_t *data, size_t len, bool is_initial,
                               ds_buffer_t *out) {
    /* Parse to check validity (simplified - full parser would be better) */
    if (len == 0) {
        return is_initial ? 0 : -1;
    }

    /* Find first non-whitespace */
    size_t start = 0;
    while (start < len && isspace((unsigned char)data[start])) {
        start++;
    }

    if (start >= len) {
        return is_initial ? 0 : -1;
    }

    /* Check if it's an array */
    if (data[start] == '[') {
        /* Find matching ] */
        size_t depth = 1;
        size_t i = start + 1;
        bool in_string = false;
        bool escaped = false;

        while (i < len && depth > 0) {
            char c = (char)data[i];
            if (escaped) {
                escaped = false;
            } else if (c == '\\' && in_string) {
                escaped = true;
            } else if (c == '"') {
                in_string = !in_string;
            } else if (!in_string) {
                if (c == '[') {
                    depth++;
                } else if (c == ']') {
                    depth--;
                }
            }
            i++;
        }

        if (depth != 0) {
            return -1; /* Invalid JSON */
        }

        /* Extract array contents */
        size_t array_start = start + 1;
        size_t array_end = i - 1;

        /* Skip whitespace inside array */
        while (array_start < array_end && isspace((unsigned char)data[array_start])) {
            array_start++;
        }
        while (array_end > array_start && isspace((unsigned char)data[array_end - 1])) {
            array_end--;
        }

        /* Check for empty array */
        if (array_start >= array_end) {
            if (is_initial) {
                ds_buffer_clear(out);
                return 0; /* Empty stream */
            }
            return -1; /* Empty arrays not allowed for append */
        }

        /* Copy array contents and add trailing comma */
        if (ds_buffer_set(out, data + array_start, array_end - array_start) != 0) {
            return -1;
        }
        if (ds_buffer_append_byte(out, ',') != 0) {
            return -1;
        }
    } else {
        /* Single value - just copy and add comma */
        /* Find end of value (skip trailing whitespace) */
        size_t end = len;
        while (end > start && isspace((unsigned char)data[end - 1])) {
            end--;
        }

        if (ds_buffer_set(out, data + start, end - start) != 0) {
            return -1;
        }
        if (ds_buffer_append_byte(out, ',') != 0) {
            return -1;
        }
    }

    return 0;
}

/* Format JSON response - wrap in array brackets */
static int format_json_response(const ds_buffer_t *data, ds_buffer_t *out) {
    ds_buffer_clear(out);

    if (data->len == 0) {
        return ds_buffer_append_str(out, "[]");
    }

    /* Remove trailing comma if present */
    size_t len = data->len;
    while (len > 0 && (data->data[len - 1] == ',' || isspace((unsigned char)data->data[len - 1]))) {
        len--;
    }

    if (ds_buffer_append_byte(out, '[') != 0) {
        return -1;
    }
    if (ds_buffer_append(out, data->data, len) != 0) {
        return -1;
    }
    if (ds_buffer_append_byte(out, ']') != 0) {
        return -1;
    }

    return 0;
}

/* Append message to stream (internal, assumes lock held) */
static ds_message_t *append_to_stream(ds_stream_t *stream, const uint8_t *data, size_t len,
                                       bool is_initial) {
    ds_buffer_t processed;
    ds_buffer_init(&processed);

    const uint8_t *final_data = data;
    size_t final_len = len;

    /* Process JSON mode */
    if (is_json_content_type(stream->content_type)) {
        if (process_json_append(data, len, is_initial, &processed) != 0) {
            ds_buffer_free(&processed);
            return NULL;
        }
        if (processed.len == 0) {
            ds_buffer_free(&processed);
            return (ds_message_t *)-1; /* Empty stream created */
        }
        final_data = processed.data;
        final_len = processed.len;
    }

    /* Calculate new offset */
    uint64_t new_byte_offset = stream->byte_offset + final_len;
    char new_offset[DS_MAX_OFFSET_LEN];
    ds_format_offset(new_offset, sizeof(new_offset), stream->read_seq, new_byte_offset);

    /* Create message */
    ds_message_t *msg = create_message(final_data, final_len, new_offset);
    ds_buffer_free(&processed);

    if (!msg) {
        return NULL;
    }

    /* Append to list */
    if (stream->messages_tail) {
        stream->messages_tail->next = msg;
    } else {
        stream->messages = msg;
    }
    stream->messages_tail = msg;
    stream->message_count++;

    /* Update stream offset */
    stream->byte_offset = new_byte_offset;
    strncpy(stream->current_offset, new_offset, sizeof(stream->current_offset) - 1);

    return msg;
}

/* ============================================================================
 * Public API
 * ============================================================================ */

ds_store_t *ds_store_create(size_t bucket_count) {
    if (bucket_count == 0) {
        bucket_count = DS_STORE_DEFAULT_BUCKETS;
    }

    ds_store_t *store = (ds_store_t *)calloc(1, sizeof(ds_store_t));
    if (!store) {
        return NULL;
    }

    store->buckets = (ds_stream_t **)calloc(bucket_count, sizeof(ds_stream_t *));
    if (!store->buckets) {
        free(store);
        return NULL;
    }

    store->bucket_count = bucket_count;
    store->stream_count = 0;
    pthread_rwlock_init(&store->lock, NULL);

    return store;
}

void ds_store_destroy(ds_store_t *store) {
    if (!store) {
        return;
    }

    pthread_rwlock_wrlock(&store->lock);

    for (size_t i = 0; i < store->bucket_count; i++) {
        ds_stream_t *stream = store->buckets[i];
        while (stream) {
            ds_stream_t *next = stream->next;
            free_stream(stream);
            stream = next;
        }
    }

    free(store->buckets);
    pthread_rwlock_unlock(&store->lock);
    pthread_rwlock_destroy(&store->lock);
    free(store);
}

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
) {
    pthread_rwlock_wrlock(&store->lock);

    /* Check if stream exists */
    uint64_t hash = hash_string(path);
    size_t bucket = hash % store->bucket_count;
    ds_stream_t *existing = store->buckets[bucket];

    while (existing) {
        if (strcmp(existing->path, path) == 0) {
            /* Check if expired */
            if (is_stream_expired(existing)) {
                /* Remove expired stream - treat as not existing */
                ds_stream_t *prev = NULL;
                ds_stream_t *curr = store->buckets[bucket];
                while (curr && curr != existing) {
                    prev = curr;
                    curr = curr->next;
                }
                if (prev) {
                    prev->next = existing->next;
                } else {
                    store->buckets[bucket] = existing->next;
                }
                free_stream(existing);
                store->stream_count--;
                existing = NULL;
                break;
            }

            /* Check config match for idempotent create */
            char norm_ct[DS_MAX_CONTENT_TYPE_LEN];
            char norm_existing[DS_MAX_CONTENT_TYPE_LEN];
            normalize_content_type(content_type ? content_type : "application/octet-stream",
                                   norm_ct, sizeof(norm_ct));
            normalize_content_type(existing->content_type, norm_existing, sizeof(norm_existing));

            bool ct_match = strcmp(norm_ct, norm_existing) == 0;
            bool ttl_match = ttl_seconds == existing->ttl_seconds;
            bool expires_match = (!expires_at && !existing->expires_at[0]) ||
                                 (expires_at && strcmp(expires_at, existing->expires_at) == 0);
            bool closed_match = closed == existing->closed;

            if (ct_match && ttl_match && expires_match && closed_match) {
                pthread_rwlock_unlock(&store->lock);
                return existing; /* Idempotent success */
            }

            snprintf(error, error_len, "Stream already exists with different configuration");
            pthread_rwlock_unlock(&store->lock);
            return NULL;
        }
        existing = existing->next;
    }

    /* Create new stream */
    ds_stream_t *stream = create_stream(path, content_type);
    if (!stream) {
        snprintf(error, error_len, "Memory allocation failed");
        pthread_rwlock_unlock(&store->lock);
        return NULL;
    }

    stream->ttl_seconds = ttl_seconds;
    if (expires_at) {
        strncpy(stream->expires_at, expires_at, sizeof(stream->expires_at) - 1);
    }
    stream->closed = closed;

    /* Append initial data if provided */
    if (initial_data && initial_data_len > 0) {
        pthread_mutex_lock(&stream->lock);
        ds_message_t *msg = append_to_stream(stream, initial_data, initial_data_len, true);
        pthread_mutex_unlock(&stream->lock);

        if (!msg) {
            snprintf(error, error_len, "Invalid JSON in initial data");
            free_stream(stream);
            pthread_rwlock_unlock(&store->lock);
            return NULL;
        }
    }

    /* Insert into hash table */
    stream->next = store->buckets[bucket];
    store->buckets[bucket] = stream;
    store->stream_count++;

    pthread_rwlock_unlock(&store->lock);
    return stream;
}

ds_stream_t *ds_store_get(ds_store_t *store, const char *path) {
    pthread_rwlock_rdlock(&store->lock);

    uint64_t hash = hash_string(path);
    size_t bucket = hash % store->bucket_count;
    ds_stream_t *stream = store->buckets[bucket];

    while (stream) {
        if (strcmp(stream->path, path) == 0) {
            if (is_stream_expired(stream)) {
                pthread_rwlock_unlock(&store->lock);
                /* Delete expired stream */
                ds_store_delete(store, path);
                return NULL;
            }
            pthread_rwlock_unlock(&store->lock);
            return stream;
        }
        stream = stream->next;
    }

    pthread_rwlock_unlock(&store->lock);
    return NULL;
}

bool ds_store_has(ds_store_t *store, const char *path) {
    return ds_store_get(store, path) != NULL;
}

bool ds_store_delete(ds_store_t *store, const char *path) {
    pthread_rwlock_wrlock(&store->lock);

    uint64_t hash = hash_string(path);
    size_t bucket = hash % store->bucket_count;
    ds_stream_t *stream = store->buckets[bucket];
    ds_stream_t *prev = NULL;

    while (stream) {
        if (strcmp(stream->path, path) == 0) {
            if (prev) {
                prev->next = stream->next;
            } else {
                store->buckets[bucket] = stream->next;
            }

            /* Wake up any waiting threads */
            pthread_mutex_lock(&stream->lock);
            pthread_cond_broadcast(&stream->cond);
            pthread_mutex_unlock(&stream->lock);

            free_stream(stream);
            store->stream_count--;
            pthread_rwlock_unlock(&store->lock);
            return true;
        }
        prev = stream;
        stream = stream->next;
    }

    pthread_rwlock_unlock(&store->lock);
    return false;
}

ds_append_result_t ds_store_append(
    ds_store_t *store,
    const char *path,
    const uint8_t *data,
    size_t data_len,
    const ds_append_options_t *options
) {
    ds_append_result_t result = {0};

    ds_stream_t *stream = ds_store_get(store, path);
    if (!stream) {
        snprintf(result.error, sizeof(result.error), "Stream not found");
        return result;
    }

    pthread_mutex_lock(&stream->lock);

    /* Check if stream is closed */
    if (stream->closed) {
        /* Check for idempotent duplicate */
        if (options->producer_id && stream->closed_by &&
            strcmp(stream->closed_by->producer_id, options->producer_id) == 0 &&
            stream->closed_by->epoch == (uint64_t)options->producer_epoch &&
            stream->closed_by->seq == (uint64_t)options->producer_seq) {
            result.success = false;
            result.stream_closed = true;
            result.producer_result.status = DS_PRODUCER_DUPLICATE;
            result.producer_result.last_seq = (uint64_t)options->producer_seq;
            strncpy(result.offset, stream->current_offset, sizeof(result.offset) - 1);
            pthread_mutex_unlock(&stream->lock);
            return result;
        }

        result.success = false;
        result.stream_closed = true;
        strncpy(result.offset, stream->current_offset, sizeof(result.offset) - 1);
        pthread_mutex_unlock(&stream->lock);
        return result;
    }

    /* Check content type */
    if (options->content_type) {
        char norm_opt[DS_MAX_CONTENT_TYPE_LEN];
        char norm_stream[DS_MAX_CONTENT_TYPE_LEN];
        normalize_content_type(options->content_type, norm_opt, sizeof(norm_opt));
        normalize_content_type(stream->content_type, norm_stream, sizeof(norm_stream));

        if (strcmp(norm_opt, norm_stream) != 0) {
            snprintf(result.error, sizeof(result.error), "Content-type mismatch");
            pthread_mutex_unlock(&stream->lock);
            return result;
        }
    }

    /* Validate producer if headers present */
    bool has_producer = options->producer_id &&
                        options->producer_epoch >= 0 &&
                        options->producer_seq >= 0;

    if (has_producer) {
        result.producer_result = validate_producer(stream, options->producer_id,
                                                    (uint64_t)options->producer_epoch,
                                                    (uint64_t)options->producer_seq);

        if (result.producer_result.status != DS_PRODUCER_ACCEPTED) {
            strncpy(result.offset, stream->current_offset, sizeof(result.offset) - 1);
            pthread_mutex_unlock(&stream->lock);
            return result;
        }
    }

    /* Check Stream-Seq */
    if (options->seq && options->seq[0]) {
        if (stream->last_seq[0] && strcmp(options->seq, stream->last_seq) <= 0) {
            snprintf(result.error, sizeof(result.error), "Sequence conflict");
            pthread_mutex_unlock(&stream->lock);
            return result;
        }
    }

    /* Append data */
    ds_message_t *msg = append_to_stream(stream, data, data_len, false);
    if (!msg) {
        snprintf(result.error, sizeof(result.error), "Invalid JSON or empty array");
        pthread_mutex_unlock(&stream->lock);
        return result;
    }

    /* Commit producer state after successful append */
    if (has_producer) {
        upsert_producer(stream, options->producer_id,
                        (uint64_t)options->producer_epoch,
                        (uint64_t)options->producer_seq);
    }

    /* Update Stream-Seq */
    if (options->seq && options->seq[0]) {
        strncpy(stream->last_seq, options->seq, sizeof(stream->last_seq) - 1);
    }

    /* Close stream if requested */
    if (options->close) {
        stream->closed = true;
        if (options->producer_id) {
            stream->closed_by = (ds_closed_by_t *)calloc(1, sizeof(ds_closed_by_t));
            if (stream->closed_by) {
                strncpy(stream->closed_by->producer_id, options->producer_id,
                        sizeof(stream->closed_by->producer_id) - 1);
                stream->closed_by->epoch = (uint64_t)options->producer_epoch;
                stream->closed_by->seq = (uint64_t)options->producer_seq;
            }
        }
        result.stream_closed = true;
    }

    result.success = true;
    strncpy(result.offset, stream->current_offset, sizeof(result.offset) - 1);

    /* Wake up any waiting readers */
    pthread_cond_broadcast(&stream->cond);

    pthread_mutex_unlock(&stream->lock);
    return result;
}

ds_read_result_t ds_store_read(
    ds_store_t *store,
    const char *path,
    const char *offset
) {
    ds_read_result_t result = {0};
    ds_buffer_init(&result.data);

    ds_stream_t *stream = ds_store_get(store, path);
    if (!stream) {
        return result;
    }

    pthread_mutex_lock(&stream->lock);

    /* Collect messages after offset */
    ds_buffer_t raw_data;
    ds_buffer_init(&raw_data);

    ds_message_t *msg = stream->messages;
    while (msg) {
        /* If no offset or offset is "-1", include all messages */
        /* Otherwise, include messages with offset > given offset */
        bool include = !offset || !offset[0] || strcmp(offset, "-1") == 0 ||
                       strcmp(msg->offset, offset) > 0;

        if (include) {
            ds_buffer_append(&raw_data, msg->data.data, msg->data.len);
        }
        msg = msg->next;
    }

    /* Format response */
    if (is_json_content_type(stream->content_type)) {
        format_json_response(&raw_data, &result.data);
    } else {
        ds_buffer_copy(&result.data, &raw_data);
    }

    ds_buffer_free(&raw_data);

    /* Set result fields */
    strncpy(result.next_offset, stream->current_offset, sizeof(result.next_offset) - 1);
    result.up_to_date = true;
    result.stream_closed = stream->closed;

    pthread_mutex_unlock(&stream->lock);
    return result;
}

bool ds_store_close_stream(
    ds_store_t *store,
    const char *path,
    char *final_offset,
    bool *already_closed
) {
    ds_stream_t *stream = ds_store_get(store, path);
    if (!stream) {
        return false;
    }

    pthread_mutex_lock(&stream->lock);

    *already_closed = stream->closed;
    stream->closed = true;
    strncpy(final_offset, stream->current_offset, DS_MAX_OFFSET_LEN - 1);

    /* Wake up waiting readers */
    pthread_cond_broadcast(&stream->cond);

    pthread_mutex_unlock(&stream->lock);
    return true;
}

bool ds_store_close_stream_with_producer(
    ds_store_t *store,
    const char *path,
    const char *producer_id,
    uint64_t epoch,
    uint64_t seq,
    char *final_offset,
    bool *already_closed,
    ds_producer_result_t *result
) {
    ds_stream_t *stream = ds_store_get(store, path);
    if (!stream) {
        return false;
    }

    pthread_mutex_lock(&stream->lock);

    *already_closed = stream->closed;
    strncpy(final_offset, stream->current_offset, DS_MAX_OFFSET_LEN - 1);

    if (stream->closed) {
        /* Check for idempotent duplicate */
        if (stream->closed_by &&
            strcmp(stream->closed_by->producer_id, producer_id) == 0 &&
            stream->closed_by->epoch == epoch &&
            stream->closed_by->seq == seq) {
            result->status = DS_PRODUCER_DUPLICATE;
            result->last_seq = seq;
        } else {
            result->status = DS_PRODUCER_STREAM_CLOSED;
        }
        pthread_mutex_unlock(&stream->lock);
        return true;
    }

    /* Validate producer */
    *result = validate_producer(stream, producer_id, epoch, seq);

    if (result->status != DS_PRODUCER_ACCEPTED) {
        pthread_mutex_unlock(&stream->lock);
        return true;
    }

    /* Commit producer state and close */
    upsert_producer(stream, producer_id, epoch, seq);
    stream->closed = true;
    stream->closed_by = (ds_closed_by_t *)calloc(1, sizeof(ds_closed_by_t));
    if (stream->closed_by) {
        strncpy(stream->closed_by->producer_id, producer_id,
                sizeof(stream->closed_by->producer_id) - 1);
        stream->closed_by->epoch = epoch;
        stream->closed_by->seq = seq;
    }

    /* Wake up waiting readers */
    pthread_cond_broadcast(&stream->cond);

    pthread_mutex_unlock(&stream->lock);
    return true;
}

bool ds_store_wait_for_messages(
    ds_store_t *store,
    const char *path,
    const char *offset,
    int timeout_ms,
    ds_read_result_t *result
) {
    ds_stream_t *stream = ds_store_get(store, path);
    if (!stream) {
        return false;
    }

    pthread_mutex_lock(&stream->lock);

    /* Check if there's already new data */
    ds_message_t *msg = stream->messages;
    bool has_new = false;
    while (msg) {
        if (!offset || !offset[0] || strcmp(offset, "-1") == 0 ||
            strcmp(msg->offset, offset) > 0) {
            has_new = true;
            break;
        }
        msg = msg->next;
    }

    /* If no new data and stream is closed, return immediately */
    if (!has_new && stream->closed) {
        strncpy(result->next_offset, stream->current_offset, sizeof(result->next_offset) - 1);
        result->up_to_date = true;
        result->stream_closed = true;
        pthread_mutex_unlock(&stream->lock);
        return true;
    }

    /* If no new data, wait */
    if (!has_new) {
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        ts.tv_sec += timeout_ms / 1000;
        ts.tv_nsec += (timeout_ms % 1000) * 1000000;
        if (ts.tv_nsec >= 1000000000) {
            ts.tv_sec++;
            ts.tv_nsec -= 1000000000;
        }

        int ret = pthread_cond_timedwait(&stream->cond, &stream->lock, &ts);
        if (ret == ETIMEDOUT) {
            strncpy(result->next_offset, stream->current_offset, sizeof(result->next_offset) - 1);
            result->up_to_date = true;
            result->stream_closed = stream->closed;
            pthread_mutex_unlock(&stream->lock);
            return false; /* Timeout */
        }
    }

    pthread_mutex_unlock(&stream->lock);

    /* Read the data */
    *result = ds_store_read(store, path, offset);
    return true;
}

void ds_store_clear(ds_store_t *store) {
    pthread_rwlock_wrlock(&store->lock);

    for (size_t i = 0; i < store->bucket_count; i++) {
        ds_stream_t *stream = store->buckets[i];
        while (stream) {
            ds_stream_t *next = stream->next;

            /* Wake up any waiting threads */
            pthread_mutex_lock(&stream->lock);
            pthread_cond_broadcast(&stream->cond);
            pthread_mutex_unlock(&stream->lock);

            free_stream(stream);
            stream = next;
        }
        store->buckets[i] = NULL;
    }

    store->stream_count = 0;
    pthread_rwlock_unlock(&store->lock);
}

uint64_t ds_generate_cursor(uint64_t cursor_epoch, int interval_sec, uint64_t client_cursor) {
    uint64_t now = ds_time_now_ms() / 1000;
    uint64_t current_interval = (now - cursor_epoch) / (uint64_t)interval_sec;

    if (client_cursor >= current_interval) {
        /* Add jitter to prevent cache loops */
        return client_cursor + 1 + (rand() % 3600);
    }

    return current_interval;
}
