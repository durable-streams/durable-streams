/**
 * Durable Streams Server - HTTP Server Implementation
 *
 * High-performance HTTP server using libmicrohttpd.
 */

#include "ds_server.h"
#include <microhttpd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

/* Protocol headers */
#define HDR_STREAM_OFFSET "Stream-Next-Offset"
#define HDR_STREAM_CURSOR "Stream-Cursor"
#define HDR_STREAM_UP_TO_DATE "Stream-Up-To-Date"
#define HDR_STREAM_SEQ "Stream-Seq"
#define HDR_STREAM_TTL "Stream-TTL"
#define HDR_STREAM_EXPIRES_AT "Stream-Expires-At"
#define HDR_STREAM_CLOSED "Stream-Closed"
#define HDR_STREAM_SSE_ENCODING "Stream-SSE-Data-Encoding"

/* Producer headers */
#define HDR_PRODUCER_ID "Producer-Id"
#define HDR_PRODUCER_EPOCH "Producer-Epoch"
#define HDR_PRODUCER_SEQ "Producer-Seq"
#define HDR_PRODUCER_EXPECTED_SEQ "Producer-Expected-Seq"
#define HDR_PRODUCER_RECEIVED_SEQ "Producer-Received-Seq"

/* Query parameters */
#define PARAM_OFFSET "offset"
#define PARAM_LIVE "live"
#define PARAM_CURSOR "cursor"

/* Request context for accumulating POST data */
typedef struct request_ctx {
    ds_buffer_t body;
    ds_server_t *server;
} request_ctx_t;

/* SSE context for streaming */
typedef struct sse_ctx {
    ds_server_t *server;
    char path[DS_MAX_PATH_LEN];
    char offset[DS_MAX_OFFSET_LEN];
    char cursor[DS_MAX_OFFSET_LEN];
    bool use_base64;
    bool closed;
} sse_ctx_t;

/* Helper to get header value (case-insensitive) */
static const char *get_header(struct MHD_Connection *conn, const char *name) {
    return MHD_lookup_connection_value(conn, MHD_HEADER_KIND, name);
}

/* Helper to get query parameter */
static const char *get_param(struct MHD_Connection *conn, const char *name) {
    return MHD_lookup_connection_value(conn, MHD_GET_ARGUMENT_KIND, name);
}

/* Add response header */
static void add_header(struct MHD_Response *resp, const char *name, const char *value) {
    MHD_add_response_header(resp, name, value);
}

/* Add common headers to response */
static void add_common_headers(struct MHD_Response *resp) {
    add_header(resp, "Access-Control-Allow-Origin", "*");
    add_header(resp, "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
    add_header(resp, "Access-Control-Allow-Headers",
               "Content-Type, Authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, "
               "Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq");
    add_header(resp, "Access-Control-Expose-Headers",
               "Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, "
               "Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, "
               "ETag, Content-Type, Content-Encoding, Vary");
    add_header(resp, "X-Content-Type-Options", "nosniff");
    add_header(resp, "Cross-Origin-Resource-Policy", "cross-origin");
}

/* Parse integer header value, returns -1 if not present or invalid */
static int64_t parse_int_header(const char *value) {
    if (!value || !*value) {
        return -1;
    }
    char *end;
    int64_t result = strtoll(value, &end, 10);
    if (*end != '\0') {
        return -1;
    }
    return result;
}

/* Validate TTL format (strict: positive integer, no leading zeros except "0") */
static bool validate_ttl(const char *ttl) {
    if (!ttl || !*ttl) {
        return false;
    }
    if (ttl[0] == '0') {
        return ttl[1] == '\0'; /* Only "0" is valid starting with 0 */
    }
    for (const char *p = ttl; *p; p++) {
        if (!isdigit((unsigned char)*p)) {
            return false;
        }
    }
    return true;
}

/* Generate ETag */
static void generate_etag(char *buf, size_t buf_len, const char *path,
                          const char *start_offset, const char *end_offset, bool closed) {
    /* Simple ETag: base64(path):start:end[:c] */
    /* For simplicity, we use the path directly (should be base64 in production) */
    if (closed) {
        snprintf(buf, buf_len, "\"%s:%s:%s:c\"", path, start_offset, end_offset);
    } else {
        snprintf(buf, buf_len, "\"%s:%s:%s\"", path, start_offset, end_offset);
    }
}

/* Handle OPTIONS (CORS preflight) */
static enum MHD_Result handle_options(struct MHD_Connection *conn) {
    struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
    add_common_headers(resp);
    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NO_CONTENT, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* Handle PUT (create stream) */
static enum MHD_Result handle_put(ds_server_t *server, struct MHD_Connection *conn,
                                   const char *path, const uint8_t *body, size_t body_len) {
    const char *content_type = get_header(conn, "Content-Type");
    const char *ttl_str = get_header(conn, HDR_STREAM_TTL);
    const char *expires_at = get_header(conn, HDR_STREAM_EXPIRES_AT);
    const char *closed_str = get_header(conn, HDR_STREAM_CLOSED);

    /* Validate TTL */
    int64_t ttl_seconds = -1;
    if (ttl_str && *ttl_str) {
        if (!validate_ttl(ttl_str)) {
            struct MHD_Response *resp = MHD_create_response_from_buffer(
                22, "Invalid Stream-TTL value", MHD_RESPMEM_PERSISTENT);
            add_common_headers(resp);
            add_header(resp, "Content-Type", "text/plain");
            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
            MHD_destroy_response(resp);
            return ret;
        }
        ttl_seconds = atoll(ttl_str);
    }

    /* Check for conflicting TTL and Expires-At */
    if (ttl_str && *ttl_str && expires_at && *expires_at) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            47, "Cannot specify both Stream-TTL and Stream-Expires-At", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    bool closed = closed_str && strcasecmp(closed_str, "true") == 0;

    char error[256] = {0};
    ds_stream_t *stream = ds_store_create_stream(
        server->store, path, content_type, ttl_seconds, expires_at,
        body, body_len, closed, error, sizeof(error));

    if (!stream) {
        int status = MHD_HTTP_CONFLICT;
        if (strstr(error, "Memory")) {
            status = MHD_HTTP_INTERNAL_SERVER_ERROR;
        }
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            strlen(error), error, MHD_RESPMEM_MUST_COPY);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, status, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Determine if new or existing (idempotent) */
    /* Note: This is a simplification - we'd need to track "new" properly */
    int status = MHD_HTTP_CREATED;

    struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
    add_common_headers(resp);

    if (stream->content_type[0]) {
        add_header(resp, "Content-Type", stream->content_type);
    }
    add_header(resp, HDR_STREAM_OFFSET, stream->current_offset);

    if (stream->closed) {
        add_header(resp, HDR_STREAM_CLOSED, "true");
    }

    /* Location header for 201 */
    if (status == MHD_HTTP_CREATED) {
        char location[DS_MAX_PATH_LEN + 64];
        snprintf(location, sizeof(location), "http://%s:%d%s",
                 server->config.host, server->config.port, path);
        add_header(resp, "Location", location);
    }

    enum MHD_Result ret = MHD_queue_response(conn, status, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* Handle HEAD (metadata) */
static enum MHD_Result handle_head(ds_server_t *server, struct MHD_Connection *conn,
                                    const char *path) {
    ds_stream_t *stream = ds_store_get(server->store, path);
    if (!stream) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_FOUND, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
    add_common_headers(resp);

    add_header(resp, HDR_STREAM_OFFSET, stream->current_offset);
    add_header(resp, "Cache-Control", "no-store");

    if (stream->content_type[0]) {
        add_header(resp, "Content-Type", stream->content_type);
    }

    if (stream->closed) {
        add_header(resp, HDR_STREAM_CLOSED, "true");
    }

    /* ETag */
    char etag[256];
    generate_etag(etag, sizeof(etag), path, "-1", stream->current_offset, stream->closed);
    add_header(resp, "ETag", etag);

    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_OK, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* Handle DELETE */
static enum MHD_Result handle_delete(ds_server_t *server, struct MHD_Connection *conn,
                                      const char *path) {
    bool deleted = ds_store_delete(server->store, path);

    struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
    add_common_headers(resp);

    int status = deleted ? MHD_HTTP_NO_CONTENT : MHD_HTTP_NOT_FOUND;
    enum MHD_Result ret = MHD_queue_response(conn, status, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* Handle GET (read) */
static enum MHD_Result handle_get(ds_server_t *server, struct MHD_Connection *conn,
                                   const char *path) {
    ds_stream_t *stream = ds_store_get(server->store, path);
    if (!stream) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            16, "Stream not found", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_FOUND, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    const char *offset = get_param(conn, PARAM_OFFSET);
    const char *live = get_param(conn, PARAM_LIVE);
    const char *cursor = get_param(conn, PARAM_CURSOR);

    /* Validate offset */
    if (offset && *offset) {
        /* Must be "-1", "now", or valid offset format */
        if (strcmp(offset, "-1") != 0 && strcmp(offset, "now") != 0) {
            /* Check format: digits_digits */
            const char *underscore = strchr(offset, '_');
            if (!underscore || underscore == offset || !underscore[1]) {
                struct MHD_Response *resp = MHD_create_response_from_buffer(
                    21, "Invalid offset format", MHD_RESPMEM_PERSISTENT);
                add_common_headers(resp);
                add_header(resp, "Content-Type", "text/plain");
                enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
                MHD_destroy_response(resp);
                return ret;
            }
        }
    }

    /* Require offset for live modes */
    if (live && *live && (!offset || !*offset)) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            28, "Live mode requires offset parameter", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Handle SSE mode */
    if (live && strcmp(live, "sse") == 0) {
        /* SSE implementation - for now, return not implemented */
        /* A full implementation would use MHD_create_response_from_callback */
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            15, "SSE not yet implemented", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_IMPLEMENTED, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Handle offset=now */
    const char *effective_offset = offset;
    if (offset && strcmp(offset, "now") == 0) {
        effective_offset = stream->current_offset;

        if (!live || strcmp(live, "long-poll") != 0) {
            /* Catch-up mode with offset=now - return empty */
            struct MHD_Response *resp;

            /* Check if JSON mode */
            char ct_lower[DS_MAX_CONTENT_TYPE_LEN];
            strncpy(ct_lower, stream->content_type, sizeof(ct_lower) - 1);
            for (char *p = ct_lower; *p; p++) *p = tolower(*p);

            if (strstr(ct_lower, "application/json")) {
                resp = MHD_create_response_from_buffer(2, "[]", MHD_RESPMEM_PERSISTENT);
            } else {
                resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
            }

            add_common_headers(resp);
            add_header(resp, HDR_STREAM_OFFSET, stream->current_offset);
            add_header(resp, HDR_STREAM_UP_TO_DATE, "true");
            add_header(resp, "Cache-Control", "no-store");

            if (stream->content_type[0]) {
                add_header(resp, "Content-Type", stream->content_type);
            }

            if (stream->closed) {
                add_header(resp, HDR_STREAM_CLOSED, "true");
            }

            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_OK, resp);
            MHD_destroy_response(resp);
            return ret;
        }
    }

    /* Long-poll mode */
    if (live && strcmp(live, "long-poll") == 0) {
        /* Check if already at tail and stream is closed */
        bool at_tail = effective_offset && strcmp(effective_offset, stream->current_offset) == 0;

        if (stream->closed && at_tail) {
            struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
            add_common_headers(resp);
            add_header(resp, HDR_STREAM_OFFSET, stream->current_offset);
            add_header(resp, HDR_STREAM_UP_TO_DATE, "true");
            add_header(resp, HDR_STREAM_CLOSED, "true");

            /* Generate cursor */
            uint64_t cursor_val = ds_generate_cursor(
                server->config.cursor_epoch,
                server->config.cursor_interval_sec,
                cursor ? strtoull(cursor, NULL, 10) : 0);
            char cursor_str[32];
            snprintf(cursor_str, sizeof(cursor_str), "%lu", cursor_val);
            add_header(resp, HDR_STREAM_CURSOR, cursor_str);

            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NO_CONTENT, resp);
            MHD_destroy_response(resp);
            return ret;
        }

        /* Wait for messages */
        ds_read_result_t result;
        bool has_data = ds_store_wait_for_messages(
            server->store, path, effective_offset,
            server->config.long_poll_timeout_ms, &result);

        if (!has_data) {
            /* Timeout */
            struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
            add_common_headers(resp);
            add_header(resp, HDR_STREAM_OFFSET, result.next_offset);
            add_header(resp, HDR_STREAM_UP_TO_DATE, "true");

            /* Generate cursor */
            uint64_t cursor_val = ds_generate_cursor(
                server->config.cursor_epoch,
                server->config.cursor_interval_sec,
                cursor ? strtoull(cursor, NULL, 10) : 0);
            char cursor_str[32];
            snprintf(cursor_str, sizeof(cursor_str), "%lu", cursor_val);
            add_header(resp, HDR_STREAM_CURSOR, cursor_str);

            if (result.stream_closed) {
                add_header(resp, HDR_STREAM_CLOSED, "true");
            }

            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NO_CONTENT, resp);
            MHD_destroy_response(resp);
            ds_buffer_free(&result.data);
            return ret;
        }

        /* Return data */
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            result.data.len, result.data.data, MHD_RESPMEM_MUST_COPY);
        add_common_headers(resp);
        add_header(resp, HDR_STREAM_OFFSET, result.next_offset);

        if (result.up_to_date) {
            add_header(resp, HDR_STREAM_UP_TO_DATE, "true");
        }

        /* Generate cursor */
        uint64_t cursor_val = ds_generate_cursor(
            server->config.cursor_epoch,
            server->config.cursor_interval_sec,
            cursor ? strtoull(cursor, NULL, 10) : 0);
        char cursor_str[32];
        snprintf(cursor_str, sizeof(cursor_str), "%lu", cursor_val);
        add_header(resp, HDR_STREAM_CURSOR, cursor_str);

        if (stream->content_type[0]) {
            add_header(resp, "Content-Type", stream->content_type);
        }

        if (result.stream_closed && result.up_to_date) {
            add_header(resp, HDR_STREAM_CLOSED, "true");
        }

        /* ETag */
        char etag[256];
        generate_etag(etag, sizeof(etag), path,
                      effective_offset ? effective_offset : "-1",
                      result.next_offset,
                      result.stream_closed && result.up_to_date);
        add_header(resp, "ETag", etag);

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
    add_header(resp, HDR_STREAM_OFFSET, result.next_offset);

    if (result.up_to_date) {
        add_header(resp, HDR_STREAM_UP_TO_DATE, "true");
    }

    if (stream->content_type[0]) {
        add_header(resp, "Content-Type", stream->content_type);
    }

    /* Check if at tail */
    bool at_tail = strcmp(result.next_offset, stream->current_offset) == 0;
    if (result.stream_closed && at_tail && result.up_to_date) {
        add_header(resp, HDR_STREAM_CLOSED, "true");
    }

    /* ETag */
    char etag[256];
    generate_etag(etag, sizeof(etag), path,
                  effective_offset ? effective_offset : "-1",
                  result.next_offset,
                  result.stream_closed && at_tail && result.up_to_date);
    add_header(resp, "ETag", etag);

    /* Check If-None-Match */
    const char *if_none_match = get_header(conn, "If-None-Match");
    if (if_none_match && strcmp(if_none_match, etag) == 0) {
        MHD_destroy_response(resp);
        ds_buffer_free(&result.data);

        resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "ETag", etag);
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_MODIFIED, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_OK, resp);
    MHD_destroy_response(resp);
    ds_buffer_free(&result.data);
    return ret;
}

/* Handle POST (append) */
static enum MHD_Result handle_post(ds_server_t *server, struct MHD_Connection *conn,
                                    const char *path, const uint8_t *body, size_t body_len) {
    const char *content_type = get_header(conn, "Content-Type");
    const char *seq = get_header(conn, HDR_STREAM_SEQ);
    const char *closed_str = get_header(conn, HDR_STREAM_CLOSED);
    const char *producer_id = get_header(conn, HDR_PRODUCER_ID);
    const char *producer_epoch_str = get_header(conn, HDR_PRODUCER_EPOCH);
    const char *producer_seq_str = get_header(conn, HDR_PRODUCER_SEQ);

    bool close_stream = closed_str && strcasecmp(closed_str, "true") == 0;

    /* Validate producer headers - all or none */
    bool has_some = producer_id || producer_epoch_str || producer_seq_str;
    bool has_all = producer_id && producer_epoch_str && producer_seq_str;

    if (has_some && !has_all) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            67, "All producer headers must be provided together", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Validate empty producer ID */
    if (has_all && (!producer_id[0])) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            35, "Invalid Producer-Id: must not be empty", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Parse producer epoch and seq */
    int64_t producer_epoch = has_all ? parse_int_header(producer_epoch_str) : -1;
    int64_t producer_seq = has_all ? parse_int_header(producer_seq_str) : -1;

    if (has_all && (producer_epoch < 0 || producer_seq < 0)) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            45, "Invalid Producer-Epoch or Producer-Seq", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Handle close-only request (empty body with Stream-Closed: true) */
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
                    16, "Stream not found", MHD_RESPMEM_PERSISTENT);
                add_common_headers(resp);
                add_header(resp, "Content-Type", "text/plain");
                enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_FOUND, resp);
                MHD_destroy_response(resp);
                return ret;
            }

            /* Handle producer result */
            struct MHD_Response *resp;
            int status = MHD_HTTP_NO_CONTENT;
            char epoch_str[32], seq_str[32];

            switch (prod_result.status) {
                case DS_PRODUCER_DUPLICATE:
                    resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
                    add_header(resp, HDR_STREAM_OFFSET, final_offset);
                    add_header(resp, HDR_STREAM_CLOSED, "true");
                    snprintf(epoch_str, sizeof(epoch_str), "%ld", producer_epoch);
                    snprintf(seq_str, sizeof(seq_str), "%lu", prod_result.last_seq);
                    add_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                    add_header(resp, HDR_PRODUCER_SEQ, seq_str);
                    break;

                case DS_PRODUCER_STALE_EPOCH:
                    resp = MHD_create_response_from_buffer(
                        20, "Stale producer epoch", MHD_RESPMEM_PERSISTENT);
                    add_header(resp, "Content-Type", "text/plain");
                    snprintf(epoch_str, sizeof(epoch_str), "%lu", prod_result.current_epoch);
                    add_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                    status = MHD_HTTP_FORBIDDEN;
                    break;

                case DS_PRODUCER_INVALID_EPOCH_SEQ:
                    resp = MHD_create_response_from_buffer(
                        32, "New epoch must start with sequence 0", MHD_RESPMEM_PERSISTENT);
                    add_header(resp, "Content-Type", "text/plain");
                    status = MHD_HTTP_BAD_REQUEST;
                    break;

                case DS_PRODUCER_SEQUENCE_GAP:
                    resp = MHD_create_response_from_buffer(
                        21, "Producer sequence gap", MHD_RESPMEM_PERSISTENT);
                    add_header(resp, "Content-Type", "text/plain");
                    snprintf(epoch_str, sizeof(epoch_str), "%lu", prod_result.expected_seq);
                    snprintf(seq_str, sizeof(seq_str), "%lu", prod_result.received_seq);
                    add_header(resp, HDR_PRODUCER_EXPECTED_SEQ, epoch_str);
                    add_header(resp, HDR_PRODUCER_RECEIVED_SEQ, seq_str);
                    status = MHD_HTTP_CONFLICT;
                    break;

                case DS_PRODUCER_STREAM_CLOSED:
                    resp = MHD_create_response_from_buffer(
                        16, "Stream is closed", MHD_RESPMEM_PERSISTENT);
                    add_header(resp, "Content-Type", "text/plain");
                    add_header(resp, HDR_STREAM_CLOSED, "true");
                    add_header(resp, HDR_STREAM_OFFSET, final_offset);
                    status = MHD_HTTP_CONFLICT;
                    break;

                case DS_PRODUCER_ACCEPTED:
                default:
                    resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
                    add_header(resp, HDR_STREAM_OFFSET, final_offset);
                    add_header(resp, HDR_STREAM_CLOSED, "true");
                    snprintf(epoch_str, sizeof(epoch_str), "%ld", producer_epoch);
                    snprintf(seq_str, sizeof(seq_str), "%ld", producer_seq);
                    add_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                    add_header(resp, HDR_PRODUCER_SEQ, seq_str);
                    break;
            }

            add_common_headers(resp);
            enum MHD_Result ret = MHD_queue_response(conn, status, resp);
            MHD_destroy_response(resp);
            return ret;
        } else {
            /* Close without producer */
            bool found = ds_store_close_stream(server->store, path, final_offset, &already_closed);

            if (!found) {
                struct MHD_Response *resp = MHD_create_response_from_buffer(
                    16, "Stream not found", MHD_RESPMEM_PERSISTENT);
                add_common_headers(resp);
                add_header(resp, "Content-Type", "text/plain");
                enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_FOUND, resp);
                MHD_destroy_response(resp);
                return ret;
            }

            struct MHD_Response *resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
            add_common_headers(resp);
            add_header(resp, HDR_STREAM_OFFSET, final_offset);
            add_header(resp, HDR_STREAM_CLOSED, "true");
            enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NO_CONTENT, resp);
            MHD_destroy_response(resp);
            return ret;
        }
    }

    /* Empty body without Stream-Closed is error */
    if (body_len == 0) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            10, "Empty body", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_BAD_REQUEST, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Content-Type required for non-empty body */
    if (!content_type || !*content_type) {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            27, "Content-Type header is required", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
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

    if (result.error[0]) {
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
        add_header(resp, "Content-Type", "text/plain");

        if (result.stream_closed) {
            add_header(resp, HDR_STREAM_CLOSED, "true");
            add_header(resp, HDR_STREAM_OFFSET, result.offset);
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
                add_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                add_header(resp, HDR_PRODUCER_SEQ, seq_str);
                if (result.stream_closed) {
                    add_header(resp, HDR_STREAM_CLOSED, "true");
                }
                status = MHD_HTTP_NO_CONTENT;
                break;

            case DS_PRODUCER_STALE_EPOCH:
                resp = MHD_create_response_from_buffer(
                    20, "Stale producer epoch", MHD_RESPMEM_PERSISTENT);
                add_header(resp, "Content-Type", "text/plain");
                snprintf(epoch_str, sizeof(epoch_str), "%lu", result.producer_result.current_epoch);
                add_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                status = MHD_HTTP_FORBIDDEN;
                break;

            case DS_PRODUCER_INVALID_EPOCH_SEQ:
                resp = MHD_create_response_from_buffer(
                    32, "New epoch must start with sequence 0", MHD_RESPMEM_PERSISTENT);
                add_header(resp, "Content-Type", "text/plain");
                status = MHD_HTTP_BAD_REQUEST;
                break;

            case DS_PRODUCER_SEQUENCE_GAP:
                resp = MHD_create_response_from_buffer(
                    21, "Producer sequence gap", MHD_RESPMEM_PERSISTENT);
                add_header(resp, "Content-Type", "text/plain");
                snprintf(epoch_str, sizeof(epoch_str), "%lu", result.producer_result.expected_seq);
                snprintf(seq_str, sizeof(seq_str), "%lu", result.producer_result.received_seq);
                add_header(resp, HDR_PRODUCER_EXPECTED_SEQ, epoch_str);
                add_header(resp, HDR_PRODUCER_RECEIVED_SEQ, seq_str);
                status = MHD_HTTP_CONFLICT;
                break;

            case DS_PRODUCER_ACCEPTED:
            default:
                resp = MHD_create_response_from_buffer(0, "", MHD_RESPMEM_PERSISTENT);
                add_header(resp, HDR_STREAM_OFFSET, result.offset);
                snprintf(epoch_str, sizeof(epoch_str), "%ld", producer_epoch);
                snprintf(seq_str, sizeof(seq_str), "%ld", producer_seq);
                add_header(resp, HDR_PRODUCER_EPOCH, epoch_str);
                add_header(resp, HDR_PRODUCER_SEQ, seq_str);
                if (result.stream_closed) {
                    add_header(resp, HDR_STREAM_CLOSED, "true");
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
    add_header(resp, HDR_STREAM_OFFSET, result.offset);

    if (result.stream_closed) {
        add_header(resp, HDR_STREAM_CLOSED, "true");
    }

    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NO_CONTENT, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* Main request handler callback */
static enum MHD_Result request_handler(
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
        request_ctx_t *ctx = (request_ctx_t *)calloc(1, sizeof(request_ctx_t));
        if (!ctx) {
            return MHD_NO;
        }
        ds_buffer_init(&ctx->body);
        ctx->server = server;
        *con_cls = ctx;
        return MHD_YES;
    }

    request_ctx_t *ctx = (request_ctx_t *)*con_cls;

    /* Accumulate upload data */
    if (*upload_data_size > 0) {
        if (ds_buffer_append(&ctx->body, upload_data, *upload_data_size) != 0) {
            return MHD_NO;
        }
        *upload_data_size = 0;
        return MHD_YES;
    }

    /* Request complete - handle it */
    enum MHD_Result ret;

    if (strcmp(method, "OPTIONS") == 0) {
        ret = handle_options(conn);
    } else if (strcmp(method, "PUT") == 0) {
        ret = handle_put(server, conn, url, ctx->body.data, ctx->body.len);
    } else if (strcmp(method, "HEAD") == 0) {
        ret = handle_head(server, conn, url);
    } else if (strcmp(method, "GET") == 0) {
        ret = handle_get(server, conn, url);
    } else if (strcmp(method, "POST") == 0) {
        ret = handle_post(server, conn, url, ctx->body.data, ctx->body.len);
    } else if (strcmp(method, "DELETE") == 0) {
        ret = handle_delete(server, conn, url);
    } else {
        struct MHD_Response *resp = MHD_create_response_from_buffer(
            18, "Method not allowed", MHD_RESPMEM_PERSISTENT);
        add_common_headers(resp);
        add_header(resp, "Content-Type", "text/plain");
        ret = MHD_queue_response(conn, MHD_HTTP_METHOD_NOT_ALLOWED, resp);
        MHD_destroy_response(resp);
    }

    return ret;
}

/* Request completed callback - cleanup */
static void request_completed(
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

/* ============================================================================
 * Public API
 * ============================================================================ */

ds_server_t *ds_server_create(const ds_server_config_t *config) {
    ds_server_t *server = (ds_server_t *)calloc(1, sizeof(ds_server_t));
    if (!server) {
        return NULL;
    }

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

    /* Start daemon */
    server->daemon = MHD_start_daemon(
        MHD_USE_SELECT_INTERNALLY | MHD_USE_THREAD_PER_CONNECTION,
        server->config.port,
        NULL, NULL,
        request_handler, server,
        MHD_OPTION_NOTIFY_COMPLETED, request_completed, NULL,
        MHD_OPTION_CONNECTION_TIMEOUT, (unsigned int)300,
        MHD_OPTION_END
    );

    if (!server->daemon) {
        ds_store_destroy(server->store);
        free(server);
        return NULL;
    }

    server->running = true;
    return server;
}

void ds_server_destroy(ds_server_t *server) {
    if (!server) {
        return;
    }

    server->running = false;

    if (server->daemon) {
        MHD_stop_daemon(server->daemon);
    }

    if (server->store) {
        ds_store_destroy(server->store);
    }

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
