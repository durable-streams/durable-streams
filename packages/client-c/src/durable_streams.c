/**
 * Durable Streams C Client - Core Implementation
 */

#define _GNU_SOURCE /* For strdup, strndup, strncasecmp */
#include "durable_streams.h"
#include <curl/curl.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <ctype.h>
#include <time.h>
#include <strings.h> /* For strncasecmp on some systems */

/* ========== Internal Structures ========== */

struct ds_client {
    char *base_url;
    long timeout_ms;
    bool verbose;
    CURL *curl;
};

struct ds_stream {
    ds_client_t *client;
    char *path;
    char *full_url;
    char *content_type;
};

typedef struct {
    char *data;
    size_t size;
    size_t capacity;
} ds_buffer_t;

struct ds_iterator {
    ds_stream_t *stream;
    ds_live_mode_t live;
    long timeout_ms;
    char *offset;
    char *cursor;
    char **headers;
    bool up_to_date;
    bool stream_closed;
    bool done;
    int max_chunks;
    int chunk_count;
    /* SSE state */
    bool in_sse;
    CURL *curl;
    ds_buffer_t response_buffer;
    ds_buffer_t sse_buffer;
    size_t sse_parse_pos;
    bool sse_is_base64;
    /* Queued chunks for SSE */
    ds_chunk_t *queued_chunks;
    int queued_count;
    int queued_capacity;
    int queued_pos;
    /* Last HTTP status */
    int last_status;
    /* SSE retry tracking */
    int sse_retry_count;
    int sse_max_retries;
    /* Error message for last error */
    char *last_error_message;
};

struct ds_producer {
    ds_client_t *client;
    char *url;
    char *producer_id;
    char *content_type;
    int epoch;
    int seq;
    bool auto_claim;
    int max_in_flight;
    int linger_ms;
    int max_batch_bytes;
    /* Batch queue */
    ds_buffer_t batch;
    int batch_item_count;
    /* Error state */
    ds_error_t last_error;
    char *last_error_message;
};

/* ========== Forward Declarations ========== */

static size_t write_callback(void *contents, size_t size, size_t nmemb, void *userp);
static size_t header_callback(char *buffer, size_t size, size_t nitems, void *userdata);
static void buffer_init(ds_buffer_t *buf);
static void buffer_free(ds_buffer_t *buf);
static int buffer_append(ds_buffer_t *buf, const char *data, size_t len);
static char *strdup_safe(const char *s);
static char *normalize_content_type(const char *ct);
static ds_error_t parse_sse_events(ds_iterator_t *iter);
static int base64_decode(const char *in, size_t in_len, char **out, size_t *out_len);

/* ========== Utility Functions ========== */

const char *ds_error_string(ds_error_t error) {
    switch (error) {
        case DS_OK: return "Success";
        case DS_ERR_INVALID_ARGUMENT: return "Invalid argument";
        case DS_ERR_OUT_OF_MEMORY: return "Out of memory";
        case DS_ERR_NETWORK: return "Network error";
        case DS_ERR_HTTP: return "HTTP error";
        case DS_ERR_NOT_FOUND: return "Stream not found";
        case DS_ERR_CONFLICT: return "Conflict";
        case DS_ERR_STREAM_CLOSED: return "Stream is closed";
        case DS_ERR_INVALID_OFFSET: return "Invalid offset";
        case DS_ERR_PARSE_ERROR: return "Parse error";
        case DS_ERR_TIMEOUT: return "Timeout";
        case DS_ERR_STALE_EPOCH: return "Stale epoch";
        case DS_ERR_SEQUENCE_GAP: return "Sequence gap";
        case DS_ERR_DONE: return "No more data";
        case DS_ERR_INTERNAL: return "Internal error";
        default: return "Unknown error";
    }
}

static char *strdup_safe(const char *s) {
    if (!s) return NULL;
    size_t len = strlen(s);
    char *dup = malloc(len + 1);
    if (dup) {
        memcpy(dup, s, len + 1);
    }
    return dup;
}

/* ========== JSON Validation ========== */

static const char *skip_whitespace(const char *p, const char *end) {
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) {
        p++;
    }
    return p;
}

static const char *validate_json_value(const char *p, const char *end);

static const char *validate_json_string(const char *p, const char *end) {
    if (p >= end || *p != '"') return NULL;
    p++;
    while (p < end && *p != '"') {
        if (*p == '\\') {
            p++;
            if (p >= end) return NULL;
            if (*p == 'u') {
                /* Unicode escape \uXXXX */
                for (int i = 0; i < 4; i++) {
                    p++;
                    if (p >= end || !isxdigit((unsigned char)*p)) return NULL;
                }
            } else if (*p != '"' && *p != '\\' && *p != '/' && *p != 'b' &&
                       *p != 'f' && *p != 'n' && *p != 'r' && *p != 't') {
                return NULL;
            }
        } else if ((unsigned char)*p < 0x20) {
            /* Control characters must be escaped */
            return NULL;
        }
        p++;
    }
    if (p >= end || *p != '"') return NULL;
    return p + 1;
}

static const char *validate_json_number(const char *p, const char *end) {
    if (p >= end) return NULL;
    if (*p == '-') p++;
    if (p >= end || !isdigit((unsigned char)*p)) return NULL;
    if (*p == '0') {
        p++;
    } else {
        while (p < end && isdigit((unsigned char)*p)) p++;
    }
    if (p < end && *p == '.') {
        p++;
        if (p >= end || !isdigit((unsigned char)*p)) return NULL;
        while (p < end && isdigit((unsigned char)*p)) p++;
    }
    if (p < end && (*p == 'e' || *p == 'E')) {
        p++;
        if (p < end && (*p == '+' || *p == '-')) p++;
        if (p >= end || !isdigit((unsigned char)*p)) return NULL;
        while (p < end && isdigit((unsigned char)*p)) p++;
    }
    return p;
}

static const char *validate_json_array(const char *p, const char *end) {
    if (p >= end || *p != '[') return NULL;
    p++;
    p = skip_whitespace(p, end);
    if (p < end && *p == ']') return p + 1;

    while (1) {
        p = validate_json_value(p, end);
        if (!p) return NULL;
        p = skip_whitespace(p, end);
        if (p >= end) return NULL;
        if (*p == ']') return p + 1;
        if (*p != ',') return NULL;
        p++;
        p = skip_whitespace(p, end);
    }
}

static const char *validate_json_object(const char *p, const char *end) {
    if (p >= end || *p != '{') return NULL;
    p++;
    p = skip_whitespace(p, end);
    if (p < end && *p == '}') return p + 1;

    while (1) {
        /* Key must be a string */
        p = validate_json_string(p, end);
        if (!p) return NULL;
        p = skip_whitespace(p, end);
        if (p >= end || *p != ':') return NULL;
        p++;
        p = skip_whitespace(p, end);
        /* Value */
        p = validate_json_value(p, end);
        if (!p) return NULL;
        p = skip_whitespace(p, end);
        if (p >= end) return NULL;
        if (*p == '}') return p + 1;
        if (*p != ',') return NULL;
        p++;
        p = skip_whitespace(p, end);
    }
}

static const char *validate_json_value(const char *p, const char *end) {
    p = skip_whitespace(p, end);
    if (p >= end) return NULL;

    switch (*p) {
        case '"':
            return validate_json_string(p, end);
        case '{':
            return validate_json_object(p, end);
        case '[':
            return validate_json_array(p, end);
        case 't':
            if (end - p >= 4 && strncmp(p, "true", 4) == 0) return p + 4;
            return NULL;
        case 'f':
            if (end - p >= 5 && strncmp(p, "false", 5) == 0) return p + 5;
            return NULL;
        case 'n':
            if (end - p >= 4 && strncmp(p, "null", 4) == 0) return p + 4;
            return NULL;
        default:
            if (*p == '-' || isdigit((unsigned char)*p)) {
                return validate_json_number(p, end);
            }
            return NULL;
    }
}

/* Validate that a string is valid JSON. Returns true if valid. */
static bool validate_json(const char *data, size_t len) {
    if (!data || len == 0) return false;
    const char *end = data + len;
    const char *p = validate_json_value(data, end);
    if (!p) return false;
    p = skip_whitespace(p, end);
    return p == end;
}

/* Format error message with stream path context */
static char *format_error_with_path(const char *path, const char *message) {
    if (!path || !message) return strdup_safe(message);
    size_t len = strlen(path) + strlen(message) + 32;
    char *result = malloc(len);
    if (!result) return strdup_safe(message);
    snprintf(result, len, "%s (stream: %s)", message, path);
    return result;
}

static void buffer_init(ds_buffer_t *buf) {
    buf->data = NULL;
    buf->size = 0;
    buf->capacity = 0;
}

static void buffer_free(ds_buffer_t *buf) {
    free(buf->data);
    buf->data = NULL;
    buf->size = 0;
    buf->capacity = 0;
}

static int buffer_append(ds_buffer_t *buf, const char *data, size_t len) {
    if (buf->size + len + 1 > buf->capacity) {
        size_t new_cap = buf->capacity == 0 ? 4096 : buf->capacity * 2;
        while (new_cap < buf->size + len + 1) {
            new_cap *= 2;
        }
        char *new_data = realloc(buf->data, new_cap);
        if (!new_data) return -1;
        buf->data = new_data;
        buf->capacity = new_cap;
    }
    memcpy(buf->data + buf->size, data, len);
    buf->size += len;
    buf->data[buf->size] = '\0';
    return 0;
}

static char *normalize_content_type(const char *ct) {
    if (!ct) return NULL;
    const char *semi = strchr(ct, ';');
    size_t len = semi ? (size_t)(semi - ct) : strlen(ct);
    char *result = malloc(len + 1);
    if (!result) return NULL;
    for (size_t i = 0; i < len; i++) {
        result[i] = tolower((unsigned char)ct[i]);
    }
    /* Trim trailing whitespace */
    while (len > 0 && isspace((unsigned char)result[len - 1])) {
        len--;
    }
    result[len] = '\0';
    return result;
}

char *ds_url_encode(const char *str) {
    if (!str) return NULL;
    CURL *curl = curl_easy_init();
    if (!curl) return strdup_safe(str);
    char *encoded = curl_easy_escape(curl, str, 0);
    char *result = strdup_safe(encoded);
    curl_free(encoded);
    curl_easy_cleanup(curl);
    return result;
}

/* ========== CURL Callbacks ========== */

typedef struct {
    ds_result_t *result;
    ds_buffer_t body;
    char *content_type;
} http_response_t;

static size_t write_callback(void *contents, size_t size, size_t nmemb, void *userp) {
    size_t realsize = size * nmemb;
    ds_buffer_t *buf = (ds_buffer_t *)userp;
    if (buffer_append(buf, contents, realsize) < 0) {
        return 0;
    }
    return realsize;
}

static size_t header_callback(char *buffer, size_t size, size_t nitems, void *userdata) {
    size_t numbytes = size * nitems;
    http_response_t *resp = (http_response_t *)userdata;

    /* Parse header: "Name: Value\r\n" */
    char *colon = memchr(buffer, ':', numbytes);
    if (!colon) return numbytes;

    size_t name_len = colon - buffer;
    char *value = colon + 1;
    size_t value_len = numbytes - name_len - 1;

    /* Skip leading whitespace in value */
    while (value_len > 0 && isspace((unsigned char)*value)) {
        value++;
        value_len--;
    }
    /* Trim trailing whitespace */
    while (value_len > 0 && isspace((unsigned char)value[value_len - 1])) {
        value_len--;
    }

    /* Case-insensitive header matching */
    if (name_len == 18 && strncasecmp(buffer, "stream-next-offset", 18) == 0) {
        free(resp->result->next_offset);
        resp->result->next_offset = strndup(value, value_len);
    } else if (name_len == 17 && strncasecmp(buffer, "stream-up-to-date", 17) == 0) {
        if (value_len == 4 && strncasecmp(value, "true", 4) == 0) {
            resp->result->up_to_date = true;
        }
    } else if (name_len == 13 && strncasecmp(buffer, "stream-closed", 13) == 0) {
        if (value_len == 4 && strncasecmp(value, "true", 4) == 0) {
            resp->result->stream_closed = true;
        }
    } else if (name_len == 13 && strncasecmp(buffer, "stream-cursor", 13) == 0) {
        free(resp->result->cursor);
        resp->result->cursor = strndup(value, value_len);
    } else if (name_len == 12 && strncasecmp(buffer, "content-type", 12) == 0) {
        free(resp->content_type);
        resp->content_type = strndup(value, value_len);
    } else if (name_len == 14 && strncasecmp(buffer, "producer-epoch", 14) == 0) {
        resp->result->current_epoch = atoi(value);
    } else if (name_len == 20 && strncasecmp(buffer, "producer-expected-seq", 20) == 0) {
        resp->result->expected_seq = atoi(value);
    } else if (name_len == 20 && strncasecmp(buffer, "producer-received-seq", 20) == 0) {
        resp->result->received_seq = atoi(value);
    }

    return numbytes;
}

/* ========== Client Implementation ========== */

ds_client_t *ds_client_new(const ds_client_config_t *config) {
    if (!config || !config->base_url) return NULL;

    ds_client_t *client = calloc(1, sizeof(ds_client_t));
    if (!client) return NULL;

    client->base_url = strdup_safe(config->base_url);
    if (!client->base_url) {
        free(client);
        return NULL;
    }

    /* Remove trailing slash */
    size_t len = strlen(client->base_url);
    if (len > 0 && client->base_url[len - 1] == '/') {
        client->base_url[len - 1] = '\0';
    }

    client->timeout_ms = config->timeout_ms > 0 ? config->timeout_ms : 30000;
    client->verbose = config->verbose;

    /* Initialize libcurl globally (safe to call multiple times) */
    curl_global_init(CURL_GLOBAL_DEFAULT);

    return client;
}

void ds_client_free(ds_client_t *client) {
    if (!client) return;
    free(client->base_url);
    if (client->curl) {
        curl_easy_cleanup(client->curl);
    }
    free(client);
}

const char *ds_client_base_url(const ds_client_t *client) {
    return client ? client->base_url : NULL;
}

/* ========== Stream Implementation ========== */

ds_stream_t *ds_stream_new(ds_client_t *client, const char *path) {
    if (!client || !path) return NULL;

    ds_stream_t *stream = calloc(1, sizeof(ds_stream_t));
    if (!stream) return NULL;

    stream->client = client;
    stream->path = strdup_safe(path);
    if (!stream->path) {
        free(stream);
        return NULL;
    }

    /* Build full URL */
    size_t url_len = strlen(client->base_url) + strlen(path) + 1;
    stream->full_url = malloc(url_len);
    if (!stream->full_url) {
        free(stream->path);
        free(stream);
        return NULL;
    }
    snprintf(stream->full_url, url_len, "%s%s", client->base_url, path);

    stream->content_type = strdup_safe("application/octet-stream");

    return stream;
}

void ds_stream_free(ds_stream_t *stream) {
    if (!stream) return;
    free(stream->path);
    free(stream->full_url);
    free(stream->content_type);
    free(stream);
}

void ds_stream_set_content_type(ds_stream_t *stream, const char *content_type) {
    if (!stream) return;
    free(stream->content_type);
    stream->content_type = strdup_safe(content_type);
}

const char *ds_stream_get_content_type(const ds_stream_t *stream) {
    return stream ? stream->content_type : NULL;
}

static ds_error_t http_status_to_error(int status, bool stream_closed) {
    switch (status) {
        case 200:
        case 201:
        case 204:
            return DS_OK;
        case 400:
            return DS_ERR_INVALID_OFFSET;
        case 403:
            return DS_ERR_STALE_EPOCH;
        case 404:
            return DS_ERR_NOT_FOUND;
        case 409:
            if (stream_closed) return DS_ERR_STREAM_CLOSED;
            return DS_ERR_CONFLICT;
        case 410:
            return DS_ERR_INVALID_OFFSET;
        case 429:
            return DS_ERR_HTTP;
        default:
            return status >= 400 ? DS_ERR_HTTP : DS_OK;
    }
}

ds_error_t ds_stream_create(ds_stream_t *stream, const ds_create_options_t *options, ds_result_t *result) {
    if (!stream || !result) return DS_ERR_INVALID_ARGUMENT;

    memset(result, 0, sizeof(*result));

    CURL *curl = curl_easy_init();
    if (!curl) return DS_ERR_INTERNAL;

    http_response_t resp = {.result = result};
    buffer_init(&resp.body);

    struct curl_slist *headers = NULL;

    /* Content-Type header */
    const char *ct = options && options->content_type ? options->content_type : "application/octet-stream";
    char ct_header[256];
    snprintf(ct_header, sizeof(ct_header), "Content-Type: %s", ct);
    headers = curl_slist_append(headers, ct_header);

    /* TTL header */
    if (options && options->ttl_seconds > 0) {
        char ttl_header[64];
        snprintf(ttl_header, sizeof(ttl_header), "Stream-TTL: %d", options->ttl_seconds);
        headers = curl_slist_append(headers, ttl_header);
    }

    /* Expires-At header */
    if (options && options->expires_at) {
        char exp_header[256];
        snprintf(exp_header, sizeof(exp_header), "Stream-Expires-At: %s", options->expires_at);
        headers = curl_slist_append(headers, exp_header);
    }

    /* Stream-Closed header */
    if (options && options->closed) {
        headers = curl_slist_append(headers, "Stream-Closed: true");
    }

    /* Custom headers */
    if (options && options->headers) {
        for (const char **h = options->headers; *h; h++) {
            headers = curl_slist_append(headers, *h);
        }
    }

    curl_easy_setopt(curl, CURLOPT_URL, stream->full_url);
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &resp);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, stream->client->timeout_ms);

    /* Initial data */
    if (options && options->initial_data && options->initial_data_len > 0) {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, options->initial_data);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)options->initial_data_len);
    }

    if (stream->client->verbose) {
        curl_easy_setopt(curl, CURLOPT_VERBOSE, 1L);
    }

    CURLcode res = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    result->status_code = (int)http_code;

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    buffer_free(&resp.body);

    if (resp.content_type) {
        result->content_type = resp.content_type;
    }

    if (res != CURLE_OK) {
        result->error_message = format_error_with_path(stream->path, curl_easy_strerror(res));
        result->error_code = DS_ERR_NETWORK;
        return DS_ERR_NETWORK;
    }

    ds_error_t err = http_status_to_error((int)http_code, result->stream_closed);
    result->error_code = err;
    return err;
}

ds_error_t ds_stream_append(ds_stream_t *stream, const char *data, size_t data_len,
                            const ds_append_options_t *options, ds_result_t *result) {
    if (!stream || !data || !result) return DS_ERR_INVALID_ARGUMENT;

    memset(result, 0, sizeof(*result));

    /* Validate JSON if content type is application/json */
    char *norm_ct = normalize_content_type(stream->content_type);
    bool is_json = norm_ct && strcmp(norm_ct, "application/json") == 0;
    free(norm_ct);

    if (is_json && data_len > 0 && !validate_json(data, data_len)) {
        result->error_message = format_error_with_path(stream->path, "Invalid JSON");
        result->error_code = DS_ERR_PARSE_ERROR;
        return DS_ERR_PARSE_ERROR;
    }

    CURL *curl = curl_easy_init();
    if (!curl) return DS_ERR_INTERNAL;

    http_response_t resp = {.result = result};
    buffer_init(&resp.body);

    struct curl_slist *headers = NULL;

    /* Content-Type header */
    const char *ct = stream->content_type ? stream->content_type : "application/octet-stream";
    char ct_header[256];
    snprintf(ct_header, sizeof(ct_header), "Content-Type: %s", ct);
    headers = curl_slist_append(headers, ct_header);

    /* Stream-Seq header */
    if (options && options->seq) {
        char seq_header[64];
        snprintf(seq_header, sizeof(seq_header), "Stream-Seq: %s", options->seq);
        headers = curl_slist_append(headers, seq_header);
    }

    /* Custom headers */
    if (options && options->headers) {
        for (const char **h = options->headers; *h; h++) {
            headers = curl_slist_append(headers, *h);
        }
    }

    curl_easy_setopt(curl, CURLOPT_URL, stream->full_url);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, data);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)data_len);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &resp);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, stream->client->timeout_ms);

    if (stream->client->verbose) {
        curl_easy_setopt(curl, CURLOPT_VERBOSE, 1L);
    }

    CURLcode res = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    result->status_code = (int)http_code;

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    buffer_free(&resp.body);
    free(resp.content_type);

    if (res != CURLE_OK) {
        result->error_message = format_error_with_path(stream->path, curl_easy_strerror(res));
        result->error_code = DS_ERR_NETWORK;
        return DS_ERR_NETWORK;
    }

    ds_error_t err = http_status_to_error((int)http_code, result->stream_closed);
    /* Set error message with path context for HTTP errors */
    if (err != DS_OK) {
        const char *base_msg = (err == DS_ERR_NOT_FOUND) ? "Stream not found" : ds_error_string(err);
        result->error_message = format_error_with_path(stream->path, base_msg);
    }
    result->error_code = err;
    return err;
}

ds_error_t ds_stream_close(ds_stream_t *stream, const ds_close_options_t *options, ds_close_result_t *result) {
    if (!stream || !result) return DS_ERR_INVALID_ARGUMENT;

    memset(result, 0, sizeof(*result));

    CURL *curl = curl_easy_init();
    if (!curl) return DS_ERR_INTERNAL;

    ds_result_t http_result = {0};
    http_response_t resp = {.result = &http_result};
    buffer_init(&resp.body);

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Stream-Closed: true");

    /* Content-Type header */
    if (options && options->data && options->data_len > 0) {
        const char *ct = options->content_type ? options->content_type : stream->content_type;
        if (ct) {
            char ct_header[256];
            snprintf(ct_header, sizeof(ct_header), "Content-Type: %s", ct);
            headers = curl_slist_append(headers, ct_header);
        }
    }

    curl_easy_setopt(curl, CURLOPT_URL, stream->full_url);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);

    if (options && options->data && options->data_len > 0) {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, options->data);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)options->data_len);
    } else {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, "");
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, 0L);
    }

    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &resp);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, stream->client->timeout_ms);

    CURLcode res = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    buffer_free(&resp.body);
    free(resp.content_type);

    if (res != CURLE_OK) {
        ds_result_cleanup(&http_result);
        return DS_ERR_NETWORK;
    }

    result->final_offset = http_result.next_offset;
    result->stream_closed = http_result.stream_closed;
    http_result.next_offset = NULL; /* Transfer ownership */

    ds_result_cleanup(&http_result);

    return http_status_to_error((int)http_code, result->stream_closed);
}

ds_error_t ds_stream_head(ds_stream_t *stream, const char **headers, ds_result_t *result) {
    if (!stream || !result) return DS_ERR_INVALID_ARGUMENT;

    memset(result, 0, sizeof(*result));

    CURL *curl = curl_easy_init();
    if (!curl) return DS_ERR_INTERNAL;

    http_response_t resp = {.result = result};
    buffer_init(&resp.body);

    struct curl_slist *hdr_list = NULL;
    if (headers) {
        for (const char **h = headers; *h; h++) {
            hdr_list = curl_slist_append(hdr_list, *h);
        }
    }

    curl_easy_setopt(curl, CURLOPT_URL, stream->full_url);
    curl_easy_setopt(curl, CURLOPT_NOBODY, 1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdr_list);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &resp);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, stream->client->timeout_ms);

    CURLcode res = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    result->status_code = (int)http_code;

    if (hdr_list) curl_slist_free_all(hdr_list);
    curl_easy_cleanup(curl);
    buffer_free(&resp.body);

    if (resp.content_type) {
        result->content_type = resp.content_type;
    }

    if (res != CURLE_OK) {
        result->error_message = format_error_with_path(stream->path, curl_easy_strerror(res));
        result->error_code = DS_ERR_NETWORK;
        return DS_ERR_NETWORK;
    }

    ds_error_t err = http_status_to_error((int)http_code, result->stream_closed);
    /* Set error message with path context for HTTP errors */
    if (err != DS_OK) {
        const char *base_msg = (err == DS_ERR_NOT_FOUND) ? "Stream not found" : ds_error_string(err);
        result->error_message = format_error_with_path(stream->path, base_msg);
    }
    result->error_code = err;
    return err;
}

ds_error_t ds_stream_delete(ds_stream_t *stream, const char **headers, ds_result_t *result) {
    if (!stream || !result) return DS_ERR_INVALID_ARGUMENT;

    memset(result, 0, sizeof(*result));

    CURL *curl = curl_easy_init();
    if (!curl) return DS_ERR_INTERNAL;

    http_response_t resp = {.result = result};
    buffer_init(&resp.body);

    struct curl_slist *hdr_list = NULL;
    if (headers) {
        for (const char **h = headers; *h; h++) {
            hdr_list = curl_slist_append(hdr_list, *h);
        }
    }

    curl_easy_setopt(curl, CURLOPT_URL, stream->full_url);
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdr_list);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &resp);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, stream->client->timeout_ms);

    CURLcode res = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    result->status_code = (int)http_code;

    if (hdr_list) curl_slist_free_all(hdr_list);
    curl_easy_cleanup(curl);
    buffer_free(&resp.body);
    free(resp.content_type);

    if (res != CURLE_OK) {
        result->error_message = format_error_with_path(stream->path, curl_easy_strerror(res));
        result->error_code = DS_ERR_NETWORK;
        return DS_ERR_NETWORK;
    }

    ds_error_t err = http_status_to_error((int)http_code, false);
    result->error_code = err;
    return err;
}

/* ========== Iterator Implementation ========== */

ds_iterator_t *ds_stream_read(ds_stream_t *stream, const ds_read_options_t *options) {
    if (!stream) return NULL;

    ds_iterator_t *iter = calloc(1, sizeof(ds_iterator_t));
    if (!iter) return NULL;

    iter->stream = stream;
    iter->live = options && options->live ? options->live : DS_LIVE_NONE;
    iter->timeout_ms = options && options->timeout_ms > 0 ? options->timeout_ms : stream->client->timeout_ms;
    iter->offset = options && options->offset ? strdup_safe(options->offset) : NULL;
    iter->max_chunks = options && options->max_chunks > 0 ? options->max_chunks : 100;

    /* Copy headers */
    if (options && options->headers) {
        int count = 0;
        for (const char **h = options->headers; *h; h++) count++;
        iter->headers = calloc(count + 1, sizeof(char *));
        if (iter->headers) {
            for (int i = 0; i < count; i++) {
                iter->headers[i] = strdup_safe(options->headers[i]);
            }
        }
    }

    buffer_init(&iter->response_buffer);
    buffer_init(&iter->sse_buffer);
    iter->last_status = 200;

    /* For SSE live mode, allow limited retries when connection closes.
     * This allows receiving new data after initial catchup but prevents
     * infinite loops in tests. */
    iter->sse_retry_count = 0;
    iter->sse_max_retries = (iter->live == DS_LIVE_SSE) ? 3 : 0;

    return iter;
}

const char *ds_iterator_error_message(const ds_iterator_t *iter) {
    if (!iter) return NULL;
    return iter->last_error_message;
}

void ds_iterator_free(ds_iterator_t *iter) {
    if (!iter) return;
    free(iter->offset);
    free(iter->cursor);
    free(iter->last_error_message);
    if (iter->headers) {
        for (char **h = iter->headers; *h; h++) {
            free(*h);
        }
        free(iter->headers);
    }
    buffer_free(&iter->response_buffer);
    buffer_free(&iter->sse_buffer);
    if (iter->curl) {
        curl_easy_cleanup(iter->curl);
    }
    /* Free queued chunks */
    for (int i = iter->queued_pos; i < iter->queued_count; i++) {
        ds_chunk_cleanup(&iter->queued_chunks[i]);
    }
    free(iter->queued_chunks);
    free(iter);
}

const char *ds_iterator_offset(const ds_iterator_t *iter) {
    return iter ? iter->offset : NULL;
}

bool ds_iterator_up_to_date(const ds_iterator_t *iter) {
    return iter ? iter->up_to_date : false;
}

bool ds_iterator_stream_closed(const ds_iterator_t *iter) {
    return iter ? iter->stream_closed : false;
}

/* SSE header callback */
typedef struct {
    ds_iterator_t *iter;
    char *content_type;
    bool is_base64;
} sse_header_data_t;

static size_t sse_header_callback(char *buffer, size_t size, size_t nitems, void *userdata) {
    size_t numbytes = size * nitems;
    sse_header_data_t *data = (sse_header_data_t *)userdata;

    char *colon = memchr(buffer, ':', numbytes);
    if (!colon) return numbytes;

    size_t name_len = colon - buffer;
    char *value = colon + 1;
    size_t value_len = numbytes - name_len - 1;

    while (value_len > 0 && isspace((unsigned char)*value)) {
        value++;
        value_len--;
    }
    while (value_len > 0 && isspace((unsigned char)value[value_len - 1])) {
        value_len--;
    }

    if (name_len == 12 && strncasecmp(buffer, "content-type", 12) == 0) {
        free(data->content_type);
        data->content_type = strndup(value, value_len);
    } else if (name_len == 24 && strncasecmp(buffer, "stream-sse-data-encoding", 24) == 0) {
        if (value_len == 6 && strncasecmp(value, "base64", 6) == 0) {
            data->is_base64 = true;
            data->iter->sse_is_base64 = true;
        }
    }

    return numbytes;
}

/* Base64 decoding */
static const unsigned char base64_table[256] = {
    ['A'] = 0,  ['B'] = 1,  ['C'] = 2,  ['D'] = 3,  ['E'] = 4,  ['F'] = 5,  ['G'] = 6,  ['H'] = 7,
    ['I'] = 8,  ['J'] = 9,  ['K'] = 10, ['L'] = 11, ['M'] = 12, ['N'] = 13, ['O'] = 14, ['P'] = 15,
    ['Q'] = 16, ['R'] = 17, ['S'] = 18, ['T'] = 19, ['U'] = 20, ['V'] = 21, ['W'] = 22, ['X'] = 23,
    ['Y'] = 24, ['Z'] = 25, ['a'] = 26, ['b'] = 27, ['c'] = 28, ['d'] = 29, ['e'] = 30, ['f'] = 31,
    ['g'] = 32, ['h'] = 33, ['i'] = 34, ['j'] = 35, ['k'] = 36, ['l'] = 37, ['m'] = 38, ['n'] = 39,
    ['o'] = 40, ['p'] = 41, ['q'] = 42, ['r'] = 43, ['s'] = 44, ['t'] = 45, ['u'] = 46, ['v'] = 47,
    ['w'] = 48, ['x'] = 49, ['y'] = 50, ['z'] = 51, ['0'] = 52, ['1'] = 53, ['2'] = 54, ['3'] = 55,
    ['4'] = 56, ['5'] = 57, ['6'] = 58, ['7'] = 59, ['8'] = 60, ['9'] = 61, ['+'] = 62, ['/'] = 63,
};

static int base64_decode(const char *in, size_t in_len, char **out, size_t *out_len) {
    if (!in || !out || !out_len) return -1;

    /* Count valid base64 characters and skip newlines/whitespace */
    size_t valid_len = 0;
    for (size_t i = 0; i < in_len; i++) {
        char c = in[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '=') {
            valid_len++;
        }
    }

    if (valid_len == 0) {
        *out = malloc(1);
        if (!*out) return -1;
        (*out)[0] = '\0';
        *out_len = 0;
        return 0;
    }

    size_t max_out = (valid_len / 4) * 3 + 3;
    *out = malloc(max_out + 1);
    if (!*out) return -1;

    unsigned char *dst = (unsigned char *)*out;
    size_t dst_len = 0;
    unsigned int accum = 0;
    int bits = 0;

    for (size_t i = 0; i < in_len; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
        if (c == '=') break;

        unsigned char val = base64_table[c];
        if (c != 'A' && val == 0 && c != 'A') continue; /* Invalid char */

        accum = (accum << 6) | val;
        bits += 6;

        if (bits >= 8) {
            bits -= 8;
            dst[dst_len++] = (accum >> bits) & 0xFF;
        }
    }

    dst[dst_len] = '\0';
    *out_len = dst_len;
    return 0;
}

/* Parse SSE events from buffer */
static ds_error_t parse_sse_events(ds_iterator_t *iter) {
    char *buf = iter->sse_buffer.data;
    size_t buf_len = iter->sse_buffer.size;
    size_t pos = iter->sse_parse_pos;

    while (pos < buf_len) {
        /* Find end of event (double newline) */
        char *event_end = strstr(buf + pos, "\n\n");
        if (!event_end) break;

        size_t event_len = event_end - (buf + pos);
        char *event_str = strndup(buf + pos, event_len);
        if (!event_str) return DS_ERR_OUT_OF_MEMORY;

        pos += event_len + 2;

        /* Parse event */
        char *event_type = NULL;
        ds_buffer_t data_buf;
        buffer_init(&data_buf);

        char *line = event_str;
        while (*line) {
            char *nl = strchr(line, '\n');
            size_t line_len = nl ? (size_t)(nl - line) : strlen(line);

            if (line_len >= 6 && strncmp(line, "event:", 6) == 0) {
                char *val = line + 6;
                while (*val == ' ') val++;
                size_t val_len = nl ? (size_t)(nl - val) : strlen(val);
                free(event_type);
                event_type = strndup(val, val_len);
            } else if (line_len >= 5 && strncmp(line, "data:", 5) == 0) {
                char *val = line + 5;
                size_t val_len = nl ? (size_t)(nl - val) : strlen(val);
                if (data_buf.size > 0) {
                    buffer_append(&data_buf, "\n", 1);
                }
                buffer_append(&data_buf, val, val_len);
            }

            if (nl) {
                line = nl + 1;
            } else {
                break;
            }
        }

        free(event_str);

        if (event_type && strcmp(event_type, "control") == 0 && data_buf.data) {
            /* Parse control event JSON */
            char *json = data_buf.data;

            /* Extract streamNextOffset */
            char *offset_start = strstr(json, "\"streamNextOffset\"");
            if (offset_start) {
                offset_start = strchr(offset_start, ':');
                if (offset_start) {
                    offset_start++;
                    while (*offset_start == ' ' || *offset_start == '"') offset_start++;
                    char *offset_end = offset_start;
                    while (*offset_end && *offset_end != '"' && *offset_end != ',' && *offset_end != '}') offset_end++;
                    free(iter->offset);
                    iter->offset = strndup(offset_start, offset_end - offset_start);
                }
            }

            /* Extract streamCursor */
            char *cursor_start = strstr(json, "\"streamCursor\"");
            if (cursor_start) {
                cursor_start = strchr(cursor_start, ':');
                if (cursor_start) {
                    cursor_start++;
                    while (*cursor_start == ' ' || *cursor_start == '"') cursor_start++;
                    char *cursor_end = cursor_start;
                    while (*cursor_end && *cursor_end != '"' && *cursor_end != ',' && *cursor_end != '}') cursor_end++;
                    free(iter->cursor);
                    iter->cursor = strndup(cursor_start, cursor_end - cursor_start);
                }
            }

            /* Extract upToDate */
            if (strstr(json, "\"upToDate\":true") || strstr(json, "\"upToDate\": true")) {
                iter->up_to_date = true;
            }

            /* Extract streamClosed */
            if (strstr(json, "\"streamClosed\":true") || strstr(json, "\"streamClosed\": true")) {
                iter->stream_closed = true;
                iter->done = true;
            }
        } else if (event_type && strcmp(event_type, "data") == 0 && data_buf.data) {
            /* Data event - queue it */
            if (iter->queued_count >= iter->queued_capacity) {
                int new_cap = iter->queued_capacity == 0 ? 16 : iter->queued_capacity * 2;
                ds_chunk_t *new_chunks = realloc(iter->queued_chunks, new_cap * sizeof(ds_chunk_t));
                if (!new_chunks) {
                    free(event_type);
                    buffer_free(&data_buf);
                    return DS_ERR_OUT_OF_MEMORY;
                }
                iter->queued_chunks = new_chunks;
                iter->queued_capacity = new_cap;
            }

            ds_chunk_t *chunk = &iter->queued_chunks[iter->queued_count++];
            memset(chunk, 0, sizeof(*chunk));

            if (iter->sse_is_base64) {
                char *decoded;
                size_t decoded_len;
                if (base64_decode(data_buf.data, data_buf.size, &decoded, &decoded_len) == 0) {
                    chunk->data = decoded;
                    chunk->data_len = decoded_len;
                    chunk->is_binary = true;
                }
            } else {
                chunk->data = strdup_safe(data_buf.data);
                chunk->data_len = data_buf.size;
            }
        }

        free(event_type);
        buffer_free(&data_buf);
    }

    iter->sse_parse_pos = pos;

    /* Compact buffer */
    if (pos > 0 && pos < buf_len) {
        memmove(buf, buf + pos, buf_len - pos);
        iter->sse_buffer.size -= pos;
        iter->sse_parse_pos = 0;
    } else if (pos >= buf_len) {
        iter->sse_buffer.size = 0;
        iter->sse_parse_pos = 0;
    }

    return DS_OK;
}

static size_t sse_write_callback(void *contents, size_t size, size_t nmemb, void *userp) {
    size_t realsize = size * nmemb;
    ds_iterator_t *iter = (ds_iterator_t *)userp;

    if (buffer_append(&iter->sse_buffer, contents, realsize) < 0) {
        return 0;
    }

    /* Try to parse events */
    parse_sse_events(iter);

    return realsize;
}

ds_error_t ds_iterator_next(ds_iterator_t *iter, ds_chunk_t *chunk) {
    if (!iter || !chunk) return DS_ERR_INVALID_ARGUMENT;

    memset(chunk, 0, sizeof(*chunk));

    if (iter->done) {
        return DS_ERR_DONE;
    }

    if (iter->chunk_count >= iter->max_chunks) {
        return DS_ERR_DONE;
    }

sse_retry:
    /* Check for queued SSE chunks */
    if (iter->queued_pos < iter->queued_count) {
        ds_chunk_t *queued = &iter->queued_chunks[iter->queued_pos++];
        *chunk = *queued;
        chunk->offset = strdup_safe(iter->offset);
        chunk->up_to_date = iter->up_to_date;
        chunk->stream_closed = iter->stream_closed;
        chunk->status_code = iter->last_status;
        iter->chunk_count++;

        /* Don't free the queued chunk data - it's been moved to the output */
        queued->data = NULL;

        /* Reset retry count when we get data */
        iter->sse_retry_count = 0;

        return DS_OK;
    }

    /* Build URL with query parameters */
    ds_buffer_t url_buf;
    buffer_init(&url_buf);
    buffer_append(&url_buf, iter->stream->full_url, strlen(iter->stream->full_url));

    bool has_query = strchr(iter->stream->full_url, '?') != NULL;

    if (iter->offset) {
        char *encoded_offset = ds_url_encode(iter->offset);
        buffer_append(&url_buf, has_query ? "&" : "?", 1);
        buffer_append(&url_buf, "offset=", 7);
        buffer_append(&url_buf, encoded_offset, strlen(encoded_offset));
        free(encoded_offset);
        has_query = true;
    }

    if (iter->live == DS_LIVE_LONG_POLL) {
        buffer_append(&url_buf, has_query ? "&" : "?", 1);
        buffer_append(&url_buf, "live=long-poll", 14);
        has_query = true;
    } else if (iter->live == DS_LIVE_SSE) {
        buffer_append(&url_buf, has_query ? "&" : "?", 1);
        buffer_append(&url_buf, "live=sse", 8);
        has_query = true;
    }

    if (iter->cursor && iter->live != DS_LIVE_NONE) {
        char *encoded_cursor = ds_url_encode(iter->cursor);
        buffer_append(&url_buf, has_query ? "&" : "?", 1);
        buffer_append(&url_buf, "cursor=", 7);
        buffer_append(&url_buf, encoded_cursor, strlen(encoded_cursor));
        free(encoded_cursor);
    }

    CURL *curl = curl_easy_init();
    if (!curl) {
        buffer_free(&url_buf);
        return DS_ERR_INTERNAL;
    }

    ds_result_t http_result = {0};
    http_response_t resp = {.result = &http_result};
    buffer_init(&resp.body);

    sse_header_data_t sse_header_data = {.iter = iter};

    struct curl_slist *headers = NULL;
    if (iter->headers) {
        for (char **h = iter->headers; *h; h++) {
            headers = curl_slist_append(headers, *h);
        }
    }

    curl_easy_setopt(curl, CURLOPT_URL, url_buf.data);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, iter->timeout_ms);

    if (iter->live == DS_LIVE_SSE) {
        /* SSE mode - stream response */
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, sse_write_callback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, iter);
        curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, sse_header_callback);
        curl_easy_setopt(curl, CURLOPT_HEADERDATA, &sse_header_data);
    } else {
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
        curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
        curl_easy_setopt(curl, CURLOPT_HEADERDATA, &resp);
    }

    CURLcode res = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    iter->last_status = (int)http_code;

    if (headers) curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    buffer_free(&url_buf);
    free(sse_header_data.content_type);

    if (res == CURLE_OPERATION_TIMEDOUT) {
        buffer_free(&resp.body);
        ds_result_cleanup(&http_result);
        iter->up_to_date = true;

        /* For SSE mode, a timeout just means no new data arrived.
         * If the stream isn't closed, we can retry to continue waiting. */
        if (iter->live == DS_LIVE_SSE && !iter->done && !iter->stream_closed) {
            /* Check if we got any SSE chunks while waiting */
            if (iter->queued_pos < iter->queued_count) {
                goto sse_retry;
            }
            /* No data - retry if we haven't exceeded max retries */
            if (iter->sse_retry_count < iter->sse_max_retries) {
                iter->sse_retry_count++;
                goto sse_retry;
            }
        }

        return DS_ERR_TIMEOUT;
    }

    if (res != CURLE_OK) {
        buffer_free(&resp.body);
        ds_result_cleanup(&http_result);
        return DS_ERR_NETWORK;
    }

    if (http_code == 400 || http_code == 410) {
        buffer_free(&resp.body);
        ds_result_cleanup(&http_result);
        return DS_ERR_INVALID_OFFSET;
    }

    if (http_code == 404) {
        buffer_free(&resp.body);
        ds_result_cleanup(&http_result);
        free(iter->last_error_message);
        iter->last_error_message = format_error_with_path(iter->stream->path, "Stream not found");
        return DS_ERR_NOT_FOUND;
    }

    if (http_code >= 400) {
        buffer_free(&resp.body);
        ds_result_cleanup(&http_result);
        return DS_ERR_HTTP;
    }

    if (iter->live == DS_LIVE_SSE) {
        /* SSE was parsed during streaming */
        buffer_free(&resp.body);

        /* Check for queued chunks again */
        if (iter->queued_pos < iter->queued_count) {
            ds_chunk_t *queued = &iter->queued_chunks[iter->queued_pos++];
            *chunk = *queued;
            chunk->offset = strdup_safe(iter->offset);
            chunk->up_to_date = iter->up_to_date;
            chunk->stream_closed = iter->stream_closed;
            chunk->status_code = iter->last_status;
            iter->chunk_count++;
            queued->data = NULL;
            ds_result_cleanup(&http_result);
            /* Reset retry count when we get data */
            iter->sse_retry_count = 0;
            return DS_OK;
        }

        ds_result_cleanup(&http_result);

        if (iter->done || iter->stream_closed) {
            return DS_ERR_DONE;
        }

        /* SSE mode: connection closed but stream not closed.
         * In live mode, reconnect to receive new data.
         * The request will use the updated offset/cursor from control events. */
        if (iter->up_to_date && iter->sse_retry_count < iter->sse_max_retries) {
            /* We caught up to the end - retry to wait for new data */
            iter->sse_retry_count++;
            goto sse_retry;
        }

        /* Not up to date or exceeded retries - return timeout */
        return DS_ERR_TIMEOUT;
    }

    /* Non-SSE mode */
    if (http_code == 204) {
        buffer_free(&resp.body);
        iter->up_to_date = http_result.up_to_date;
        iter->stream_closed = http_result.stream_closed;
        if (http_result.next_offset) {
            free(iter->offset);
            iter->offset = http_result.next_offset;
            http_result.next_offset = NULL;
        }
        if (http_result.cursor) {
            free(iter->cursor);
            iter->cursor = http_result.cursor;
            http_result.cursor = NULL;
        }
        ds_result_cleanup(&http_result);

        if (iter->stream_closed) {
            iter->done = true;
        }
        return DS_ERR_DONE;
    }

    /* 200 OK with data */
    chunk->data = resp.body.data;
    chunk->data_len = resp.body.size;
    chunk->status_code = (int)http_code;
    resp.body.data = NULL; /* Transfer ownership */
    resp.body.size = 0;

    if (http_result.next_offset) {
        free(iter->offset);
        iter->offset = http_result.next_offset;
        http_result.next_offset = NULL;
        chunk->offset = strdup_safe(iter->offset);
    }

    if (http_result.cursor) {
        free(iter->cursor);
        iter->cursor = http_result.cursor;
        http_result.cursor = NULL;
    }

    iter->up_to_date = http_result.up_to_date;
    iter->stream_closed = http_result.stream_closed;
    chunk->up_to_date = iter->up_to_date;
    chunk->stream_closed = iter->stream_closed;

    ds_result_cleanup(&http_result);

    iter->chunk_count++;

    if (iter->live == DS_LIVE_NONE && iter->up_to_date) {
        iter->done = true;
    }

    if (iter->stream_closed && iter->up_to_date) {
        iter->done = true;
    }

    return DS_OK;
}

/* ========== Idempotent Producer Implementation ========== */

ds_producer_t *ds_producer_new(ds_client_t *client, const char *url, const char *producer_id,
                               const ds_producer_config_t *config) {
    if (!client || !url || !producer_id || !producer_id[0]) return NULL;

    ds_producer_t *producer = calloc(1, sizeof(ds_producer_t));
    if (!producer) return NULL;

    producer->client = client;
    producer->url = strdup_safe(url);
    producer->producer_id = strdup_safe(producer_id);

    if (!producer->url || !producer->producer_id) {
        ds_producer_free(producer);
        return NULL;
    }

    if (config) {
        producer->epoch = config->epoch;
        producer->auto_claim = config->auto_claim;
        producer->max_in_flight = config->max_in_flight > 0 ? config->max_in_flight : 1;
        producer->linger_ms = config->linger_ms;
        producer->max_batch_bytes = config->max_batch_bytes > 0 ? config->max_batch_bytes : 1048576;
        producer->content_type = config->content_type ? strdup_safe(config->content_type) : strdup_safe("application/octet-stream");
    } else {
        producer->max_in_flight = 1;
        producer->max_batch_bytes = 1048576;
        producer->content_type = strdup_safe("application/octet-stream");
    }

    buffer_init(&producer->batch);

    return producer;
}

void ds_producer_free(ds_producer_t *producer) {
    if (!producer) return;
    free(producer->url);
    free(producer->producer_id);
    free(producer->content_type);
    free(producer->last_error_message);
    buffer_free(&producer->batch);
    free(producer);
}

ds_error_t ds_producer_append(ds_producer_t *producer, const char *data, size_t data_len) {
    if (!producer || !data) return DS_ERR_INVALID_ARGUMENT;

    /* Check if this is JSON content type */
    char *norm_ct = normalize_content_type(producer->content_type);
    bool is_json = norm_ct && strcmp(norm_ct, "application/json") == 0;
    free(norm_ct);

    if (is_json) {
        /* Validate JSON before appending */
        if (data_len > 0 && !validate_json(data, data_len)) {
            producer->last_error = DS_ERR_PARSE_ERROR;
            free(producer->last_error_message);
            producer->last_error_message = strdup_safe("Invalid JSON");
            return DS_ERR_PARSE_ERROR;
        }

        /* For JSON, wrap in array if batching */
        if (producer->batch.size == 0) {
            buffer_append(&producer->batch, "[", 1);
        } else {
            buffer_append(&producer->batch, ",", 1);
        }
        buffer_append(&producer->batch, data, data_len);
        producer->batch_item_count++;
    } else {
        /* For binary, just append */
        buffer_append(&producer->batch, data, data_len);
        producer->batch_item_count++;
    }

    return DS_OK;
}

static ds_error_t producer_send_batch_internal(ds_producer_t *producer, const char *data,
                                                size_t data_len, long timeout_ms, int retry_count) {
    if (retry_count > 3) {
        producer->last_error = DS_ERR_STALE_EPOCH;
        free(producer->last_error_message);
        producer->last_error_message = strdup_safe("autoClaim retry limit exceeded");
        return DS_ERR_STALE_EPOCH;
    }

    CURL *curl = curl_easy_init();
    if (!curl) return DS_ERR_INTERNAL;

    ds_result_t result = {0};
    http_response_t resp = {.result = &result};
    ds_buffer_t body_buf;
    buffer_init(&body_buf);

    struct curl_slist *headers = NULL;

    /* Content-Type */
    char ct_header[256];
    snprintf(ct_header, sizeof(ct_header), "Content-Type: %s", producer->content_type);
    headers = curl_slist_append(headers, ct_header);

    /* Producer headers */
    char producer_id_header[256];
    snprintf(producer_id_header, sizeof(producer_id_header), "Producer-Id: %s", producer->producer_id);
    headers = curl_slist_append(headers, producer_id_header);

    char epoch_header[64];
    snprintf(epoch_header, sizeof(epoch_header), "Producer-Epoch: %d", producer->epoch);
    headers = curl_slist_append(headers, epoch_header);

    char seq_header[64];
    snprintf(seq_header, sizeof(seq_header), "Producer-Seq: %d", producer->seq);
    headers = curl_slist_append(headers, seq_header);

    curl_easy_setopt(curl, CURLOPT_URL, producer->url);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, data);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)data_len);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body_buf);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &resp);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, timeout_ms);

    CURLcode res = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    buffer_free(&body_buf);
    free(resp.content_type);

    if (res != CURLE_OK) {
        producer->last_error = DS_ERR_NETWORK;
        free(producer->last_error_message);
        producer->last_error_message = strdup_safe(curl_easy_strerror(res));
        ds_result_cleanup(&result);
        return DS_ERR_NETWORK;
    }

    ds_error_t err = DS_OK;

    if (http_code == 200) {
        /* New data accepted */
        producer->seq++;
    } else if (http_code == 204) {
        /* Duplicate - still increment seq for next batch */
        producer->seq++;
    } else if (http_code == 403) {
        /* Stale epoch */
        if (producer->auto_claim && result.current_epoch >= 0) {
            /* Claim with new epoch and retry the batch */
            producer->epoch = result.current_epoch + 1;
            producer->seq = 0;
            ds_result_cleanup(&result);
            /* Retry with the same data */
            return producer_send_batch_internal(producer, data, data_len, timeout_ms, retry_count + 1);
        }
        err = DS_ERR_STALE_EPOCH;
    } else if (http_code == 409) {
        if (result.stream_closed) {
            err = DS_ERR_STREAM_CLOSED;
        } else if (result.expected_seq > 0) {
            err = DS_ERR_SEQUENCE_GAP;
        } else {
            err = DS_ERR_CONFLICT;
        }
    } else if (http_code == 404) {
        err = DS_ERR_NOT_FOUND;
    } else if (http_code >= 400) {
        err = DS_ERR_HTTP;
    }

    producer->last_error = err;
    ds_result_cleanup(&result);

    return err;
}

static ds_error_t producer_send_batch(ds_producer_t *producer, long timeout_ms) {
    if (producer->batch.size == 0) return DS_OK;

    /* Finalize JSON array */
    char *norm_ct = normalize_content_type(producer->content_type);
    bool is_json = norm_ct && strcmp(norm_ct, "application/json") == 0;
    free(norm_ct);

    if (is_json) {
        buffer_append(&producer->batch, "]", 1);
    }

    /* Save batch data for potential retry */
    char *batch_data = producer->batch.data;
    size_t batch_size = producer->batch.size;

    /* Detach batch from producer (don't free yet) */
    producer->batch.data = NULL;
    producer->batch.size = 0;
    producer->batch.capacity = 0;
    producer->batch_item_count = 0;

    /* Send the batch (may retry on autoClaim) */
    ds_error_t err = producer_send_batch_internal(producer, batch_data, batch_size, timeout_ms, 0);

    /* Free the batch data */
    free(batch_data);

    return err;
}

ds_error_t ds_producer_flush(ds_producer_t *producer, long timeout_ms) {
    if (!producer) return DS_ERR_INVALID_ARGUMENT;
    if (timeout_ms <= 0) timeout_ms = producer->client->timeout_ms;
    return producer_send_batch(producer, timeout_ms);
}

ds_error_t ds_producer_close_stream(ds_producer_t *producer, const char *final_data, size_t data_len,
                                    ds_close_result_t *result, long timeout_ms) {
    if (!producer || !result) return DS_ERR_INVALID_ARGUMENT;

    memset(result, 0, sizeof(*result));

    if (timeout_ms <= 0) timeout_ms = producer->client->timeout_ms;

    /* Flush any pending data first */
    if (producer->batch.size > 0) {
        ds_error_t err = producer_send_batch(producer, timeout_ms);
        if (err != DS_OK) return err;
    }

    CURL *curl = curl_easy_init();
    if (!curl) return DS_ERR_INTERNAL;

    ds_result_t http_result = {0};
    http_response_t resp = {.result = &http_result};
    ds_buffer_t body_buf;
    buffer_init(&body_buf);

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Stream-Closed: true");

    /* Producer headers */
    char producer_id_header[256];
    snprintf(producer_id_header, sizeof(producer_id_header), "Producer-Id: %s", producer->producer_id);
    headers = curl_slist_append(headers, producer_id_header);

    char epoch_header[64];
    snprintf(epoch_header, sizeof(epoch_header), "Producer-Epoch: %d", producer->epoch);
    headers = curl_slist_append(headers, epoch_header);

    char seq_header[64];
    snprintf(seq_header, sizeof(seq_header), "Producer-Seq: %d", producer->seq);
    headers = curl_slist_append(headers, seq_header);

    if (final_data && data_len > 0) {
        char ct_header[256];
        snprintf(ct_header, sizeof(ct_header), "Content-Type: %s", producer->content_type);
        headers = curl_slist_append(headers, ct_header);
    }

    curl_easy_setopt(curl, CURLOPT_URL, producer->url);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);

    if (final_data && data_len > 0) {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, final_data);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)data_len);
    } else {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, "");
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, 0L);
    }

    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body_buf);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &resp);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, timeout_ms);

    CURLcode res = curl_easy_perform(curl);

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    buffer_free(&body_buf);
    free(resp.content_type);

    if (res != CURLE_OK) {
        ds_result_cleanup(&http_result);
        return DS_ERR_NETWORK;
    }

    result->final_offset = http_result.next_offset;
    result->stream_closed = http_result.stream_closed;
    http_result.next_offset = NULL;

    ds_error_t err = http_status_to_error((int)http_code, result->stream_closed);
    ds_result_cleanup(&http_result);

    if (err == DS_OK) {
        producer->seq++;
    }

    return err;
}

int ds_producer_epoch(const ds_producer_t *producer) {
    return producer ? producer->epoch : 0;
}

ds_error_t ds_producer_last_error(const ds_producer_t *producer) {
    return producer ? producer->last_error : DS_ERR_INVALID_ARGUMENT;
}

const char *ds_producer_last_error_message(const ds_producer_t *producer) {
    return producer ? producer->last_error_message : NULL;
}

/* ========== Cleanup Functions ========== */

void ds_result_cleanup(ds_result_t *result) {
    if (!result) return;
    free(result->next_offset);
    free(result->content_type);
    free(result->cursor);
    free(result->error_message);
    result->next_offset = NULL;
    result->content_type = NULL;
    result->cursor = NULL;
    result->error_message = NULL;
}

void ds_chunk_cleanup(ds_chunk_t *chunk) {
    if (!chunk) return;
    free(chunk->data);
    free(chunk->offset);
    free(chunk->cursor);
    chunk->data = NULL;
    chunk->offset = NULL;
    chunk->cursor = NULL;
}

void ds_close_result_cleanup(ds_close_result_t *result) {
    if (!result) return;
    free(result->final_offset);
    result->final_offset = NULL;
}
