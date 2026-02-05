/**
 * Durable Streams Server - SSE Implementation
 *
 * Server-Sent Events streaming support using libmicrohttpd callbacks.
 */

#include "ds_server.h"
#include "ds_store.h"
#include <microhttpd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <unistd.h>
#include <pthread.h>

/* Base64 encoding table */
static const char base64_table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* Base64 encode data */
static size_t base64_encode(const uint8_t *input, size_t input_len, char *output) {
    size_t i, j;
    size_t output_len = 0;

    for (i = 0, j = 0; i < input_len;) {
        uint32_t octet_a = i < input_len ? input[i++] : 0;
        uint32_t octet_b = i < input_len ? input[i++] : 0;
        uint32_t octet_c = i < input_len ? input[i++] : 0;

        uint32_t triple = (octet_a << 16) + (octet_b << 8) + octet_c;

        output[j++] = base64_table[(triple >> 18) & 0x3F];
        output[j++] = base64_table[(triple >> 12) & 0x3F];
        output[j++] = base64_table[(triple >> 6) & 0x3F];
        output[j++] = base64_table[triple & 0x3F];
    }

    output_len = j;

    /* Add padding */
    int mod = input_len % 3;
    if (mod > 0) {
        output[j - 1] = '=';
        if (mod == 1) {
            output[j - 2] = '=';
        }
    }

    output[j] = '\0';
    return output_len;
}

/* SSE context for streaming */
typedef struct sse_context {
    ds_server_t *server;
    char path[DS_MAX_PATH_LEN];
    char current_offset[DS_MAX_OFFSET_LEN];
    uint64_t client_cursor;
    bool use_base64;
    bool is_json;
    bool finished;
    bool first_chunk;
    pthread_mutex_t lock;
    ds_buffer_t pending_data;
    size_t pending_offset;
} sse_context_t;

/* Format SSE data event - handle multiline content */
static int format_sse_data(ds_buffer_t *out, const char *payload, size_t payload_len) {
    ds_buffer_clear(out);

    /* Write event type */
    if (ds_buffer_append_str(out, "event: data\n") != 0) {
        return -1;
    }

    /* Split payload by lines and prefix each with "data:" */
    const char *start = payload;
    const char *end = payload + payload_len;

    while (start < end) {
        /* Find next newline */
        const char *nl = start;
        while (nl < end && *nl != '\n' && *nl != '\r') {
            nl++;
        }

        /* Write data line */
        if (ds_buffer_append_str(out, "data:") != 0) {
            return -1;
        }
        if (nl > start) {
            if (ds_buffer_append(out, start, nl - start) != 0) {
                return -1;
            }
        }
        if (ds_buffer_append_str(out, "\n") != 0) {
            return -1;
        }

        /* Skip past newline(s) */
        if (nl < end) {
            if (*nl == '\r' && nl + 1 < end && nl[1] == '\n') {
                nl += 2;
            } else {
                nl++;
            }
        }
        start = nl;
    }

    /* Empty line to end event */
    if (ds_buffer_append_str(out, "\n") != 0) {
        return -1;
    }

    return 0;
}

/* Format SSE control event */
static int format_sse_control(ds_buffer_t *out, const char *offset, uint64_t cursor,
                               bool up_to_date, bool stream_closed) {
    ds_buffer_clear(out);

    if (ds_buffer_append_str(out, "event: control\ndata: {") != 0) {
        return -1;
    }

    char buf[256];
    snprintf(buf, sizeof(buf), "\"streamNextOffset\":\"%s\"", offset);
    if (ds_buffer_append_str(out, buf) != 0) {
        return -1;
    }

    if (stream_closed) {
        if (ds_buffer_append_str(out, ",\"streamClosed\":true") != 0) {
            return -1;
        }
    } else {
        snprintf(buf, sizeof(buf), ",\"streamCursor\":\"%lu\"", cursor);
        if (ds_buffer_append_str(out, buf) != 0) {
            return -1;
        }
        if (up_to_date) {
            if (ds_buffer_append_str(out, ",\"upToDate\":true") != 0) {
                return -1;
            }
        }
    }

    if (ds_buffer_append_str(out, "}\n\n") != 0) {
        return -1;
    }

    return 0;
}

/* SSE content reader callback for MHD */
static ssize_t sse_content_reader(void *cls, uint64_t pos, char *buf, size_t max) {
    sse_context_t *ctx = (sse_context_t *)cls;

    (void)pos;

    pthread_mutex_lock(&ctx->lock);

    /* Check if we have pending data to send */
    if (ctx->pending_data.len > ctx->pending_offset) {
        size_t available = ctx->pending_data.len - ctx->pending_offset;
        size_t to_send = available < max ? available : max;
        memcpy(buf, ctx->pending_data.data + ctx->pending_offset, to_send);
        ctx->pending_offset += to_send;
        pthread_mutex_unlock(&ctx->lock);
        return (ssize_t)to_send;
    }

    /* Clear pending data */
    ds_buffer_clear(&ctx->pending_data);
    ctx->pending_offset = 0;

    if (ctx->finished) {
        pthread_mutex_unlock(&ctx->lock);
        return MHD_CONTENT_READER_END_OF_STREAM;
    }

    pthread_mutex_unlock(&ctx->lock);

    /* Get stream and check for new data */
    ds_stream_t *stream = ds_store_get(ctx->server->store, ctx->path);
    if (!stream) {
        return MHD_CONTENT_READER_END_OF_STREAM;
    }

    /* Read new messages */
    ds_read_result_t result = ds_store_read(ctx->server->store, ctx->path, ctx->current_offset);

    pthread_mutex_lock(&ctx->lock);

    /* Format data events for each message */
    if (result.data.len > 0 && !ctx->is_json) {
        /* For non-JSON, send the raw data (base64 encoded if binary) */
        ds_buffer_t event;
        ds_buffer_init(&event);

        if (ctx->use_base64) {
            /* Base64 encode */
            size_t encoded_len = ((result.data.len + 2) / 3) * 4 + 1;
            char *encoded = (char *)malloc(encoded_len);
            if (encoded) {
                base64_encode(result.data.data, result.data.len, encoded);
                format_sse_data(&event, encoded, strlen(encoded));
                free(encoded);
            }
        } else {
            format_sse_data(&event, (const char *)result.data.data, result.data.len);
        }

        ds_buffer_append(&ctx->pending_data, event.data, event.len);
        ds_buffer_free(&event);
    } else if (result.data.len > 0 && ctx->is_json) {
        /* For JSON mode, the data is already formatted */
        ds_buffer_t event;
        ds_buffer_init(&event);
        format_sse_data(&event, (const char *)result.data.data, result.data.len);
        ds_buffer_append(&ctx->pending_data, event.data, event.len);
        ds_buffer_free(&event);
    }

    /* Update current offset */
    strncpy(ctx->current_offset, result.next_offset, sizeof(ctx->current_offset) - 1);

    /* Generate cursor */
    uint64_t cursor = ds_generate_cursor(
        ctx->server->config.cursor_epoch,
        ctx->server->config.cursor_interval_sec,
        ctx->client_cursor);

    /* Check if at tail */
    bool at_tail = strcmp(result.next_offset, stream->current_offset) == 0;
    bool stream_closed = stream->closed && at_tail;

    /* Send control event */
    ds_buffer_t control;
    ds_buffer_init(&control);
    format_sse_control(&control, result.next_offset, cursor, result.up_to_date, stream_closed);
    ds_buffer_append(&ctx->pending_data, control.data, control.len);
    ds_buffer_free(&control);

    if (stream_closed) {
        ctx->finished = true;
    }

    ds_buffer_free(&result.data);

    /* If we have data to send, return some of it */
    if (ctx->pending_data.len > 0) {
        size_t to_send = ctx->pending_data.len < max ? ctx->pending_data.len : max;
        memcpy(buf, ctx->pending_data.data, to_send);
        ctx->pending_offset = to_send;
        pthread_mutex_unlock(&ctx->lock);
        return (ssize_t)to_send;
    }

    pthread_mutex_unlock(&ctx->lock);

    /* If no new data and stream is open, wait and try again */
    if (!ctx->finished) {
        /* Wait for new messages */
        ds_read_result_t wait_result;
        bool has_data = ds_store_wait_for_messages(
            ctx->server->store, ctx->path, ctx->current_offset,
            ctx->server->config.long_poll_timeout_ms, &wait_result);

        if (has_data && wait_result.data.len > 0) {
            pthread_mutex_lock(&ctx->lock);

            /* Format and queue the new data */
            ds_buffer_t event;
            ds_buffer_init(&event);

            if (ctx->use_base64) {
                size_t encoded_len = ((wait_result.data.len + 2) / 3) * 4 + 1;
                char *encoded = (char *)malloc(encoded_len);
                if (encoded) {
                    base64_encode(wait_result.data.data, wait_result.data.len, encoded);
                    format_sse_data(&event, encoded, strlen(encoded));
                    free(encoded);
                }
            } else if (ctx->is_json) {
                format_sse_data(&event, (const char *)wait_result.data.data, wait_result.data.len);
            } else {
                format_sse_data(&event, (const char *)wait_result.data.data, wait_result.data.len);
            }

            ds_buffer_append(&ctx->pending_data, event.data, event.len);
            ds_buffer_free(&event);

            strncpy(ctx->current_offset, wait_result.next_offset, sizeof(ctx->current_offset) - 1);

            /* Send control event */
            ds_buffer_t ctrl;
            ds_buffer_init(&ctrl);

            uint64_t c = ds_generate_cursor(
                ctx->server->config.cursor_epoch,
                ctx->server->config.cursor_interval_sec,
                ctx->client_cursor);

            ds_stream_t *s = ds_store_get(ctx->server->store, ctx->path);
            bool closed = s && s->closed && strcmp(wait_result.next_offset, s->current_offset) == 0;

            format_sse_control(&ctrl, wait_result.next_offset, c, wait_result.up_to_date, closed);
            ds_buffer_append(&ctx->pending_data, ctrl.data, ctrl.len);
            ds_buffer_free(&ctrl);

            if (closed) {
                ctx->finished = true;
            }

            if (ctx->pending_data.len > 0) {
                size_t to_send = ctx->pending_data.len < max ? ctx->pending_data.len : max;
                memcpy(buf, ctx->pending_data.data, to_send);
                ctx->pending_offset = to_send;
                pthread_mutex_unlock(&ctx->lock);
                ds_buffer_free(&wait_result.data);
                return (ssize_t)to_send;
            }

            pthread_mutex_unlock(&ctx->lock);
        } else if (wait_result.stream_closed) {
            /* Stream was closed during wait */
            pthread_mutex_lock(&ctx->lock);

            ds_buffer_t ctrl;
            ds_buffer_init(&ctrl);
            format_sse_control(&ctrl, wait_result.next_offset, 0, true, true);
            ds_buffer_append(&ctx->pending_data, ctrl.data, ctrl.len);
            ds_buffer_free(&ctrl);

            ctx->finished = true;

            if (ctx->pending_data.len > 0) {
                size_t to_send = ctx->pending_data.len < max ? ctx->pending_data.len : max;
                memcpy(buf, ctx->pending_data.data, to_send);
                ctx->pending_offset = to_send;
                pthread_mutex_unlock(&ctx->lock);
                ds_buffer_free(&wait_result.data);
                return (ssize_t)to_send;
            }

            pthread_mutex_unlock(&ctx->lock);
        }

        ds_buffer_free(&wait_result.data);
    }

    return ctx->finished ? MHD_CONTENT_READER_END_OF_STREAM : 0;
}

/* SSE content reader free callback */
static void sse_content_reader_free(void *cls) {
    sse_context_t *ctx = (sse_context_t *)cls;
    if (ctx) {
        pthread_mutex_destroy(&ctx->lock);
        ds_buffer_free(&ctx->pending_data);
        free(ctx);
    }
}

/* Create SSE response */
struct MHD_Response *ds_create_sse_response(
    ds_server_t *server,
    const char *path,
    const char *offset,
    const char *cursor,
    bool use_base64,
    bool is_json
) {
    sse_context_t *ctx = (sse_context_t *)calloc(1, sizeof(sse_context_t));
    if (!ctx) {
        return NULL;
    }

    ctx->server = server;
    strncpy(ctx->path, path, sizeof(ctx->path) - 1);
    strncpy(ctx->current_offset, offset, sizeof(ctx->current_offset) - 1);
    ctx->client_cursor = cursor ? strtoull(cursor, NULL, 10) : 0;
    ctx->use_base64 = use_base64;
    ctx->is_json = is_json;
    ctx->finished = false;
    ctx->first_chunk = true;
    pthread_mutex_init(&ctx->lock, NULL);
    ds_buffer_init(&ctx->pending_data);
    ctx->pending_offset = 0;

    struct MHD_Response *response = MHD_create_response_from_callback(
        MHD_SIZE_UNKNOWN,
        4096,
        sse_content_reader,
        ctx,
        sse_content_reader_free
    );

    return response;
}
