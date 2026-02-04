/**
 * Durable Streams C Client - Conformance Test Adapter
 *
 * This adapter communicates with the test runner via stdin/stdout using
 * a JSON-line protocol.
 */

#define _GNU_SOURCE /* For strdup, strndup */
#include "durable_streams.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <ctype.h>
#include <time.h>

/* We need a simple JSON parser. Using a minimal implementation. */

#define MAX_LINE_SIZE (10 * 1024 * 1024) /* 10MB max line */
#define MAX_STREAMS 1024
#define MAX_PRODUCERS 256
#define MAX_DYNAMIC_HEADERS 64

typedef struct {
    char *name;
    char *type;  /* "counter", "timestamp", "token" */
    int counter;
    char *token_value;
} dynamic_value_t;

/* Global state */
static char *server_url = NULL;
static ds_client_t *client = NULL;
static char *stream_content_types[MAX_STREAMS];
static char *stream_paths[MAX_STREAMS];
static int stream_count = 0;

/* Producer cache */
typedef struct {
    char *path;
    char *producer_id;
    ds_producer_t *producer;
} producer_entry_t;

static producer_entry_t producers[MAX_PRODUCERS];
static int producer_count = 0;

/* Dynamic headers/params */
static dynamic_value_t dynamic_headers[MAX_DYNAMIC_HEADERS];
static int dynamic_header_count = 0;
static dynamic_value_t dynamic_params[MAX_DYNAMIC_HEADERS];
static int dynamic_param_count = 0;

/* Simple JSON parsing helpers */
static char *json_get_string(const char *json, const char *key);
static int json_get_int(const char *json, const char *key, int default_val);
static bool json_get_bool(const char *json, const char *key);
static char **json_get_string_array(const char *json, const char *key, int *count);
static void free_string_array(char **arr, int count);

/* Output helpers */
static void send_json(const char *json);
static void send_result(const char *type, bool success, const char *json_fields);
static void send_error(const char *cmd_type, const char *error_code, const char *message);

/* Command handlers */
static void handle_init(const char *json);
static void handle_create(const char *json);
static void handle_connect(const char *json);
static void handle_append(const char *json);
static void handle_read(const char *json);
static void handle_head(const char *json);
static void handle_delete(const char *json);
static void handle_close(const char *json);
static void handle_set_dynamic_header(const char *json);
static void handle_set_dynamic_param(const char *json);
static void handle_clear_dynamic(const char *json);
static void handle_idempotent_append(const char *json);
static void handle_idempotent_append_batch(const char *json);
static void handle_idempotent_close(const char *json);
static void handle_idempotent_detach(const char *json);
static void handle_validate(const char *json);

/* Utility functions */
static char *get_content_type_for_path(const char *path);
static void set_content_type_for_path(const char *path, const char *ct);
static ds_producer_t *get_producer(const char *path, const char *producer_id, int epoch, bool auto_claim, const char *content_type);
static void detach_producer(const char *path, const char *producer_id);
static void close_all_producers(void);
static char *resolve_dynamic_headers_json(void);
static char *resolve_dynamic_params_json(void);

/* JSON escape */
static char *json_escape(const char *str);

/* Base64 encoding for binary data */
static char *base64_encode(const char *data, size_t len);

int main(void) {
    char *line = malloc(MAX_LINE_SIZE);
    if (!line) {
        fprintf(stderr, "Failed to allocate line buffer\n");
        return 1;
    }

    while (fgets(line, MAX_LINE_SIZE, stdin)) {
        /* Trim trailing newline */
        size_t len = strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r')) {
            line[--len] = '\0';
        }

        if (len == 0) continue;

        /* Parse command type */
        char *type = json_get_string(line, "type");
        if (!type) {
            send_error("unknown", "PARSE_ERROR", "missing type field");
            continue;
        }

        if (strcmp(type, "init") == 0) {
            handle_init(line);
        } else if (strcmp(type, "create") == 0) {
            handle_create(line);
        } else if (strcmp(type, "connect") == 0) {
            handle_connect(line);
        } else if (strcmp(type, "append") == 0) {
            handle_append(line);
        } else if (strcmp(type, "read") == 0) {
            handle_read(line);
        } else if (strcmp(type, "head") == 0) {
            handle_head(line);
        } else if (strcmp(type, "delete") == 0) {
            handle_delete(line);
        } else if (strcmp(type, "close") == 0) {
            handle_close(line);
        } else if (strcmp(type, "set-dynamic-header") == 0) {
            handle_set_dynamic_header(line);
        } else if (strcmp(type, "set-dynamic-param") == 0) {
            handle_set_dynamic_param(line);
        } else if (strcmp(type, "clear-dynamic") == 0) {
            handle_clear_dynamic(line);
        } else if (strcmp(type, "idempotent-append") == 0) {
            handle_idempotent_append(line);
        } else if (strcmp(type, "idempotent-append-batch") == 0) {
            handle_idempotent_append_batch(line);
        } else if (strcmp(type, "idempotent-close") == 0 || strcmp(type, "idempotent-producer-close") == 0) {
            handle_idempotent_close(line);
        } else if (strcmp(type, "idempotent-detach") == 0 || strcmp(type, "idempotent-producer-detach") == 0) {
            handle_idempotent_detach(line);
        } else if (strcmp(type, "validate") == 0) {
            handle_validate(line);
        } else if (strcmp(type, "shutdown") == 0) {
            close_all_producers();
            send_result("shutdown", true, NULL);
            free(type);
            break;
        } else {
            send_error(type, "NOT_SUPPORTED", "unknown command type");
        }

        free(type);
    }

    free(line);
    if (client) ds_client_free(client);
    free(server_url);

    return 0;
}

/* ========== Simple JSON Parsing ========== */

static char *json_get_string(const char *json, const char *key) {
    char search[256];
    snprintf(search, sizeof(search), "\"%s\"", key);

    const char *found = strstr(json, search);
    if (!found) return NULL;

    found += strlen(search);
    while (*found && (*found == ' ' || *found == ':')) found++;

    if (*found != '"') return NULL;
    found++;

    const char *end = found;
    while (*end && *end != '"') {
        if (*end == '\\' && *(end+1)) end += 2;
        else end++;
    }

    size_t len = end - found;
    char *result = malloc(len + 1);
    if (!result) return NULL;

    /* Handle escape sequences */
    char *dst = result;
    const char *src = found;
    while (src < end) {
        if (*src == '\\' && src + 1 < end) {
            src++;
            switch (*src) {
                case 'n': *dst++ = '\n'; break;
                case 'r': *dst++ = '\r'; break;
                case 't': *dst++ = '\t'; break;
                case '"': *dst++ = '"'; break;
                case '\\': *dst++ = '\\'; break;
                default: *dst++ = *src; break;
            }
            src++;
        } else {
            *dst++ = *src++;
        }
    }
    *dst = '\0';

    return result;
}

static int json_get_int(const char *json, const char *key, int default_val) {
    char search[256];
    snprintf(search, sizeof(search), "\"%s\"", key);

    const char *found = strstr(json, search);
    if (!found) return default_val;

    found += strlen(search);
    while (*found && (*found == ' ' || *found == ':')) found++;

    if (!isdigit((unsigned char)*found) && *found != '-') return default_val;

    return atoi(found);
}

static bool json_get_bool(const char *json, const char *key) {
    char search[256];
    snprintf(search, sizeof(search), "\"%s\"", key);

    const char *found = strstr(json, search);
    if (!found) return false;

    found += strlen(search);
    while (*found && (*found == ' ' || *found == ':')) found++;

    return strncmp(found, "true", 4) == 0;
}

static char **json_get_string_array(const char *json, const char *key, int *count) {
    *count = 0;

    char search[256];
    snprintf(search, sizeof(search), "\"%s\"", key);

    const char *found = strstr(json, search);
    if (!found) return NULL;

    found += strlen(search);
    while (*found && (*found == ' ' || *found == ':')) found++;

    if (*found != '[') return NULL;
    found++;

    /* Count elements */
    int capacity = 16;
    char **result = malloc(capacity * sizeof(char *));
    if (!result) return NULL;

    while (*found) {
        while (*found && (*found == ' ' || *found == ',' || *found == '\n' || *found == '\r')) found++;

        if (*found == ']') break;

        if (*found != '"') {
            free_string_array(result, *count);
            return NULL;
        }
        found++;

        const char *end = found;
        while (*end && *end != '"') {
            if (*end == '\\' && *(end+1)) end += 2;
            else end++;
        }

        if (*count >= capacity) {
            capacity *= 2;
            char **new_result = realloc(result, capacity * sizeof(char *));
            if (!new_result) {
                free_string_array(result, *count);
                return NULL;
            }
            result = new_result;
        }

        size_t len = end - found;
        result[*count] = malloc(len + 1);
        if (!result[*count]) {
            free_string_array(result, *count);
            return NULL;
        }

        /* Handle escape sequences */
        char *dst = result[*count];
        const char *src = found;
        while (src < end) {
            if (*src == '\\' && src + 1 < end) {
                src++;
                switch (*src) {
                    case 'n': *dst++ = '\n'; break;
                    case 'r': *dst++ = '\r'; break;
                    case 't': *dst++ = '\t'; break;
                    case '"': *dst++ = '"'; break;
                    case '\\': *dst++ = '\\'; break;
                    default: *dst++ = *src; break;
                }
                src++;
            } else {
                *dst++ = *src++;
            }
        }
        *dst = '\0';

        (*count)++;
        found = end + 1;
    }

    return result;
}

static void free_string_array(char **arr, int count) {
    if (!arr) return;
    for (int i = 0; i < count; i++) {
        free(arr[i]);
    }
    free(arr);
}

/* ========== JSON Output Helpers ========== */

static char *json_escape(const char *str) {
    if (!str) return strdup("null");

    size_t len = strlen(str);
    size_t escaped_len = 0;

    /* Calculate escaped length */
    for (size_t i = 0; i < len; i++) {
        switch (str[i]) {
            case '"': case '\\': case '/':
            case '\b': case '\f': case '\n': case '\r': case '\t':
                escaped_len += 2;
                break;
            default:
                if ((unsigned char)str[i] < 0x20) {
                    escaped_len += 6; /* \uXXXX */
                } else {
                    escaped_len++;
                }
        }
    }

    char *result = malloc(escaped_len + 3); /* quotes + null */
    if (!result) return NULL;

    char *dst = result;
    *dst++ = '"';

    for (size_t i = 0; i < len; i++) {
        switch (str[i]) {
            case '"': *dst++ = '\\'; *dst++ = '"'; break;
            case '\\': *dst++ = '\\'; *dst++ = '\\'; break;
            case '\b': *dst++ = '\\'; *dst++ = 'b'; break;
            case '\f': *dst++ = '\\'; *dst++ = 'f'; break;
            case '\n': *dst++ = '\\'; *dst++ = 'n'; break;
            case '\r': *dst++ = '\\'; *dst++ = 'r'; break;
            case '\t': *dst++ = '\\'; *dst++ = 't'; break;
            default:
                if ((unsigned char)str[i] < 0x20) {
                    dst += sprintf(dst, "\\u%04x", (unsigned char)str[i]);
                } else {
                    *dst++ = str[i];
                }
        }
    }

    *dst++ = '"';
    *dst = '\0';

    return result;
}

static void send_json(const char *json) {
    printf("%s\n", json);
    fflush(stdout);
}

static void send_result(const char *type, bool success, const char *json_fields) {
    char buffer[65536];
    int len = snprintf(buffer, sizeof(buffer),
        "{\"type\":\"%s\",\"success\":%s%s%s}",
        type,
        success ? "true" : "false",
        json_fields ? "," : "",
        json_fields ? json_fields : "");

    if (len > 0 && (size_t)len < sizeof(buffer)) {
        send_json(buffer);
    }
}

static void send_error(const char *cmd_type, const char *error_code, const char *message) {
    char *escaped_msg = json_escape(message);
    char buffer[8192];
    snprintf(buffer, sizeof(buffer),
        "{\"type\":\"error\",\"success\":false,\"commandType\":\"%s\",\"errorCode\":\"%s\",\"message\":%s}",
        cmd_type, error_code, escaped_msg ? escaped_msg : "\"\"");
    free(escaped_msg);
    send_json(buffer);
}

static const char *error_to_code(ds_error_t err) {
    switch (err) {
        case DS_ERR_NOT_FOUND: return "NOT_FOUND";
        case DS_ERR_CONFLICT: return "SEQUENCE_CONFLICT";
        case DS_ERR_STREAM_CLOSED: return "STREAM_CLOSED";
        case DS_ERR_INVALID_OFFSET: return "INVALID_OFFSET";
        case DS_ERR_STALE_EPOCH: return "STALE_EPOCH";
        case DS_ERR_SEQUENCE_GAP: return "SEQUENCE_GAP";
        case DS_ERR_PARSE_ERROR: return "PARSE_ERROR";
        case DS_ERR_TIMEOUT: return "TIMEOUT";
        case DS_ERR_NETWORK: return "NETWORK_ERROR";
        default: return "INTERNAL_ERROR";
    }
}

/* ========== Utility Functions ========== */

static char *get_content_type_for_path(const char *path) {
    for (int i = 0; i < stream_count; i++) {
        if (stream_paths[i] && strcmp(stream_paths[i], path) == 0) {
            return stream_content_types[i];
        }
    }
    return NULL;
}

static void set_content_type_for_path(const char *path, const char *ct) {
    for (int i = 0; i < stream_count; i++) {
        if (stream_paths[i] && strcmp(stream_paths[i], path) == 0) {
            free(stream_content_types[i]);
            stream_content_types[i] = ct ? strdup(ct) : NULL;
            return;
        }
    }
    if (stream_count < MAX_STREAMS) {
        stream_paths[stream_count] = strdup(path);
        stream_content_types[stream_count] = ct ? strdup(ct) : NULL;
        stream_count++;
    }
}

static ds_producer_t *get_producer(const char *path, const char *producer_id, int epoch, bool auto_claim, const char *content_type) {
    /* Look for existing producer */
    for (int i = 0; i < producer_count; i++) {
        if (producers[i].path && strcmp(producers[i].path, path) == 0 &&
            producers[i].producer_id && strcmp(producers[i].producer_id, producer_id) == 0) {
            return producers[i].producer;
        }
    }

    /* Create new producer */
    if (producer_count >= MAX_PRODUCERS) return NULL;

    char url[4096];
    snprintf(url, sizeof(url), "%s%s", server_url, path);

    ds_producer_config_t config = {
        .epoch = epoch,
        .auto_claim = auto_claim,
        .max_in_flight = 1,
        .linger_ms = 0,
        .max_batch_bytes = 1048576,
        .content_type = content_type ? content_type : "application/octet-stream"
    };

    ds_producer_t *producer = ds_producer_new(client, url, producer_id, &config);
    if (!producer) return NULL;

    producers[producer_count].path = strdup(path);
    producers[producer_count].producer_id = strdup(producer_id);
    producers[producer_count].producer = producer;
    producer_count++;

    return producer;
}

static void detach_producer(const char *path, const char *producer_id) {
    for (int i = 0; i < producer_count; i++) {
        if (producers[i].path && strcmp(producers[i].path, path) == 0 &&
            producers[i].producer_id && strcmp(producers[i].producer_id, producer_id) == 0) {
            ds_producer_free(producers[i].producer);
            free(producers[i].path);
            free(producers[i].producer_id);
            /* Move last entry to this position */
            if (i < producer_count - 1) {
                producers[i] = producers[producer_count - 1];
            }
            producer_count--;
            return;
        }
    }
}

static void close_all_producers(void) {
    for (int i = 0; i < producer_count; i++) {
        ds_producer_free(producers[i].producer);
        free(producers[i].path);
        free(producers[i].producer_id);
    }
    producer_count = 0;
}

static char *resolve_dynamic_headers_json(void) {
    if (dynamic_header_count == 0) return NULL;

    char buffer[8192] = "{";
    bool first = true;

    for (int i = 0; i < dynamic_header_count; i++) {
        dynamic_value_t *dv = &dynamic_headers[i];
        char value[256];

        if (strcmp(dv->type, "counter") == 0) {
            dv->counter++;
            snprintf(value, sizeof(value), "%d", dv->counter);
        } else if (strcmp(dv->type, "timestamp") == 0) {
            snprintf(value, sizeof(value), "%ld", (long)time(NULL) * 1000);
        } else if (strcmp(dv->type, "token") == 0) {
            snprintf(value, sizeof(value), "%s", dv->token_value ? dv->token_value : "");
        } else {
            continue;
        }

        char *escaped_name = json_escape(dv->name);
        char *escaped_value = json_escape(value);
        char entry[1024];
        snprintf(entry, sizeof(entry), "%s%s:%s", first ? "" : ",", escaped_name, escaped_value);
        strcat(buffer, entry);
        free(escaped_name);
        free(escaped_value);
        first = false;
    }

    strcat(buffer, "}");
    return strdup(buffer);
}

static char *resolve_dynamic_params_json(void) {
    if (dynamic_param_count == 0) return NULL;

    char buffer[8192] = "{";
    bool first = true;

    for (int i = 0; i < dynamic_param_count; i++) {
        dynamic_value_t *dv = &dynamic_params[i];
        char value[256];

        if (strcmp(dv->type, "counter") == 0) {
            dv->counter++;
            snprintf(value, sizeof(value), "%d", dv->counter);
        } else if (strcmp(dv->type, "timestamp") == 0) {
            snprintf(value, sizeof(value), "%ld", (long)time(NULL) * 1000);
        } else {
            continue;
        }

        char *escaped_name = json_escape(dv->name);
        char *escaped_value = json_escape(value);
        char entry[1024];
        snprintf(entry, sizeof(entry), "%s%s:%s", first ? "" : ",", escaped_name, escaped_value);
        strcat(buffer, entry);
        free(escaped_name);
        free(escaped_value);
        first = false;
    }

    strcat(buffer, "}");
    return strdup(buffer);
}

/* Base64 encoding */
static const char base64_chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *base64_encode(const char *data, size_t len) {
    size_t out_len = ((len + 2) / 3) * 4;
    char *result = malloc(out_len + 1);
    if (!result) return NULL;

    size_t i, j;
    for (i = 0, j = 0; i < len; i += 3, j += 4) {
        unsigned int a = (unsigned char)data[i];
        unsigned int b = (i + 1 < len) ? (unsigned char)data[i + 1] : 0;
        unsigned int c = (i + 2 < len) ? (unsigned char)data[i + 2] : 0;

        result[j] = base64_chars[a >> 2];
        result[j + 1] = base64_chars[((a & 0x03) << 4) | (b >> 4)];
        result[j + 2] = (i + 1 < len) ? base64_chars[((b & 0x0F) << 2) | (c >> 6)] : '=';
        result[j + 3] = (i + 2 < len) ? base64_chars[c & 0x3F] : '=';
    }
    result[out_len] = '\0';
    return result;
}

/* Base64 decoding for binary data from test runner */
static const unsigned char base64_decode_table[256] = {
    ['A'] = 0,  ['B'] = 1,  ['C'] = 2,  ['D'] = 3,  ['E'] = 4,  ['F'] = 5,  ['G'] = 6,  ['H'] = 7,
    ['I'] = 8,  ['J'] = 9,  ['K'] = 10, ['L'] = 11, ['M'] = 12, ['N'] = 13, ['O'] = 14, ['P'] = 15,
    ['Q'] = 16, ['R'] = 17, ['S'] = 18, ['T'] = 19, ['U'] = 20, ['V'] = 21, ['W'] = 22, ['X'] = 23,
    ['Y'] = 24, ['Z'] = 25, ['a'] = 26, ['b'] = 27, ['c'] = 28, ['d'] = 29, ['e'] = 30, ['f'] = 31,
    ['g'] = 32, ['h'] = 33, ['i'] = 34, ['j'] = 35, ['k'] = 36, ['l'] = 37, ['m'] = 38, ['n'] = 39,
    ['o'] = 40, ['p'] = 41, ['q'] = 42, ['r'] = 43, ['s'] = 44, ['t'] = 45, ['u'] = 46, ['v'] = 47,
    ['w'] = 48, ['x'] = 49, ['y'] = 50, ['z'] = 51, ['0'] = 52, ['1'] = 53, ['2'] = 54, ['3'] = 55,
    ['4'] = 56, ['5'] = 57, ['6'] = 58, ['7'] = 59, ['8'] = 60, ['9'] = 61, ['+'] = 62, ['/'] = 63,
};

static char *base64_decode_to_binary(const char *in, size_t *out_len) {
    if (!in || !out_len) return NULL;

    size_t in_len = strlen(in);
    size_t max_out = (in_len / 4) * 3 + 3;
    char *out = malloc(max_out + 1);
    if (!out) return NULL;

    unsigned char *dst = (unsigned char *)out;
    size_t dst_len = 0;
    unsigned int accum = 0;
    int bits = 0;

    for (size_t i = 0; i < in_len; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
        if (c == '=') break;

        unsigned char val = base64_decode_table[c];
        if (c != 'A' && val == 0) continue;

        accum = (accum << 6) | val;
        bits += 6;

        if (bits >= 8) {
            bits -= 8;
            dst[dst_len++] = (accum >> bits) & 0xFF;
        }
    }

    out[dst_len] = '\0';
    *out_len = dst_len;
    return out;
}

/* ========== Command Handlers ========== */

static void handle_init(const char *json) {
    char *url = json_get_string(json, "serverUrl");
    if (!url) {
        send_error("init", "PARSE_ERROR", "missing serverUrl");
        return;
    }

    free(server_url);
    server_url = url;

    if (client) ds_client_free(client);

    ds_client_config_t config = {
        .base_url = server_url,
        .timeout_ms = 30000,
        .verbose = false
    };
    client = ds_client_new(&config);

    /* Clear state */
    for (int i = 0; i < stream_count; i++) {
        free(stream_paths[i]);
        free(stream_content_types[i]);
    }
    stream_count = 0;

    close_all_producers();

    /* Clear dynamic headers/params */
    for (int i = 0; i < dynamic_header_count; i++) {
        free(dynamic_headers[i].name);
        free(dynamic_headers[i].type);
        free(dynamic_headers[i].token_value);
    }
    dynamic_header_count = 0;

    for (int i = 0; i < dynamic_param_count; i++) {
        free(dynamic_params[i].name);
        free(dynamic_params[i].type);
        free(dynamic_params[i].token_value);
    }
    dynamic_param_count = 0;

    char result[1024];
    snprintf(result, sizeof(result),
        "\"clientName\":\"%s\",\"clientVersion\":\"%s\","
        "\"features\":{\"batching\":true,\"sse\":true,\"longPoll\":true,\"streaming\":true,\"dynamicHeaders\":true}",
        DS_CLIENT_NAME, DS_VERSION);
    send_result("init", true, result);
}

static void handle_create(const char *json) {
    char *path = json_get_string(json, "path");
    if (!path) {
        send_error("create", "PARSE_ERROR", "missing path");
        return;
    }

    char *content_type = json_get_string(json, "contentType");
    int ttl_seconds = json_get_int(json, "ttlSeconds", 0);
    char *expires_at = json_get_string(json, "expiresAt");
    bool closed = json_get_bool(json, "closed");
    char *data = json_get_string(json, "data");
    bool binary = json_get_bool(json, "binary");

    ds_stream_t *stream = ds_stream_new(client, path);
    if (!stream) {
        free(path);
        free(content_type);
        free(expires_at);
        free(data);
        send_error("create", "INTERNAL_ERROR", "failed to create stream handle");
        return;
    }

    /* Check if stream exists for idempotent response */
    ds_result_t head_result = {0};
    bool already_exists = (ds_stream_head(stream, NULL, &head_result) == DS_OK);
    ds_result_cleanup(&head_result);

    ds_create_options_t options = {
        .content_type = content_type ? content_type : "application/octet-stream",
        .ttl_seconds = ttl_seconds,
        .expires_at = expires_at,
        .closed = closed
    };

    char *binary_data = NULL;
    size_t binary_len = 0;

    if (data) {
        if (binary) {
            binary_data = base64_decode_to_binary(data, &binary_len);
            options.initial_data = binary_data;
            options.initial_data_len = binary_len;
        } else {
            options.initial_data = data;
            options.initial_data_len = strlen(data);
        }
    }

    ds_result_t result = {0};
    ds_error_t err = ds_stream_create(stream, &options, &result);

    if (err == DS_OK) {
        /* Cache content type */
        set_content_type_for_path(path, options.content_type);

        char fields[1024];
        snprintf(fields, sizeof(fields),
            "\"status\":%d,\"offset\":\"%s\"",
            already_exists ? 200 : 201,
            result.next_offset ? result.next_offset : "");
        send_result("create", true, fields);
    } else {
        send_error("create", error_to_code(err), result.error_message ? result.error_message : ds_error_string(err));
    }

    ds_result_cleanup(&result);
    ds_stream_free(stream);
    free(path);
    free(content_type);
    free(expires_at);
    free(data);
    free(binary_data);
}

static void handle_connect(const char *json) {
    char *path = json_get_string(json, "path");
    if (!path) {
        send_error("connect", "PARSE_ERROR", "missing path");
        return;
    }

    ds_stream_t *stream = ds_stream_new(client, path);
    if (!stream) {
        free(path);
        send_error("connect", "INTERNAL_ERROR", "failed to create stream handle");
        return;
    }

    ds_result_t result = {0};
    ds_error_t err = ds_stream_head(stream, NULL, &result);

    if (err == DS_OK) {
        /* Cache content type */
        if (result.content_type) {
            set_content_type_for_path(path, result.content_type);
        }

        char fields[1024];
        snprintf(fields, sizeof(fields),
            "\"status\":200,\"offset\":\"%s\"",
            result.next_offset ? result.next_offset : "");
        send_result("connect", true, fields);
    } else {
        send_error("connect", error_to_code(err), ds_error_string(err));
    }

    ds_result_cleanup(&result);
    ds_stream_free(stream);
    free(path);
}

static void handle_append(const char *json) {
    char *path = json_get_string(json, "path");
    char *data = json_get_string(json, "data");
    bool binary = json_get_bool(json, "binary");
    int seq = json_get_int(json, "seq", 0);

    if (!path || !data) {
        free(path);
        free(data);
        send_error("append", "PARSE_ERROR", "missing path or data");
        return;
    }

    ds_stream_t *stream = ds_stream_new(client, path);
    if (!stream) {
        free(path);
        free(data);
        send_error("append", "INTERNAL_ERROR", "failed to create stream handle");
        return;
    }

    /* Set content type from cache */
    char *ct = get_content_type_for_path(path);
    if (ct) {
        ds_stream_set_content_type(stream, ct);
    }

    /* Resolve dynamic headers */
    char *headers_sent = resolve_dynamic_headers_json();
    char *params_sent = resolve_dynamic_params_json();

    ds_append_options_t options = {0};
    char seq_str[32] = {0};
    if (seq > 0) {
        snprintf(seq_str, sizeof(seq_str), "%d", seq);
        options.seq = seq_str;
    }

    char *binary_data = NULL;
    size_t binary_len = 0;
    const char *append_data = data;
    size_t append_len = strlen(data);

    if (binary) {
        binary_data = base64_decode_to_binary(data, &binary_len);
        append_data = binary_data;
        append_len = binary_len;
    }

    ds_result_t result = {0};
    ds_error_t err = ds_stream_append(stream, append_data, append_len, &options, &result);

    if (err == DS_OK) {
        char fields[4096];
        int len = snprintf(fields, sizeof(fields),
            "\"status\":200,\"offset\":\"%s\"",
            result.next_offset ? result.next_offset : "");

        if (headers_sent) {
            len += snprintf(fields + len, sizeof(fields) - len, ",\"headersSent\":%s", headers_sent);
        }
        if (params_sent) {
            len += snprintf(fields + len, sizeof(fields) - len, ",\"paramsSent\":%s", params_sent);
        }

        send_result("append", true, fields);
    } else {
        send_error("append", error_to_code(err), ds_error_string(err));
    }

    ds_result_cleanup(&result);
    ds_stream_free(stream);
    free(path);
    free(data);
    free(binary_data);
    free(headers_sent);
    free(params_sent);
}

static void handle_read(const char *json) {
    char *path = json_get_string(json, "path");
    char *offset = json_get_string(json, "offset");
    char *live_str = json_get_string(json, "live");
    int timeout_ms = json_get_int(json, "timeoutMs", 5000);
    int max_chunks = json_get_int(json, "maxChunks", 100);
    bool wait_for_up_to_date = json_get_bool(json, "waitForUpToDate");

    if (!path) {
        free(offset);
        free(live_str);
        send_error("read", "PARSE_ERROR", "missing path");
        return;
    }

    ds_stream_t *stream = ds_stream_new(client, path);
    if (!stream) {
        free(path);
        free(offset);
        free(live_str);
        send_error("read", "INTERNAL_ERROR", "failed to create stream handle");
        return;
    }

    ds_live_mode_t live = DS_LIVE_NONE;
    if (live_str) {
        if (strcmp(live_str, "long-poll") == 0) {
            live = DS_LIVE_LONG_POLL;
        } else if (strcmp(live_str, "sse") == 0) {
            live = DS_LIVE_SSE;
        }
    }

    /* Resolve dynamic headers */
    char *headers_sent = resolve_dynamic_headers_json();
    char *params_sent = resolve_dynamic_params_json();

    ds_read_options_t options = {
        .offset = offset,
        .live = live,
        .timeout_ms = timeout_ms,
        .max_chunks = max_chunks
    };

    ds_iterator_t *iter = ds_stream_read(stream, &options);
    if (!iter) {
        ds_stream_free(stream);
        free(path);
        free(offset);
        free(live_str);
        free(headers_sent);
        free(params_sent);
        send_error("read", "INTERNAL_ERROR", "failed to create iterator");
        return;
    }

    /* Collect chunks */
    char chunks_json[1024 * 1024] = "[";
    size_t chunks_len = 1;
    int chunk_count = 0;
    bool up_to_date = false;
    bool stream_closed = false;
    char *final_offset = NULL;
    int status = 200;

    ds_chunk_t chunk = {0};
    ds_error_t err;

    while ((err = ds_iterator_next(iter, &chunk)) == DS_OK) {
        if (chunk.data && chunk.data_len > 0) {
            if (chunk_count > 0) {
                chunks_json[chunks_len++] = ',';
            }

            char *escaped_data;
            if (chunk.is_binary) {
                /* Binary data - base64 encode it */
                char *b64 = base64_encode(chunk.data, chunk.data_len);
                char *temp = json_escape(b64);
                free(b64);
                escaped_data = temp;
            } else {
                /* All text data (including JSON) should be escaped as a string */
                escaped_data = json_escape(chunk.data);
            }

            char chunk_json[65536];
            int clen;
            clen = snprintf(chunk_json, sizeof(chunk_json),
                "{\"data\":%s%s,\"offset\":\"%s\"}",
                escaped_data ? escaped_data : "\"\"",
                chunk.is_binary ? ",\"binary\":true" : "",
                chunk.offset ? chunk.offset : "");
            free(escaped_data);

            if (chunks_len + clen < sizeof(chunks_json) - 10) {
                memcpy(chunks_json + chunks_len, chunk_json, clen);
                chunks_len += clen;
            }
            chunk_count++;
        }

        status = chunk.status_code ? chunk.status_code : 200;
        up_to_date = chunk.up_to_date;
        stream_closed = stream_closed || chunk.stream_closed;

        free(final_offset);
        final_offset = chunk.offset ? strdup(chunk.offset) : NULL;

        ds_chunk_cleanup(&chunk);

        if (wait_for_up_to_date && up_to_date) {
            break;
        }

        if (live == DS_LIVE_NONE && up_to_date) {
            break;
        }
    }

    if (err == DS_ERR_TIMEOUT) {
        up_to_date = true;
        status = 204;
    } else if (err != DS_OK && err != DS_ERR_DONE) {
        ds_iterator_free(iter);
        ds_stream_free(stream);
        free(path);
        free(offset);
        free(live_str);
        free(headers_sent);
        free(params_sent);
        free(final_offset);
        send_error("read", error_to_code(err), ds_error_string(err));
        return;
    }

    /* Check iterator state */
    if (!up_to_date) up_to_date = ds_iterator_up_to_date(iter);
    if (!stream_closed) stream_closed = ds_iterator_stream_closed(iter);
    if (!final_offset) {
        const char *iter_offset = ds_iterator_offset(iter);
        if (iter_offset) final_offset = strdup(iter_offset);
    }

    chunks_json[chunks_len++] = ']';
    chunks_json[chunks_len] = '\0';

    char fields[1024 * 1024 + 1024];
    int flen = snprintf(fields, sizeof(fields),
        "\"status\":%d,\"chunks\":%s,\"offset\":\"%s\",\"upToDate\":%s,\"streamClosed\":%s",
        status,
        chunks_json,
        final_offset ? final_offset : (offset ? offset : "-1"),
        up_to_date ? "true" : "false",
        stream_closed ? "true" : "false");

    if (headers_sent) {
        flen += snprintf(fields + flen, sizeof(fields) - flen, ",\"headersSent\":%s", headers_sent);
    }
    if (params_sent) {
        flen += snprintf(fields + flen, sizeof(fields) - flen, ",\"paramsSent\":%s", params_sent);
    }

    send_result("read", true, fields);

    ds_iterator_free(iter);
    ds_stream_free(stream);
    free(path);
    free(offset);
    free(live_str);
    free(headers_sent);
    free(params_sent);
    free(final_offset);
}

static void handle_head(const char *json) {
    char *path = json_get_string(json, "path");
    if (!path) {
        send_error("head", "PARSE_ERROR", "missing path");
        return;
    }

    ds_stream_t *stream = ds_stream_new(client, path);
    if (!stream) {
        free(path);
        send_error("head", "INTERNAL_ERROR", "failed to create stream handle");
        return;
    }

    ds_result_t result = {0};
    ds_error_t err = ds_stream_head(stream, NULL, &result);

    if (err == DS_OK) {
        char *escaped_ct = result.content_type ? json_escape(result.content_type) : strdup("\"\"");
        char fields[1024];
        snprintf(fields, sizeof(fields),
            "\"status\":200,\"offset\":\"%s\",\"contentType\":%s,\"streamClosed\":%s",
            result.next_offset ? result.next_offset : "",
            escaped_ct,
            result.stream_closed ? "true" : "false");
        free(escaped_ct);
        send_result("head", true, fields);
    } else {
        send_error("head", error_to_code(err), ds_error_string(err));
    }

    ds_result_cleanup(&result);
    ds_stream_free(stream);
    free(path);
}

static void handle_delete(const char *json) {
    char *path = json_get_string(json, "path");
    if (!path) {
        send_error("delete", "PARSE_ERROR", "missing path");
        return;
    }

    ds_stream_t *stream = ds_stream_new(client, path);
    if (!stream) {
        free(path);
        send_error("delete", "INTERNAL_ERROR", "failed to create stream handle");
        return;
    }

    ds_result_t result = {0};
    ds_error_t err = ds_stream_delete(stream, NULL, &result);

    if (err == DS_OK) {
        /* Remove from cache */
        for (int i = 0; i < stream_count; i++) {
            if (stream_paths[i] && strcmp(stream_paths[i], path) == 0) {
                free(stream_paths[i]);
                free(stream_content_types[i]);
                if (i < stream_count - 1) {
                    stream_paths[i] = stream_paths[stream_count - 1];
                    stream_content_types[i] = stream_content_types[stream_count - 1];
                }
                stream_count--;
                break;
            }
        }

        send_result("delete", true, "\"status\":200");
    } else {
        send_error("delete", error_to_code(err), ds_error_string(err));
    }

    ds_result_cleanup(&result);
    ds_stream_free(stream);
    free(path);
}

static void handle_close(const char *json) {
    char *path = json_get_string(json, "path");
    char *data = json_get_string(json, "data");
    bool binary = json_get_bool(json, "binary");

    if (!path) {
        free(data);
        send_error("close", "PARSE_ERROR", "missing path");
        return;
    }

    ds_stream_t *stream = ds_stream_new(client, path);
    if (!stream) {
        free(path);
        free(data);
        send_error("close", "INTERNAL_ERROR", "failed to create stream handle");
        return;
    }

    /* Set content type from cache */
    char *ct = get_content_type_for_path(path);
    if (ct) {
        ds_stream_set_content_type(stream, ct);
    }

    ds_close_options_t options = {0};
    char *binary_data = NULL;
    size_t binary_len = 0;

    if (data) {
        if (binary) {
            binary_data = base64_decode_to_binary(data, &binary_len);
            options.data = binary_data;
            options.data_len = binary_len;
        } else {
            options.data = data;
            options.data_len = strlen(data);
        }
    }

    ds_close_result_t result = {0};
    ds_error_t err = ds_stream_close(stream, &options, &result);

    if (err == DS_OK) {
        char fields[1024];
        snprintf(fields, sizeof(fields),
            "\"finalOffset\":\"%s\"",
            result.final_offset ? result.final_offset : "");
        send_result("close", true, fields);
    } else {
        send_error("close", error_to_code(err), ds_error_string(err));
    }

    ds_close_result_cleanup(&result);
    ds_stream_free(stream);
    free(path);
    free(data);
    free(binary_data);
}

static void handle_set_dynamic_header(const char *json) {
    char *name = json_get_string(json, "name");
    char *type = json_get_string(json, "valueType");
    char *initial = json_get_string(json, "initialValue");

    if (!name || !type) {
        free(name);
        free(type);
        free(initial);
        send_error("set-dynamic-header", "PARSE_ERROR", "missing name or valueType");
        return;
    }

    if (dynamic_header_count < MAX_DYNAMIC_HEADERS) {
        dynamic_headers[dynamic_header_count].name = name;
        dynamic_headers[dynamic_header_count].type = type;
        dynamic_headers[dynamic_header_count].counter = 0;
        dynamic_headers[dynamic_header_count].token_value = initial;
        dynamic_header_count++;
    } else {
        free(name);
        free(type);
        free(initial);
    }

    send_result("set-dynamic-header", true, NULL);
}

static void handle_set_dynamic_param(const char *json) {
    char *name = json_get_string(json, "name");
    char *type = json_get_string(json, "valueType");

    if (!name || !type) {
        free(name);
        free(type);
        send_error("set-dynamic-param", "PARSE_ERROR", "missing name or valueType");
        return;
    }

    if (dynamic_param_count < MAX_DYNAMIC_HEADERS) {
        dynamic_params[dynamic_param_count].name = name;
        dynamic_params[dynamic_param_count].type = type;
        dynamic_params[dynamic_param_count].counter = 0;
        dynamic_params[dynamic_param_count].token_value = NULL;
        dynamic_param_count++;
    } else {
        free(name);
        free(type);
    }

    send_result("set-dynamic-param", true, NULL);
}

static void handle_clear_dynamic(const char *json) {
    (void)json;

    for (int i = 0; i < dynamic_header_count; i++) {
        free(dynamic_headers[i].name);
        free(dynamic_headers[i].type);
        free(dynamic_headers[i].token_value);
    }
    dynamic_header_count = 0;

    for (int i = 0; i < dynamic_param_count; i++) {
        free(dynamic_params[i].name);
        free(dynamic_params[i].type);
        free(dynamic_params[i].token_value);
    }
    dynamic_param_count = 0;

    send_result("clear-dynamic", true, NULL);
}

static void handle_idempotent_append(const char *json) {
    char *path = json_get_string(json, "path");
    char *data = json_get_string(json, "data");
    char *producer_id = json_get_string(json, "producerId");
    int epoch = json_get_int(json, "epoch", 0);
    bool auto_claim = json_get_bool(json, "autoClaim");

    if (!path || !producer_id) {
        free(path);
        free(data);
        free(producer_id);
        send_error("idempotent-append", "PARSE_ERROR", "missing path or producerId");
        return;
    }

    char *ct = get_content_type_for_path(path);
    ds_producer_t *producer = get_producer(path, producer_id, epoch, auto_claim, ct ? ct : "application/octet-stream");

    if (!producer) {
        free(path);
        free(data);
        free(producer_id);
        send_error("idempotent-append", "INTERNAL_ERROR", "failed to get producer");
        return;
    }

    ds_error_t err = ds_producer_append(producer, data ? data : "", data ? strlen(data) : 0);
    if (err == DS_OK) {
        err = ds_producer_flush(producer, 30000);
    }

    if (err == DS_OK) {
        send_result("idempotent-append", true, "\"status\":200");
    } else {
        send_error("idempotent-append", error_to_code(err), ds_error_string(err));
    }

    free(path);
    free(data);
    free(producer_id);
}

static void handle_idempotent_append_batch(const char *json) {
    char *path = json_get_string(json, "path");
    char *producer_id = json_get_string(json, "producerId");
    int epoch = json_get_int(json, "epoch", 0);
    bool auto_claim = json_get_bool(json, "autoClaim");
    int max_in_flight = json_get_int(json, "maxInFlight", 1);

    int item_count = 0;
    char **items = json_get_string_array(json, "items", &item_count);

    if (!path || !producer_id) {
        free(path);
        free(producer_id);
        free_string_array(items, item_count);
        send_error("idempotent-append-batch", "PARSE_ERROR", "missing path or producerId");
        return;
    }

    char url[4096];
    snprintf(url, sizeof(url), "%s%s", server_url, path);

    char *ct = get_content_type_for_path(path);

    ds_producer_config_t config = {
        .epoch = epoch,
        .auto_claim = auto_claim,
        .max_in_flight = max_in_flight,
        .linger_ms = max_in_flight > 1 ? 0 : 1000,
        .max_batch_bytes = max_in_flight > 1 ? 1 : 1048576,
        .content_type = ct ? ct : "application/octet-stream"
    };

    ds_producer_t *producer = ds_producer_new(client, url, producer_id, &config);
    if (!producer) {
        free(path);
        free(producer_id);
        free_string_array(items, item_count);
        send_error("idempotent-append-batch", "INTERNAL_ERROR", "failed to create producer");
        return;
    }

    ds_error_t err = DS_OK;
    for (int i = 0; i < item_count && err == DS_OK; i++) {
        err = ds_producer_append(producer, items[i], strlen(items[i]));
    }

    if (err == DS_OK) {
        err = ds_producer_flush(producer, 30000);
    }

    ds_producer_free(producer);

    if (err == DS_OK) {
        send_result("idempotent-append-batch", true, "\"status\":200");
    } else {
        send_error("idempotent-append-batch", error_to_code(err), ds_error_string(err));
    }

    free(path);
    free(producer_id);
    free_string_array(items, item_count);
}

static void handle_idempotent_close(const char *json) {
    char *path = json_get_string(json, "path");
    char *data = json_get_string(json, "data");
    bool binary = json_get_bool(json, "binary");
    char *producer_id = json_get_string(json, "producerId");
    int epoch = json_get_int(json, "epoch", 0);
    bool auto_claim = json_get_bool(json, "autoClaim");

    if (!path || !producer_id) {
        free(path);
        free(data);
        free(producer_id);
        send_error("idempotent-close", "PARSE_ERROR", "missing path or producerId");
        return;
    }

    char *ct = get_content_type_for_path(path);
    ds_producer_t *producer = get_producer(path, producer_id, epoch, auto_claim, ct ? ct : "application/octet-stream");

    if (!producer) {
        free(path);
        free(data);
        free(producer_id);
        send_error("idempotent-close", "INTERNAL_ERROR", "failed to get producer");
        return;
    }

    char *binary_data = NULL;
    size_t binary_len = 0;
    const char *close_data = data;
    size_t close_len = data ? strlen(data) : 0;

    if (data && binary) {
        binary_data = base64_decode_to_binary(data, &binary_len);
        close_data = binary_data;
        close_len = binary_len;
    }

    ds_close_result_t result = {0};
    ds_error_t err = ds_producer_close_stream(producer, close_data, close_len, &result, 30000);

    if (err == DS_OK) {
        char fields[1024];
        snprintf(fields, sizeof(fields),
            "\"status\":200,\"finalOffset\":\"%s\"",
            result.final_offset ? result.final_offset : "");
        send_result("idempotent-close", true, fields);
    } else {
        send_error("idempotent-close", error_to_code(err), ds_error_string(err));
    }

    ds_close_result_cleanup(&result);
    free(path);
    free(data);
    free(producer_id);
    free(binary_data);
}

static void handle_idempotent_detach(const char *json) {
    char *path = json_get_string(json, "path");
    char *producer_id = json_get_string(json, "producerId");

    if (path && producer_id) {
        detach_producer(path, producer_id);
    }

    send_result("idempotent-detach", true, "\"status\":200");

    free(path);
    free(producer_id);
}

static void handle_validate(const char *json) {
    /* Extract target */
    char *target_str = NULL;

    /* Find "target": { ... } in the JSON */
    const char *target_start = strstr(json, "\"target\"");
    if (target_start) {
        target_start = strchr(target_start, '{');
        if (target_start) {
            /* Find matching closing brace */
            int depth = 1;
            const char *p = target_start + 1;
            while (*p && depth > 0) {
                if (*p == '{') depth++;
                else if (*p == '}') depth--;
                p++;
            }
            size_t len = p - target_start;
            target_str = strndup(target_start, len);
        }
    }

    if (!target_str) {
        send_error("validate", "PARSE_ERROR", "missing target");
        return;
    }

    char *target_type = json_get_string(target_str, "target");
    if (!target_type) {
        free(target_str);
        send_error("validate", "PARSE_ERROR", "missing target.target");
        return;
    }

    if (strcmp(target_type, "idempotent-producer") == 0) {
        /* Test IdempotentProducer validation */
        char *producer_id = json_get_string(target_str, "producerId");
        int epoch = json_get_int(target_str, "epoch", 0);
        int max_batch_bytes = json_get_int(target_str, "maxBatchBytes", 1048576);

        /* Check for invalid configuration */
        if (epoch < 0 || max_batch_bytes < 0) {
            send_error("validate", "INVALID_ARGUMENT", "invalid configuration");
        } else {
            send_result("validate", true, NULL);
        }

        free(producer_id);
    } else if (strcmp(target_type, "retry-options") == 0) {
        /* C client doesn't have a separate RetryOptions class */
        send_error("validate", "NOT_SUPPORTED", "C client does not have RetryOptions class");
    } else {
        send_error("validate", "NOT_SUPPORTED", "unknown validation target");
    }

    free(target_type);
    free(target_str);
}
