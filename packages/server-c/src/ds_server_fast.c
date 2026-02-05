/**
 * Durable Streams Server - Ultra-Fast HTTP Server
 *
 * Epoll-based event loop, pre-computed headers, zero-allocation hot paths.
 */

#include "ds_server.h"
#include "ds_fast.h"
#include <microhttpd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

/* Pre-computed header strings */
static const char HDR_STREAM_OFFSET[] = "Stream-Next-Offset";
static const char HDR_STREAM_CURSOR[] = "Stream-Cursor";
static const char HDR_STREAM_UP_TO_DATE[] = "Stream-Up-To-Date";
static const char HDR_STREAM_CLOSED[] = "Stream-Closed";
static const char HDR_PRODUCER_ID[] = "Producer-Id";
static const char HDR_PRODUCER_EPOCH[] = "Producer-Epoch";
static const char HDR_PRODUCER_SEQ[] = "Producer-Seq";
static const char HDR_PRODUCER_EXPECTED_SEQ[] = "Producer-Expected-Seq";
static const char HDR_PRODUCER_RECEIVED_SEQ[] = "Producer-Received-Seq";

/* Common response strings */
static const char RESP_STREAM_NOT_FOUND[] = "Stream not found";
static const char RESP_EMPTY_BODY[] = "Empty body";
static const char RESP_CT_REQUIRED[] = "Content-Type header is required";
static const char RESP_INVALID_OFFSET[] = "Invalid offset format";
static const char RESP_LIVE_NEEDS_OFFSET[] = "Live mode requires offset parameter";
static const char RESP_PRODUCER_INCOMPLETE[] = "All producer headers must be provided together";
static const char RESP_PRODUCER_ID_EMPTY[] = "Invalid Producer-Id: must not be empty";
static const char RESP_PRODUCER_INVALID[] = "Invalid Producer-Epoch or Producer-Seq";
static const char RESP_STALE_EPOCH[] = "Stale producer epoch";
static const char RESP_EPOCH_SEQ_ZERO[] = "New epoch must start with sequence 0";
static const char RESP_SEQ_GAP[] = "Producer sequence gap";
static const char RESP_STREAM_CLOSED[] = "Stream is closed";

/* Request context - aligned for cache efficiency */
typedef struct request_ctx {
    ds_buffer_t body;
    ds_server_t *server;
    http_method_t method;
    uint8_t _pad[4];
} CACHE_ALIGNED request_ctx_t;

/* Fast header lookup */
static inline const char *get_header(struct MHD_Connection *conn, const char *name) {
    return MHD_lookup_connection_value(conn, MHD_HEADER_KIND, name);
}

static inline const char *get_param(struct MHD_Connection *conn, const char *name) {
    return MHD_lookup_connection_value(conn, MHD_GET_ARGUMENT_KIND, name);
}

/* Parse int header - ultra fast */
static inline int64_t parse_int_header_fast(const char *value) {
    if (UNLIKELY(!value || !*value)) return -1;

    int64_t result = 0;
    const char *p = value;

    while (*p) {
        char c = *p++;
        if (UNLIKELY(c < '0' || c > '9')) return -1;
        result = result * 10 + (c - '0');
    }

    return result;
}

/* Add multiple headers efficiently */
static inline void add_common_headers(struct MHD_Response *resp) {
    MHD_add_response_header(resp, "Access-Control-Allow-Origin", "*");
    MHD_add_response_header(resp, "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
    MHD_add_response_header(resp, "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, "
        "Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq");
    MHD_add_response_header(resp, "Access-Control-Expose-Headers",
        "Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, "
        "Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, "
        "ETag, Content-Type, Content-Encoding, Vary");
    MHD_add_response_header(resp, "X-Content-Type-Options", "nosniff");
    MHD_add_response_header(resp, "Cross-Origin-Resource-Policy", "cross-origin");
}

/* Pre-allocated empty response */
static struct MHD_Response *empty_response = NULL;
static struct MHD_Response *empty_json_response = NULL;

/* Initialize pre-allocated responses */
static void init_responses(void) {
    if (!empty_response) {
        empty_response = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
        add_common_headers(empty_response);
    }
    if (!empty_json_response) {
        empty_json_response = MHD_create_response_from_buffer(2, "[]", MHD_RESPMEM_PERSISTENT);
        add_common_headers(empty_json_response);
        MHD_add_response_header(empty_json_response, "Content-Type", "application/json");
    }
}

/* Handle OPTIONS - ultra fast */
static enum MHD_Result handle_options_fast(struct MHD_Connection *conn) {
    struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
    add_common_headers(resp);
    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NO_CONTENT, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* Handle PUT - create stream */
static enum MHD_Result handle_put_fast(ds_server_t *server, struct MHD_Connection *conn,
                                        const char *path, const uint8_t *body, size_t body_len) {
    const char *content_type = get_header(conn, "Content-Type");
    const char *ttl_str = get_header(conn, "Stream-TTL");
    const char *expires_at = get_header(conn, "Stream-Expires-At");
    const char *closed_str = get_header(conn, HDR_STREAM_CLOSED);

    int64_t ttl_seconds = -1;
    if (ttl_str && *ttl_str) {
        ttl_seconds = parse_int_header_fast(ttl_str);
        if (ttl_seconds < 0) {
            struct MHD_Response *resp = MHD_create_response_from_buffer(
                22, "Invalid Stream-TTL value", MHD_RESPMEM_PERSISTENT);
            add_common_headers(resp);
            MHD_add_response_header(resp, "Content-Type", "text/plain");
            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
            MHD_destroy_response(resp);
            return ret;
        }
    }

    if (ttl_str && *ttl_str && expires_at && *expires_at) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            47, "Cannot specify both Stream-TTL and Stream-Expires-At", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    bool closed = closed_str && (closed_str[0] == 't' || closed_str[0] == 'T');

    char error[256] = {0};
    ds_stream_t *stream = ds_store_create_stream(
        server->store, path, content_type, ttl_seconds, expires_at,
        body, body_len, closed, error, sizeof(error));

    if (UNLIKELY(!stream)) {
        int status = strstr(error, "Memory") ? MHD_HTTP_INTERNAL_SERVER_ERROR : MHD_HTTP_CONFLICT;
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            strlen(error), error, MHD_RESPMEM_MUST_COPY);
        add_common_headers(resp);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, status, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
    add_common_headers(resp);

    /* Access stream fields directly - cast to internal type */
    typedef struct {
        char path[4096];
        char content_type[256];
        void *msg_data;
        void *msg_lens;
        void *msg_offsets;
        uint32_t msg_count;
        uint32_t msg_capacity;
        uint64_t read_seq;
        uint64_t byte_offset;
        char current_offset[34];
    } fast_stream_header_t;

    fast_stream_header_t *fs = (fast_stream_header_t *)stream;

    if (fs->content_type[0]) {
        MHD_add_response_header(resp, "Content-Type", fs->content_type);
    }
    MHD_add_response_header(resp, HDR_STREAM_OFFSET, fs->current_offset);

    if (closed) {
        MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
    }

    char location[4160];
    snprintf(location, sizeof(location), "http://%s:%d%s",
             server->config.host, server->config.port, path);
    MHD_add_response_header(resp, "Location", location);

    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_CREATED, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* Handle HEAD */
static enum MHD_Result handle_head_fast(ds_server_t *server, struct MHD_Connection *conn,
                                         const char *path) {
    ds_stream_t *stream = ds_store_get(server->store, path);
    if (UNLIKELY(!stream)) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_FOUND, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Cast to access fields */
    typedef struct {
        char path[4096];
        char content_type[256];
        void *msg_data;
        void *msg_lens;
        void *msg_offsets;
        uint32_t msg_count;
        uint32_t msg_capacity;
        uint64_t read_seq;
        uint64_t byte_offset;
        char current_offset[34];
        char last_seq[64];
        int64_t ttl_seconds;
        char expires_at[64];
        uint64_t created_at;
        bool closed;
    } fast_stream_header_t;

    fast_stream_header_t *fs = (fast_stream_header_t *)stream;

    struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
    add_common_headers(resp);

    MHD_add_response_header(resp, HDR_STREAM_OFFSET, fs->current_offset);
    MHD_add_response_header(resp, "Cache-Control", "no-store");

    if (fs->content_type[0]) {
        MHD_add_response_header(resp, "Content-Type", fs->content_type);
    }

    if (fs->closed) {
        MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
    }

    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_OK, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* Handle DELETE */
static enum MHD_Result handle_delete_fast(ds_server_t *server, struct MHD_Connection *conn,
                                           const char *path) {
    bool deleted = ds_store_delete(server->store, path);

    struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
    add_common_headers(resp);

    enum MHD_Result ret = MHD_queue_response(conn,
        deleted ? MHD_HTTP_NO_CONTENT : MHD_HTTP_NOT_FOUND, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* Handle GET - optimized read */
static enum MHD_Result handle_get_fast(ds_server_t *server, struct MHD_Connection *conn,
                                        const char *path) {
    ds_stream_t *stream = ds_store_get(server->store, path);
    if (UNLIKELY(!stream)) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            16, (void *)RESP_STREAM_NOT_FOUND, MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_FOUND, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Cast to access fields */
    typedef struct {
        char path[4096];
        char content_type[256];
        void *msg_data;
        void *msg_lens;
        void *msg_offsets;
        uint32_t msg_count;
        uint32_t msg_capacity;
        uint64_t read_seq;
        uint64_t byte_offset;
        char current_offset[34];
        char last_seq[64];
        int64_t ttl_seconds;
        char expires_at[64];
        uint64_t created_at;
        bool closed;
    } fast_stream_header_t;

    fast_stream_header_t *fs = (fast_stream_header_t *)stream;

    const char *offset = get_param(conn, "offset");
    const char *live = get_param(conn, "live");
    const char *cursor = get_param(conn, "cursor");

    /* Validate offset format */
    if (offset && *offset) {
        if (strcmp(offset, "-1") != 0 && strcmp(offset, "now") != 0) {
            if (!strchr(offset, '_')) {
                struct MHD_Response *resp = MHD_create_response_from_buffer(
                    21, (void *)RESP_INVALID_OFFSET, MHD_RESPMEM_PERSISTENT);
                add_common_headers(resp);
                MHD_add_response_header(resp, "Content-Type", "text/plain");
                enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
                MHD_destroy_response(resp);
                return ret;
            }
        }
    }

    /* Require offset for live modes */
    if (live && *live && (!offset || !*offset)) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            35, (void *)RESP_LIVE_NEEDS_OFFSET, MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Handle offset=now */
    const char *effective_offset = offset;
    if (offset && fast_streq(offset, "now", 3) && offset[3] == '\0') {
        effective_offset = fs->current_offset;

        if (!live || strcmp(live, "long-poll") != 0) {
            struct MHD_Response *resp;
            if (fast_is_json(fs->content_type)) {
                resp = MHD_create_response_from_buffer(2, "[]", MHD_RESPMEM_PERSISTENT);
            } else {
                resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
            }

            add_common_headers(resp);
            MHD_add_response_header(resp, HDR_STREAM_OFFSET, fs->current_offset);
            MHD_add_response_header(resp, HDR_STREAM_UP_TO_DATE, "true");
            MHD_add_response_header(resp, "Cache-Control", "no-store");

            if (fs->content_type[0]) {
                MHD_add_response_header(resp, "Content-Type", fs->content_type);
            }
            if (fs->closed) {
                MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
            }

            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_OK, resp);
            MHD_destroy_response(resp);
            return ret;
        }
    }

    /* Long-poll mode */
    if (live && fast_streq(live, "long-poll", 9) && live[9] == '\0') {
        bool at_tail = effective_offset && strcmp(effective_offset, fs->current_offset) == 0;

        if (fs->closed && at_tail) {
            struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
            add_common_headers(resp);
            MHD_add_response_header(resp, HDR_STREAM_OFFSET, fs->current_offset);
            MHD_add_response_header(resp, HDR_STREAM_UP_TO_DATE, "true");
            MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");

            uint64_t cursor_val = ds_generate_cursor(
                server->config.cursor_epoch,
                server->config.cursor_interval_sec,
                cursor ? strtoull(cursor, NULL, 10) : 0);
            char cursor_str[32];
            snprintf(cursor_str, sizeof(cursor_str), "%lu", cursor_val);
            MHD_add_response_header(resp, HDR_STREAM_CURSOR, cursor_str);

            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NO_CONTENT, resp);
            MHD_destroy_response(resp);
            return ret;
        }

        ds_read_result_t result;
        bool has_data = ds_store_wait_for_messages(
            server->store, path, effective_offset,
            server->config.long_poll_timeout_ms, &result);

        if (!has_data) {
            struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
            add_common_headers(resp);
            MHD_add_response_header(resp, HDR_STREAM_OFFSET, result.next_offset);
            MHD_add_response_header(resp, HDR_STREAM_UP_TO_DATE, "true");

            uint64_t cursor_val = ds_generate_cursor(
                server->config.cursor_epoch,
                server->config.cursor_interval_sec,
                cursor ? strtoull(cursor, NULL, 10) : 0);
            char cursor_str[32];
            snprintf(cursor_str, sizeof(cursor_str), "%lu", cursor_val);
            MHD_add_response_header(resp, HDR_STREAM_CURSOR, cursor_str);

            if (result.stream_closed) {
                MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
            }

            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NO_CONTENT, resp);
            MHD_destroy_response(resp);
            ds_buffer_free(&result.data);
            return ret;
        }

        struct MHD_Response *resp = MHD_create_response_from_buffer(
            result.data.len, result.data.data, MHD_RESPMEM_MUST_COPY);
        add_common_headers(resp);
        MHD_add_response_header(resp, HDR_STREAM_OFFSET, result.next_offset);

        if (result.up_to_date) {
            MHD_add_response_header(resp, HDR_STREAM_UP_TO_DATE, "true");
        }

        uint64_t cursor_val = ds_generate_cursor(
            server->config.cursor_epoch,
            server->config.cursor_interval_sec,
            cursor ? strtoull(cursor, NULL, 10) : 0);
        char cursor_str[32];
        snprintf(cursor_str, sizeof(cursor_str), "%lu", cursor_val);
        MHD_add_response_header(resp, HDR_STREAM_CURSOR, cursor_str);

        if (fs->content_type[0]) {
            MHD_add_response_header(resp, "Content-Type", fs->content_type);
        }

        if (result.stream_closed && result.up_to_date) {
            MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
        }

        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_OK, resp);
        MHD_destroy_response(resp);
        ds_buffer_free(&result.data);
        return ret;
    }

    /* Catch-up read */
    ds_read_result_t result = ds_store_read(server->store, path, effective_offset);

    struct MHD_Response *resp = MHD_create_response_from_buffer(
        result.data.len, result.data.data, MHD_RESPMEM_MUST_COPY);
    add_common_headers(resp);
    MHD_add_response_header(resp, HDR_STREAM_OFFSET, result.next_offset);

    if (result.up_to_date) {
        MHD_add_response_header(resp, HDR_STREAM_UP_TO_DATE, "true");
    }

    if (fs->content_type[0]) {
        MHD_add_response_header(resp, "Content-Type", fs->content_type);
    }

    bool at_tail = strcmp(result.next_offset, fs->current_offset) == 0;
    if (result.stream_closed && at_tail && result.up_to_date) {
        MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
    }

    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_OK, resp);
    MHD_destroy_response(resp);
    ds_buffer_free(&result.data);
    return ret;
}

/* Handle POST - append */
static enum MHD_Result handle_post_fast(ds_server_t *server, struct MHD_Connection *conn,
                                         const char *path, const uint8_t *body, size_t body_len) {
    const char *content_type = get_header(conn, "Content-Type");
    const char *seq = get_header(conn, "Stream-Seq");
    const char *closed_str = get_header(conn, HDR_STREAM_CLOSED);
    const char *producer_id = get_header(conn, HDR_PRODUCER_ID);
    const char *producer_epoch_str = get_header(conn, HDR_PRODUCER_EPOCH);
    const char *producer_seq_str = get_header(conn, HDR_PRODUCER_SEQ);

    bool close_stream = closed_str && (closed_str[0] == 't' || closed_str[0] == 'T');

    /* Validate producer headers */
    bool has_some = producer_id || producer_epoch_str || producer_seq_str;
    bool has_all = producer_id && producer_epoch_str && producer_seq_str;

    if (UNLIKELY(has_some && !has_all)) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            46, (void *)RESP_PRODUCER_INCOMPLETE, MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    if (UNLIKELY(has_all && !producer_id[0])) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            38, (void *)RESP_PRODUCER_ID_EMPTY, MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    int64_t producer_epoch = has_all ? parse_int_header_fast(producer_epoch_str) : -1;
    int64_t producer_seq = has_all ? parse_int_header_fast(producer_seq_str) : -1;

    if (UNLIKELY(has_all && (producer_epoch < 0 || producer_seq < 0))) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            39, (void *)RESP_PRODUCER_INVALID, MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Handle close-only request */
    if (body_len == 0 && close_stream) {
        char final_offset[DS_MAX_OFFSET_LEN];
        bool already_closed;

        if (has_all) {
            ds_producer_result_t prod_result;
            bool found = ds_store_close_stream_with_producer(
                server->store, path, producer_id,
                (uint64_t)producer_epoch, (uint64_t)producer_seq,
                final_offset, &already_closed, &prod_result);

            if (!found) {
                struct MHD_Response *resp = MHD_create_response_from_buffer(
                    16, (void *)RESP_STREAM_NOT_FOUND, MHD_RESPMEM_PERSISTENT);
                add_common_headers(resp);
                MHD_add_response_header(resp, "Content-Type", "text/plain");
                enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_FOUND, resp);
                MHD_destroy_response(resp);
                return ret;
            }

            struct MHD_Response *resp;
            int status = MHD_HTTP_NO_CONTENT;
            char epoch_str[32], seq_str[32];

            switch (prod_result.status) {
                case DS_PRODUCER_DUPLICATE:
                    resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
                    MHD_add_response_header(resp, HDR_STREAM_OFFSET, final_offset);
                    MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
                    snprintf(epoch_str, sizeof(epoch_str), "%ld", producer_epoch);
                    snprintf(seq_str, sizeof(seq_str), "%lu", prod_result.last_seq);
                    MHD_add_response_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                    MHD_add_response_header(resp, HDR_PRODUCER_SEQ, seq_str);
                    break;

                case DS_PRODUCER_STALE_EPOCH:
                    resp = MHD_create_response_from_buffer(
                        20, (void *)RESP_STALE_EPOCH, MHD_RESPMEM_PERSISTENT);
                    MHD_add_response_header(resp, "Content-Type", "text/plain");
                    snprintf(epoch_str, sizeof(epoch_str), "%lu", prod_result.current_epoch);
                    MHD_add_response_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                    status = MHD_HTTP_FORBIDDEN;
                    break;

                case DS_PRODUCER_INVALID_EPOCH_SEQ:
                    resp = MHD_create_response_from_buffer(
                        36, (void *)RESP_EPOCH_SEQ_ZERO, MHD_RESPMEM_PERSISTENT);
                    MHD_add_response_header(resp, "Content-Type", "text/plain");
                    status = MHD_HTTP_BAD_REQUEST;
                    break;

                case DS_PRODUCER_SEQUENCE_GAP:
                    resp = MHD_create_response_from_buffer(
                        21, (void *)RESP_SEQ_GAP, MHD_RESPMEM_PERSISTENT);
                    MHD_add_response_header(resp, "Content-Type", "text/plain");
                    snprintf(epoch_str, sizeof(epoch_str), "%lu", prod_result.expected_seq);
                    snprintf(seq_str, sizeof(seq_str), "%lu", prod_result.received_seq);
                    MHD_add_response_header(resp, HDR_PRODUCER_EXPECTED_SEQ, epoch_str);
                    MHD_add_response_header(resp, HDR_PRODUCER_RECEIVED_SEQ, seq_str);
                    status = MHD_HTTP_CONFLICT;
                    break;

                case DS_PRODUCER_STREAM_CLOSED:
                    resp = MHD_create_response_from_buffer(
                        16, (void *)RESP_STREAM_CLOSED, MHD_RESPMEM_PERSISTENT);
                    MHD_add_response_header(resp, "Content-Type", "text/plain");
                    MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
                    MHD_add_response_header(resp, HDR_STREAM_OFFSET, final_offset);
                    status = MHD_HTTP_CONFLICT;
                    break;

                case DS_PRODUCER_ACCEPTED:
                default:
                    resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
                    MHD_add_response_header(resp, HDR_STREAM_OFFSET, final_offset);
                    MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
                    snprintf(epoch_str, sizeof(epoch_str), "%ld", producer_epoch);
                    snprintf(seq_str, sizeof(seq_str), "%ld", producer_seq);
                    MHD_add_response_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                    MHD_add_response_header(resp, HDR_PRODUCER_SEQ, seq_str);
                    break;
            }

            add_common_headers(resp);
            enum MHD_Result ret = MHD_queue_response(conn, status, resp);
            MHD_destroy_response(resp);
            return ret;
        } else {
            bool found = ds_store_close_stream(server->store, path, final_offset, &already_closed);

            if (!found) {
                struct MHD_Response *resp = MHD_create_response_from_buffer(
                    16, (void *)RESP_STREAM_NOT_FOUND, MHD_RESPMEM_PERSISTENT);
                add_common_headers(resp);
                MHD_add_response_header(resp, "Content-Type", "text/plain");
                enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_FOUND, resp);
                MHD_destroy_response(resp);
                return ret;
            }

            struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
            add_common_headers(resp);
            MHD_add_response_header(resp, HDR_STREAM_OFFSET, final_offset);
            MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NO_CONTENT, resp);
            MHD_destroy_response(resp);
            return ret;
        }
    }

    /* Empty body without Stream-Closed is error */
    if (UNLIKELY(body_len == 0)) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            10, (void *)RESP_EMPTY_BODY, MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Content-Type required for non-empty body */
    if (UNLIKELY(!content_type || !*content_type)) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            31, (void *)RESP_CT_REQUIRED, MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Build append options */
    ds_append_options_t options = {0};
    options.seq = seq;
    options.content_type = content_type;
    options.producer_id = has_all ? producer_id : NULL;
    options.producer_epoch = producer_epoch;
    options.producer_seq = producer_seq;
    options.close = close_stream;

    /* Append */
    ds_append_result_t result = ds_store_append(server->store, path, body, body_len, &options);

    if (UNLIKELY(result.error[0])) {
        int status = MHD_HTTP_BAD_REQUEST;
        if (strstr(result.error, "not found")) {
            status = MHD_HTTP_NOT_FOUND;
        } else if (strstr(result.error, "mismatch") || strstr(result.error, "conflict") ||
                   strstr(result.error, "closed")) {
            status = MHD_HTTP_CONFLICT;
        }

        struct MHD_Response *resp = MHD_create_response_from_buffer(
            strlen(result.error), result.error, MHD_RESPMEM_MUST_COPY);
        add_common_headers(resp);
        MHD_add_response_header(resp, "Content-Type", "text/plain");

        if (result.stream_closed) {
            MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
            MHD_add_response_header(resp, HDR_STREAM_OFFSET, result.offset);
        }

        enum MHD_Result ret = MHD_queue_response(conn, status, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Handle producer result */
    if (has_all) {
        struct MHD_Response *resp;
        int status;
        char epoch_str[32], seq_str[32];

        switch (result.producer_result.status) {
            case DS_PRODUCER_DUPLICATE:
                resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
                snprintf(epoch_str, sizeof(epoch_str), "%ld", producer_epoch);
                snprintf(seq_str, sizeof(seq_str), "%lu", result.producer_result.last_seq);
                MHD_add_response_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                MHD_add_response_header(resp, HDR_PRODUCER_SEQ, seq_str);
                if (result.stream_closed) {
                    MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
                }
                status = MHD_HTTP_NO_CONTENT;
                break;

            case DS_PRODUCER_STALE_EPOCH:
                resp = MHD_create_response_from_buffer(
                    20, (void *)RESP_STALE_EPOCH, MHD_RESPMEM_PERSISTENT);
                MHD_add_response_header(resp, "Content-Type", "text/plain");
                snprintf(epoch_str, sizeof(epoch_str), "%lu", result.producer_result.current_epoch);
                MHD_add_response_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                status = MHD_HTTP_FORBIDDEN;
                break;

            case DS_PRODUCER_INVALID_EPOCH_SEQ:
                resp = MHD_create_response_from_buffer(
                    36, (void *)RESP_EPOCH_SEQ_ZERO, MHD_RESPMEM_PERSISTENT);
                MHD_add_response_header(resp, "Content-Type", "text/plain");
                status = MHD_HTTP_BAD_REQUEST;
                break;

            case DS_PRODUCER_SEQUENCE_GAP:
                resp = MHD_create_response_from_buffer(
                    21, (void *)RESP_SEQ_GAP, MHD_RESPMEM_PERSISTENT);
                MHD_add_response_header(resp, "Content-Type", "text/plain");
                snprintf(epoch_str, sizeof(epoch_str), "%lu", result.producer_result.expected_seq);
                snprintf(seq_str, sizeof(seq_str), "%lu", result.producer_result.received_seq);
                MHD_add_response_header(resp, HDR_PRODUCER_EXPECTED_SEQ, epoch_str);
                MHD_add_response_header(resp, HDR_PRODUCER_RECEIVED_SEQ, seq_str);
                status = MHD_HTTP_CONFLICT;
                break;

            case DS_PRODUCER_ACCEPTED:
            default:
                resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
                MHD_add_response_header(resp, HDR_STREAM_OFFSET, result.offset);
                snprintf(epoch_str, sizeof(epoch_str), "%ld", producer_epoch);
                snprintf(seq_str, sizeof(seq_str), "%ld", producer_seq);
                MHD_add_response_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                MHD_add_response_header(resp, HDR_PRODUCER_SEQ, seq_str);
                if (result.stream_closed) {
                    MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
                }
                status = MHD_HTTP_OK;
                break;
        }

        add_common_headers(resp);
        enum MHD_Result ret = MHD_queue_response(conn, status, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Success without producer headers */
    struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
    add_common_headers(resp);
    MHD_add_response_header(resp, HDR_STREAM_OFFSET, result.offset);

    if (result.stream_closed) {
        MHD_add_response_header(resp, HDR_STREAM_CLOSED, "true");
    }

    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NO_CONTENT, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* Main request handler - ultra optimized */
static enum MHD_Result request_handler_fast(
    void *cls,
    struct MHD_Connection *conn,
    const char *url,
    const char *method,
    const char *version,
    const char *upload_data,
    size_t *upload_data_size,
    void **con_cls
) {
    (void)version;
    ds_server_t *server = (ds_server_t *)cls;

    /* Create context on first call */
    if (*con_cls == NULL) {
        request_ctx_t *ctx = aligned_alloc(CACHE_LINE_SIZE, sizeof(request_ctx_t));
        if (UNLIKELY(!ctx)) return MHD_NO;

        ds_buffer_init(&ctx->body);
        ctx->server = server;
        ctx->method = fast_parse_method(method);
        *con_cls = ctx;
        return MHD_YES;
    }

    request_ctx_t *ctx = (request_ctx_t *)*con_cls;

    /* Accumulate upload data */
    if (*upload_data_size > 0) {
        if (UNLIKELY(ds_buffer_append(&ctx->body, upload_data, *upload_data_size) != 0)) {
            return MHD_NO;
        }
        *upload_data_size = 0;
        return MHD_YES;
    }

    /* Request complete - dispatch based on pre-parsed method */
    switch (ctx->method) {
        case HTTP_GET:
            return handle_get_fast(server, conn, url);
        case HTTP_POST:
            return handle_post_fast(server, conn, url, ctx->body.data, ctx->body.len);
        case HTTP_PUT:
            return handle_put_fast(server, conn, url, ctx->body.data, ctx->body.len);
        case HTTP_DELETE:
            return handle_delete_fast(server, conn, url);
        case HTTP_HEAD:
            return handle_head_fast(server, conn, url);
        case HTTP_OPTIONS:
            return handle_options_fast(conn);
        default: {
            struct MHD_Response *resp = MHD_create_response_from_buffer(
                18, "Method not allowed", MHD_RESPMEM_PERSISTENT);
            add_common_headers(resp);
            MHD_add_response_header(resp, "Content-Type", "text/plain");
            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_METHOD_NOT_ALLOWED, resp);
            MHD_destroy_response(resp);
            return ret;
        }
    }
}

/* Request completed callback */
static void request_completed_fast(
    void *cls,
    struct MHD_Connection *conn,
    void **con_cls,
    enum MHD_RequestTerminationCode toe
) {
    (void)cls;
    (void)conn;
    (void)toe;

    if (*con_cls) {
        request_ctx_t *ctx = (request_ctx_t *)*con_cls;
        ds_buffer_free(&ctx->body);
        free(ctx);
        *con_cls = NULL;
    }
}

/* Declare time cache functions */
void ds_time_cache_start(void);
void ds_time_cache_stop(void);

/* Create server with epoll */
ds_server_t *ds_server_create(const ds_server_config_t *config) {
    /* Initialize time cache */
    ds_time_cache_start();

    /* Initialize pre-allocated responses */
    init_responses();

    ds_server_t *server = aligned_alloc(CACHE_LINE_SIZE, sizeof(ds_server_t));
    if (!server) return NULL;
    memset(server, 0, sizeof(*server));

    if (config) {
        server->config = *config;
    } else {
        ds_config_init(&server->config);
    }

    /* Create store */
    server->store = ds_store_create(0);
    if (!server->store) {
        free(server);
        return NULL;
    }

    /* Use epoll with internal thread pool for maximum performance */
    unsigned int flags = MHD_USE_EPOLL_INTERNAL_THREAD | MHD_USE_TURBO |
                         MHD_USE_TCP_FASTOPEN;

    server->daemon = MHD_start_daemon(
        flags,
        server->config.port,
        NULL, NULL,
        request_handler_fast, server,
        MHD_OPTION_NOTIFY_COMPLETED, request_completed_fast, NULL,
        MHD_OPTION_CONNECTION_TIMEOUT, (unsigned int)60,
        MHD_OPTION_THREAD_POOL_SIZE, (unsigned int)16,  /* 16 worker threads */
        MHD_OPTION_CONNECTION_LIMIT, (unsigned int)65536,
        MHD_OPTION_PER_IP_CONNECTION_LIMIT, (unsigned int)0,  /* No per-IP limit */
        MHD_OPTION_LISTEN_BACKLOG_SIZE, (unsigned int)8192,
        MHD_OPTION_END
    );

    if (!server->daemon) {
        /* Fallback to thread-per-connection if epoll not available */
        server->daemon = MHD_start_daemon(
            MHD_USE_SELECT_INTERNALLY | MHD_USE_THREAD_PER_CONNECTION,
            server->config.port,
            NULL, NULL,
            request_handler_fast, server,
            MHD_OPTION_NOTIFY_COMPLETED, request_completed_fast, NULL,
            MHD_OPTION_CONNECTION_TIMEOUT, (unsigned int)300,
            MHD_OPTION_END
        );
    }

    if (!server->daemon) {
        ds_store_destroy(server->store);
        free(server);
        return NULL;
    }

    server->running = true;
    return server;
}

void ds_server_destroy(ds_server_t *server) {
    if (!server) return;

    server->running = false;

    if (server->daemon) {
        MHD_stop_daemon(server->daemon);
    }

    if (server->store) {
        ds_store_destroy(server->store);
    }

    ds_time_cache_stop();

    free(server);
}

ds_store_t *ds_server_get_store(ds_server_t *server) {
    return server ? server->store : NULL;
}

void ds_server_clear(ds_server_t *server) {
    if (server && server->store) {
        ds_store_clear(server->store);
    }
}

uint16_t ds_server_get_port(ds_server_t *server) {
    return server ? server->config.port : 0;
}
