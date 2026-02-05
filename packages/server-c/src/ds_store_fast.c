/**
 * Durable Streams Server - Ultra-Fast Store Implementation
 *
 * Array-based message storage, optimized offset formatting, cached time.
 */

#include "ds_store.h"
#include "ds_fast.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <sys/time.h>

/* Use the fast time cache */
#define ds_time_now_ms() fast_time_ms()

/* Default bucket count for better distribution */
#define DS_STORE_FAST_BUCKETS 4096

/* Fast hash function (FNV-1a - better distribution) */
static inline uint64_t fast_hash(const char *str, size_t len) {
    uint64_t hash = 14695981039346656037ULL;
    for (size_t i = 0; i < len; i++) {
        hash ^= (uint64_t)(unsigned char)str[i];
        hash *= 1099511628211ULL;
    }
    return hash;
}

/* Format offset string - ultra fast version */
void ds_format_offset(char *buf, size_t buf_len, uint64_t read_seq, uint64_t byte_offset) {
    (void)buf_len;
    fast_u64_to_str(buf, read_seq);
    buf[16] = '_';
    fast_u64_to_str(buf + 17, byte_offset);
    buf[33] = '\0';
}

/* Parse offset string - optimized */
bool ds_parse_offset(const char *offset, uint64_t *read_seq, uint64_t *byte_offset) {
    if (UNLIKELY(!offset || offset[16] != '_')) {
        return false;
    }

    /* Fast manual parsing - avoid strtoull overhead */
    uint64_t rs = 0, bo = 0;
    for (int i = 0; i < 16; i++) {
        char c = offset[i];
        if (UNLIKELY(c < '0' || c > '9')) return false;
        rs = rs * 10 + (c - '0');
    }
    for (int i = 17; i < 33; i++) {
        char c = offset[i];
        if (UNLIKELY(c < '0' || c > '9')) return false;
        bo = bo * 10 + (c - '0');
    }

    *read_seq = rs;
    *byte_offset = bo;
    return offset[33] == '\0';
}

/* Fast content type normalization (inline, no allocation) */
static inline void fast_normalize_ct(const char *ct, char *out, size_t out_len) {
    if (UNLIKELY(!ct || !*ct)) {
        out[0] = '\0';
        return;
    }

    size_t i = 0, j = 0;

    /* Skip leading whitespace */
    while (ct[i] == ' ') i++;

    /* Copy until semicolon, lowercasing */
    while (ct[i] && ct[i] != ';' && j < out_len - 1) {
        char c = ct[i++];
        out[j++] = (c >= 'A' && c <= 'Z') ? c + 32 : c;
    }

    /* Trim trailing whitespace */
    while (j > 0 && out[j-1] == ' ') j--;

    out[j] = '\0';
}

/* Check if content type is JSON - ultra fast */
static inline bool is_json_content_type_fast(const char *ct) {
    return fast_is_json(ct);
}

/* Create a new message - using arrays internally */
typedef struct fast_msg {
    uint8_t *data;
    uint32_t len;
    char offset[34];
    uint64_t timestamp;
} fast_msg_t;

/* Process JSON for append - optimized */
static int process_json_append_fast(const uint8_t *data, size_t len, bool is_initial,
                                     uint8_t **out_data, size_t *out_len) {
    if (UNLIKELY(len == 0)) {
        if (is_initial) {
            *out_data = NULL;
            *out_len = 0;
            return 0;
        }
        return -1;
    }

    /* Find first non-whitespace */
    size_t start = 0;
    while (start < len && (data[start] == ' ' || data[start] == '\t' ||
                           data[start] == '\n' || data[start] == '\r')) {
        start++;
    }

    if (UNLIKELY(start >= len)) {
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
                if (c == '[') depth++;
                else if (c == ']') depth--;
            }
            i++;
        }

        if (UNLIKELY(depth != 0)) return -1;

        /* Extract array contents */
        size_t array_start = start + 1;
        size_t array_end = i - 1;

        /* Skip whitespace inside array */
        while (array_start < array_end &&
               (data[array_start] == ' ' || data[array_start] == '\t' ||
                data[array_start] == '\n' || data[array_start] == '\r')) {
            array_start++;
        }
        while (array_end > array_start &&
               (data[array_end - 1] == ' ' || data[array_end - 1] == '\t' ||
                data[array_end - 1] == '\n' || data[array_end - 1] == '\r')) {
            array_end--;
        }

        /* Check for empty array */
        if (array_start >= array_end) {
            if (is_initial) {
                *out_data = NULL;
                *out_len = 0;
                return 0;
            }
            return -1;
        }

        /* Allocate output with trailing comma */
        size_t content_len = array_end - array_start;
        *out_data = malloc(content_len + 1);
        if (!*out_data) return -1;
        memcpy(*out_data, data + array_start, content_len);
        (*out_data)[content_len] = ',';
        *out_len = content_len + 1;
    } else {
        /* Single value - copy and add comma */
        size_t end = len;
        while (end > start && (data[end - 1] == ' ' || data[end - 1] == '\t' ||
                               data[end - 1] == '\n' || data[end - 1] == '\r')) {
            end--;
        }

        size_t content_len = end - start;
        *out_data = malloc(content_len + 1);
        if (!*out_data) return -1;
        memcpy(*out_data, data + start, content_len);
        (*out_data)[content_len] = ',';
        *out_len = content_len + 1;
    }

    return 0;
}

/* Optimized stream structure using arrays */
typedef struct fast_stream {
    char path[DS_MAX_PATH_LEN];
    char content_type[DS_MAX_CONTENT_TYPE_LEN];

    /* Array-based message storage */
    uint8_t **msg_data;
    uint32_t *msg_lens;
    char (*msg_offsets)[34];
    uint32_t msg_count;
    uint32_t msg_capacity;

    /* Current state */
    uint64_t read_seq;
    uint64_t byte_offset;
    char current_offset[34];

    /* Metadata */
    char last_seq[DS_MAX_OFFSET_LEN];
    int64_t ttl_seconds;
    char expires_at[64];
    uint64_t created_at;
    bool closed;
    ds_closed_by_t *closed_by;
    ds_producer_state_t *producers;

    /* Synchronization */
    pthread_mutex_t lock;
    pthread_cond_t cond;

    /* Hash chain */
    struct fast_stream *next;
} fast_stream_t;

/* Optimized store */
typedef struct fast_store {
    fast_stream_t **buckets;
    size_t bucket_count;
    size_t stream_count;
    pthread_rwlock_t lock;
} fast_store_t;

/* Create store with more buckets */
ds_store_t *ds_store_create(size_t bucket_count) {
    if (bucket_count == 0) {
        bucket_count = DS_STORE_FAST_BUCKETS;
    }

    fast_store_t *store = aligned_alloc(CACHE_LINE_SIZE, sizeof(fast_store_t));
    if (!store) return NULL;
    memset(store, 0, sizeof(*store));

    store->buckets = calloc(bucket_count, sizeof(fast_stream_t *));
    if (!store->buckets) {
        free(store);
        return NULL;
    }

    store->bucket_count = bucket_count;
    store->stream_count = 0;
    pthread_rwlock_init(&store->lock, NULL);

    return (ds_store_t *)store;
}

void ds_store_destroy(ds_store_t *store) {
    if (!store) return;
    fast_store_t *fs = (fast_store_t *)store;

    pthread_rwlock_wrlock(&fs->lock);

    for (size_t i = 0; i < fs->bucket_count; i++) {
        fast_stream_t *stream = fs->buckets[i];
        while (stream) {
            fast_stream_t *next = stream->next;

            /* Free messages */
            for (uint32_t j = 0; j < stream->msg_count; j++) {
                free(stream->msg_data[j]);
            }
            free(stream->msg_data);
            free(stream->msg_lens);
            free(stream->msg_offsets);

            /* Free producers */
            ds_producer_state_t *prod = stream->producers;
            while (prod) {
                ds_producer_state_t *pnext = prod->next;
                free(prod);
                prod = pnext;
            }

            free(stream->closed_by);
            pthread_mutex_destroy(&stream->lock);
            pthread_cond_destroy(&stream->cond);
            free(stream);

            stream = next;
        }
    }

    free(fs->buckets);
    pthread_rwlock_unlock(&fs->lock);
    pthread_rwlock_destroy(&fs->lock);
    free(fs);
}

/* Find producer state - with caching hint */
static inline ds_producer_state_t *find_producer_fast(fast_stream_t *stream,
                                                        const char *producer_id,
                                                        size_t id_len) {
    ds_producer_state_t *prod = stream->producers;
    while (prod) {
        if (LIKELY(memcmp(prod->producer_id, producer_id, id_len + 1) == 0)) {
            return prod;
        }
        prod = prod->next;
    }
    return NULL;
}

/* Validate producer - no mutation */
static ds_producer_result_t validate_producer_fast(fast_stream_t *stream,
                                                    const char *producer_id,
                                                    uint64_t epoch, uint64_t seq) {
    ds_producer_result_t result = {0};
    size_t id_len = strlen(producer_id);

    ds_producer_state_t *state = find_producer_fast(stream, producer_id, id_len);

    if (!state) {
        if (UNLIKELY(seq != 0)) {
            result.status = DS_PRODUCER_SEQUENCE_GAP;
            result.expected_seq = 0;
            result.received_seq = seq;
            return result;
        }
        result.status = DS_PRODUCER_ACCEPTED;
        return result;
    }

    if (UNLIKELY(epoch < state->epoch)) {
        result.status = DS_PRODUCER_STALE_EPOCH;
        result.current_epoch = state->epoch;
        return result;
    }

    if (epoch > state->epoch) {
        if (UNLIKELY(seq != 0)) {
            result.status = DS_PRODUCER_INVALID_EPOCH_SEQ;
            return result;
        }
        result.status = DS_PRODUCER_ACCEPTED;
        return result;
    }

    if (seq <= state->last_seq) {
        result.status = DS_PRODUCER_DUPLICATE;
        result.last_seq = state->last_seq;
        return result;
    }

    if (LIKELY(seq == state->last_seq + 1)) {
        result.status = DS_PRODUCER_ACCEPTED;
        return result;
    }

    result.status = DS_PRODUCER_SEQUENCE_GAP;
    result.expected_seq = state->last_seq + 1;
    result.received_seq = seq;
    return result;
}

/* Upsert producer state */
static ds_producer_state_t *upsert_producer_fast(fast_stream_t *stream,
                                                   const char *producer_id,
                                                   uint64_t epoch, uint64_t seq) {
    size_t id_len = strlen(producer_id);
    ds_producer_state_t *prod = find_producer_fast(stream, producer_id, id_len);

    if (prod) {
        prod->epoch = epoch;
        prod->last_seq = seq;
        prod->last_updated = fast_time_ms();
        return prod;
    }

    prod = calloc(1, sizeof(ds_producer_state_t));
    if (!prod) return NULL;

    memcpy(prod->producer_id, producer_id, id_len + 1);
    prod->epoch = epoch;
    prod->last_seq = seq;
    prod->last_updated = fast_time_ms();
    prod->next = stream->producers;
    stream->producers = prod;

    return prod;
}

/* Append message to stream - array based */
static int append_to_stream_fast(fast_stream_t *stream, const uint8_t *data, size_t len,
                                  bool is_initial) {
    uint8_t *final_data = (uint8_t *)data;
    size_t final_len = len;
    bool allocated = false;

    /* Process JSON mode */
    if (is_json_content_type_fast(stream->content_type)) {
        if (process_json_append_fast(data, len, is_initial, &final_data, &final_len) != 0) {
            return -1;
        }
        if (!final_data) {
            return 1;  /* Empty stream created */
        }
        allocated = true;
    }

    /* Grow arrays if needed */
    if (UNLIKELY(stream->msg_count >= stream->msg_capacity)) {
        uint32_t new_cap = stream->msg_capacity == 0 ? 16 : stream->msg_capacity * 2;

        uint8_t **new_data = realloc(stream->msg_data, new_cap * sizeof(uint8_t *));
        uint32_t *new_lens = realloc(stream->msg_lens, new_cap * sizeof(uint32_t));
        char (*new_offsets)[34] = realloc(stream->msg_offsets, new_cap * 34);

        if (!new_data || !new_lens || !new_offsets) {
            if (allocated) free(final_data);
            return -1;
        }

        stream->msg_data = new_data;
        stream->msg_lens = new_lens;
        stream->msg_offsets = new_offsets;
        stream->msg_capacity = new_cap;
    }

    /* Store message */
    uint8_t *msg_copy;
    if (allocated) {
        msg_copy = final_data;
    } else {
        msg_copy = malloc(final_len);
        if (!msg_copy) return -1;
        memcpy(msg_copy, final_data, final_len);
    }

    /* Calculate new offset */
    uint64_t new_byte_offset = stream->byte_offset + final_len;

    stream->msg_data[stream->msg_count] = msg_copy;
    stream->msg_lens[stream->msg_count] = (uint32_t)final_len;
    ds_format_offset(stream->msg_offsets[stream->msg_count], 34,
                     stream->read_seq, new_byte_offset);
    stream->msg_count++;

    stream->byte_offset = new_byte_offset;
    ds_format_offset(stream->current_offset, sizeof(stream->current_offset),
                     stream->read_seq, new_byte_offset);

    return 0;
}

/* Create stream */
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
    fast_store_t *fs = (fast_store_t *)store;
    size_t path_len = strlen(path);

    pthread_rwlock_wrlock(&fs->lock);

    /* Check if stream exists */
    uint64_t hash = fast_hash(path, path_len);
    size_t bucket = hash % fs->bucket_count;
    fast_stream_t *existing = fs->buckets[bucket];

    while (existing) {
        if (LIKELY(strcmp(existing->path, path) == 0)) {
            /* Check config match for idempotent create */
            char norm_ct[64], norm_existing[64];
            fast_normalize_ct(content_type ? content_type : "application/octet-stream",
                              norm_ct, sizeof(norm_ct));
            fast_normalize_ct(existing->content_type, norm_existing, sizeof(norm_existing));

            bool ct_match = strcmp(norm_ct, norm_existing) == 0;
            bool ttl_match = ttl_seconds == existing->ttl_seconds;
            bool expires_match = (!expires_at && !existing->expires_at[0]) ||
                                 (expires_at && strcmp(expires_at, existing->expires_at) == 0);
            bool closed_match = closed == existing->closed;

            if (ct_match && ttl_match && expires_match && closed_match) {
                pthread_rwlock_unlock(&fs->lock);
                return (ds_stream_t *)existing;
            }

            snprintf(error, error_len, "Stream already exists with different configuration");
            pthread_rwlock_unlock(&fs->lock);
            return NULL;
        }
        existing = existing->next;
    }

    /* Create new stream */
    fast_stream_t *stream = aligned_alloc(CACHE_LINE_SIZE, sizeof(fast_stream_t));
    if (!stream) {
        snprintf(error, error_len, "Memory allocation failed");
        pthread_rwlock_unlock(&fs->lock);
        return NULL;
    }
    memset(stream, 0, sizeof(*stream));

    memcpy(stream->path, path, path_len + 1);
    if (content_type) {
        strncpy(stream->content_type, content_type, sizeof(stream->content_type) - 1);
    } else {
        strcpy(stream->content_type, "application/octet-stream");
    }

    stream->ttl_seconds = ttl_seconds;
    if (expires_at) {
        strncpy(stream->expires_at, expires_at, sizeof(stream->expires_at) - 1);
    }
    stream->closed = closed;
    stream->created_at = fast_time_ms();
    ds_format_offset(stream->current_offset, sizeof(stream->current_offset), 0, 0);

    pthread_mutex_init(&stream->lock, NULL);
    pthread_cond_init(&stream->cond, NULL);

    /* Append initial data if provided */
    if (initial_data && initial_data_len > 0) {
        pthread_mutex_lock(&stream->lock);
        int ret = append_to_stream_fast(stream, initial_data, initial_data_len, true);
        pthread_mutex_unlock(&stream->lock);

        if (ret < 0) {
            snprintf(error, error_len, "Invalid JSON in initial data");
            pthread_mutex_destroy(&stream->lock);
            pthread_cond_destroy(&stream->cond);
            free(stream);
            pthread_rwlock_unlock(&fs->lock);
            return NULL;
        }
    }

    /* Insert into hash table */
    stream->next = fs->buckets[bucket];
    fs->buckets[bucket] = stream;
    fs->stream_count++;

    pthread_rwlock_unlock(&fs->lock);
    return (ds_stream_t *)stream;
}

/* Get stream */
ds_stream_t *ds_store_get(ds_store_t *store, const char *path) {
    fast_store_t *fs = (fast_store_t *)store;
    size_t path_len = strlen(path);

    pthread_rwlock_rdlock(&fs->lock);

    uint64_t hash = fast_hash(path, path_len);
    size_t bucket = hash % fs->bucket_count;
    fast_stream_t *stream = fs->buckets[bucket];

    while (stream) {
        if (LIKELY(strcmp(stream->path, path) == 0)) {
            pthread_rwlock_unlock(&fs->lock);
            return (ds_stream_t *)stream;
        }
        stream = stream->next;
    }

    pthread_rwlock_unlock(&fs->lock);
    return NULL;
}

bool ds_store_has(ds_store_t *store, const char *path) {
    return ds_store_get(store, path) != NULL;
}

/* Delete stream */
bool ds_store_delete(ds_store_t *store, const char *path) {
    fast_store_t *fs = (fast_store_t *)store;
    size_t path_len = strlen(path);

    pthread_rwlock_wrlock(&fs->lock);

    uint64_t hash = fast_hash(path, path_len);
    size_t bucket = hash % fs->bucket_count;
    fast_stream_t *stream = fs->buckets[bucket];
    fast_stream_t *prev = NULL;

    while (stream) {
        if (strcmp(stream->path, path) == 0) {
            if (prev) {
                prev->next = stream->next;
            } else {
                fs->buckets[bucket] = stream->next;
            }

            /* Wake up waiting threads */
            pthread_mutex_lock(&stream->lock);
            pthread_cond_broadcast(&stream->cond);
            pthread_mutex_unlock(&stream->lock);

            /* Free messages */
            for (uint32_t j = 0; j < stream->msg_count; j++) {
                free(stream->msg_data[j]);
            }
            free(stream->msg_data);
            free(stream->msg_lens);
            free(stream->msg_offsets);

            /* Free producers */
            ds_producer_state_t *prod = stream->producers;
            while (prod) {
                ds_producer_state_t *pnext = prod->next;
                free(prod);
                prod = pnext;
            }

            free(stream->closed_by);
            pthread_mutex_destroy(&stream->lock);
            pthread_cond_destroy(&stream->cond);
            free(stream);

            fs->stream_count--;
            pthread_rwlock_unlock(&fs->lock);
            return true;
        }
        prev = stream;
        stream = stream->next;
    }

    pthread_rwlock_unlock(&fs->lock);
    return false;
}

/* Append to stream */
ds_append_result_t ds_store_append(
    ds_store_t *store,
    const char *path,
    const uint8_t *data,
    size_t data_len,
    const ds_append_options_t *options
) {
    ds_append_result_t result = {0};

    fast_stream_t *stream = (fast_stream_t *)ds_store_get(store, path);
    if (UNLIKELY(!stream)) {
        snprintf(result.error, sizeof(result.error), "Stream not found");
        return result;
    }

    pthread_mutex_lock(&stream->lock);

    /* Check if stream is closed */
    if (UNLIKELY(stream->closed)) {
        /* Check for idempotent duplicate */
        if (options->producer_id && stream->closed_by &&
            strcmp(stream->closed_by->producer_id, options->producer_id) == 0 &&
            stream->closed_by->epoch == (uint64_t)options->producer_epoch &&
            stream->closed_by->seq == (uint64_t)options->producer_seq) {
            result.success = false;
            result.stream_closed = true;
            result.producer_result.status = DS_PRODUCER_DUPLICATE;
            result.producer_result.last_seq = (uint64_t)options->producer_seq;
            memcpy(result.offset, stream->current_offset, 34);
            pthread_mutex_unlock(&stream->lock);
            return result;
        }

        result.success = false;
        result.stream_closed = true;
        memcpy(result.offset, stream->current_offset, 34);
        pthread_mutex_unlock(&stream->lock);
        return result;
    }

    /* Check content type */
    if (options->content_type) {
        char norm_opt[64], norm_stream[64];
        fast_normalize_ct(options->content_type, norm_opt, sizeof(norm_opt));
        fast_normalize_ct(stream->content_type, norm_stream, sizeof(norm_stream));

        if (UNLIKELY(strcmp(norm_opt, norm_stream) != 0)) {
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
        result.producer_result = validate_producer_fast(stream, options->producer_id,
                                                         (uint64_t)options->producer_epoch,
                                                         (uint64_t)options->producer_seq);

        if (result.producer_result.status != DS_PRODUCER_ACCEPTED) {
            memcpy(result.offset, stream->current_offset, 34);
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
    int ret = append_to_stream_fast(stream, data, data_len, false);
    if (ret < 0) {
        snprintf(result.error, sizeof(result.error), "Invalid JSON or empty array");
        pthread_mutex_unlock(&stream->lock);
        return result;
    }

    /* Commit producer state after successful append */
    if (has_producer) {
        upsert_producer_fast(stream, options->producer_id,
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
            stream->closed_by = calloc(1, sizeof(ds_closed_by_t));
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
    memcpy(result.offset, stream->current_offset, 34);

    /* Wake up waiting readers */
    pthread_cond_broadcast(&stream->cond);

    pthread_mutex_unlock(&stream->lock);
    return result;
}

/* Format JSON response */
static int format_json_response_fast(const uint8_t *data, size_t len, ds_buffer_t *out) {
    ds_buffer_clear(out);

    if (len == 0) {
        return ds_buffer_append_str(out, "[]");
    }

    /* Remove trailing commas/whitespace */
    while (len > 0 && (data[len - 1] == ',' || data[len - 1] == ' ' ||
                       data[len - 1] == '\t' || data[len - 1] == '\n')) {
        len--;
    }

    if (ds_buffer_ensure(out, len + 2) != 0) return -1;

    out->data[0] = '[';
    memcpy(out->data + 1, data, len);
    out->data[len + 1] = ']';
    out->len = len + 2;

    return 0;
}

/* Read from stream */
ds_read_result_t ds_store_read(
    ds_store_t *store,
    const char *path,
    const char *offset
) {
    ds_read_result_t result = {0};
    ds_buffer_init(&result.data);

    fast_stream_t *stream = (fast_stream_t *)ds_store_get(store, path);
    if (UNLIKELY(!stream)) {
        return result;
    }

    pthread_mutex_lock(&stream->lock);

    /* Calculate total size and find start index */
    size_t total_size = 0;
    uint32_t start_idx = 0;

    if (offset && offset[0] && strcmp(offset, "-1") != 0) {
        /* Find first message after offset */
        for (uint32_t i = 0; i < stream->msg_count; i++) {
            if (strcmp(stream->msg_offsets[i], offset) > 0) {
                start_idx = i;
                break;
            }
            start_idx = i + 1;
        }
    }

    /* Calculate total size of messages to return */
    for (uint32_t i = start_idx; i < stream->msg_count; i++) {
        total_size += stream->msg_lens[i];
    }

    /* Allocate buffer and copy data */
    if (total_size > 0) {
        ds_buffer_t raw_data;
        ds_buffer_init(&raw_data);
        ds_buffer_ensure(&raw_data, total_size);

        for (uint32_t i = start_idx; i < stream->msg_count; i++) {
            memcpy(raw_data.data + raw_data.len, stream->msg_data[i], stream->msg_lens[i]);
            raw_data.len += stream->msg_lens[i];
        }

        /* Format response */
        if (is_json_content_type_fast(stream->content_type)) {
            format_json_response_fast(raw_data.data, raw_data.len, &result.data);
        } else {
            ds_buffer_copy(&result.data, &raw_data);
        }

        ds_buffer_free(&raw_data);
    } else {
        /* Empty result */
        if (is_json_content_type_fast(stream->content_type)) {
            ds_buffer_append_str(&result.data, "[]");
        }
    }

    memcpy(result.next_offset, stream->current_offset, 34);
    result.up_to_date = true;
    result.stream_closed = stream->closed;

    pthread_mutex_unlock(&stream->lock);
    return result;
}

/* Close stream */
bool ds_store_close_stream(
    ds_store_t *store,
    const char *path,
    char *final_offset,
    bool *already_closed
) {
    fast_stream_t *stream = (fast_stream_t *)ds_store_get(store, path);
    if (!stream) return false;

    pthread_mutex_lock(&stream->lock);

    *already_closed = stream->closed;
    stream->closed = true;
    memcpy(final_offset, stream->current_offset, 34);

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
    fast_stream_t *stream = (fast_stream_t *)ds_store_get(store, path);
    if (!stream) return false;

    pthread_mutex_lock(&stream->lock);

    *already_closed = stream->closed;
    memcpy(final_offset, stream->current_offset, 34);

    if (stream->closed) {
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

    *result = validate_producer_fast(stream, producer_id, epoch, seq);

    if (result->status != DS_PRODUCER_ACCEPTED) {
        pthread_mutex_unlock(&stream->lock);
        return true;
    }

    upsert_producer_fast(stream, producer_id, epoch, seq);
    stream->closed = true;
    stream->closed_by = calloc(1, sizeof(ds_closed_by_t));
    if (stream->closed_by) {
        strncpy(stream->closed_by->producer_id, producer_id,
                sizeof(stream->closed_by->producer_id) - 1);
        stream->closed_by->epoch = epoch;
        stream->closed_by->seq = seq;
    }

    pthread_cond_broadcast(&stream->cond);

    pthread_mutex_unlock(&stream->lock);
    return true;
}

/* Wait for messages */
bool ds_store_wait_for_messages(
    ds_store_t *store,
    const char *path,
    const char *offset,
    int timeout_ms,
    ds_read_result_t *result
) {
    fast_stream_t *stream = (fast_stream_t *)ds_store_get(store, path);
    if (!stream) return false;

    pthread_mutex_lock(&stream->lock);

    /* Check if there's already new data */
    bool has_new = false;
    if (!offset || !offset[0] || strcmp(offset, "-1") == 0) {
        has_new = stream->msg_count > 0;
    } else {
        for (uint32_t i = 0; i < stream->msg_count; i++) {
            if (strcmp(stream->msg_offsets[i], offset) > 0) {
                has_new = true;
                break;
            }
        }
    }

    /* If no new data and stream is closed, return immediately */
    if (!has_new && stream->closed) {
        memcpy(result->next_offset, stream->current_offset, 34);
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
            memcpy(result->next_offset, stream->current_offset, 34);
            result->up_to_date = true;
            result->stream_closed = stream->closed;
            pthread_mutex_unlock(&stream->lock);
            return false;
        }
    }

    pthread_mutex_unlock(&stream->lock);

    /* Read the data */
    *result = ds_store_read(store, path, offset);
    return true;
}

/* Clear store */
void ds_store_clear(ds_store_t *store) {
    fast_store_t *fs = (fast_store_t *)store;

    pthread_rwlock_wrlock(&fs->lock);

    for (size_t i = 0; i < fs->bucket_count; i++) {
        fast_stream_t *stream = fs->buckets[i];
        while (stream) {
            fast_stream_t *next = stream->next;

            pthread_mutex_lock(&stream->lock);
            pthread_cond_broadcast(&stream->cond);
            pthread_mutex_unlock(&stream->lock);

            for (uint32_t j = 0; j < stream->msg_count; j++) {
                free(stream->msg_data[j]);
            }
            free(stream->msg_data);
            free(stream->msg_lens);
            free(stream->msg_offsets);

            ds_producer_state_t *prod = stream->producers;
            while (prod) {
                ds_producer_state_t *pnext = prod->next;
                free(prod);
                prod = pnext;
            }

            free(stream->closed_by);
            pthread_mutex_destroy(&stream->lock);
            pthread_cond_destroy(&stream->cond);
            free(stream);

            stream = next;
        }
        fs->buckets[i] = NULL;
    }

    fs->stream_count = 0;
    pthread_rwlock_unlock(&fs->lock);
}

uint64_t ds_generate_cursor(uint64_t cursor_epoch, int interval_sec, uint64_t client_cursor) {
    uint64_t now = fast_time_sec();
    uint64_t current_interval = (now - cursor_epoch) / (uint64_t)interval_sec;

    if (client_cursor >= current_interval) {
        return client_cursor + 1 + (rand() % 3600);
    }

    return current_interval;
}
