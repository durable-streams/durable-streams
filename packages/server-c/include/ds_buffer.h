/**
 * Durable Streams Server - Buffer Management
 *
 * Dynamic buffer utilities for efficient memory management.
 */

#ifndef DS_BUFFER_H
#define DS_BUFFER_H

#include "ds_types.h"
#include <stdlib.h>
#include <string.h>

/**
 * Initialize a buffer.
 */
static inline void ds_buffer_init(ds_buffer_t *buf) {
    buf->data = NULL;
    buf->len = 0;
    buf->capacity = 0;
}

/**
 * Free buffer memory.
 */
static inline void ds_buffer_free(ds_buffer_t *buf) {
    if (buf->data) {
        free(buf->data);
        buf->data = NULL;
    }
    buf->len = 0;
    buf->capacity = 0;
}

/**
 * Ensure buffer has at least 'needed' bytes of capacity.
 * Returns 0 on success, -1 on allocation failure.
 */
static inline int ds_buffer_ensure(ds_buffer_t *buf, size_t needed) {
    if (buf->capacity >= needed) {
        return 0;
    }

    size_t new_cap = buf->capacity ? buf->capacity : DS_INITIAL_BUFFER_SIZE;
    while (new_cap < needed) {
        new_cap *= 2;
    }

    uint8_t *new_data = (uint8_t *)realloc(buf->data, new_cap);
    if (!new_data) {
        return -1;
    }

    buf->data = new_data;
    buf->capacity = new_cap;
    return 0;
}

/**
 * Append data to buffer.
 * Returns 0 on success, -1 on allocation failure.
 */
static inline int ds_buffer_append(ds_buffer_t *buf, const void *data, size_t len) {
    if (ds_buffer_ensure(buf, buf->len + len) != 0) {
        return -1;
    }
    memcpy(buf->data + buf->len, data, len);
    buf->len += len;
    return 0;
}

/**
 * Append a single byte to buffer.
 */
static inline int ds_buffer_append_byte(ds_buffer_t *buf, uint8_t byte) {
    return ds_buffer_append(buf, &byte, 1);
}

/**
 * Append a string to buffer (without null terminator).
 */
static inline int ds_buffer_append_str(ds_buffer_t *buf, const char *str) {
    return ds_buffer_append(buf, str, strlen(str));
}

/**
 * Clear buffer contents (keep capacity).
 */
static inline void ds_buffer_clear(ds_buffer_t *buf) {
    buf->len = 0;
}

/**
 * Create a copy of the buffer.
 * Returns 0 on success, -1 on allocation failure.
 */
static inline int ds_buffer_copy(ds_buffer_t *dst, const ds_buffer_t *src) {
    ds_buffer_init(dst);
    if (src->len == 0) {
        return 0;
    }
    if (ds_buffer_ensure(dst, src->len) != 0) {
        return -1;
    }
    memcpy(dst->data, src->data, src->len);
    dst->len = src->len;
    return 0;
}

/**
 * Set buffer content from data.
 * Returns 0 on success, -1 on allocation failure.
 */
static inline int ds_buffer_set(ds_buffer_t *buf, const void *data, size_t len) {
    ds_buffer_clear(buf);
    return ds_buffer_append(buf, data, len);
}

#endif /* DS_BUFFER_H */
