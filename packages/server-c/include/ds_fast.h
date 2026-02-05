/**
 * Durable Streams Server - Ultra-Fast Optimizations
 *
 * Zero-allocation hot paths, SIMD-friendly layouts, lock-free where possible.
 */

#ifndef DS_FAST_H
#define DS_FAST_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <pthread.h>

/* Branch prediction hints */
#define LIKELY(x)   __builtin_expect(!!(x), 1)
#define UNLIKELY(x) __builtin_expect(!!(x), 0)

/* Cache line alignment */
#define CACHE_LINE_SIZE 64
#define CACHE_ALIGNED __attribute__((aligned(CACHE_LINE_SIZE)))

/* Prefetch hints */
#define PREFETCH_READ(addr) __builtin_prefetch((addr), 0, 3)
#define PREFETCH_WRITE(addr) __builtin_prefetch((addr), 1, 3)

/* Memory pool configuration */
#define POOL_BLOCK_SIZE 4096
#define POOL_MAX_BLOCKS 1024
#define REQUEST_CTX_POOL_SIZE 256
#define BUFFER_POOL_SIZE 512
#define SMALL_BUFFER_SIZE 256
#define MEDIUM_BUFFER_SIZE 4096
#define LARGE_BUFFER_SIZE 65536

/* Message array configuration */
#define INITIAL_MSG_CAPACITY 16
#define MSG_GROWTH_FACTOR 2

/**
 * Memory pool for zero-allocation request handling.
 */
typedef struct ds_pool_block {
    uint8_t data[POOL_BLOCK_SIZE];
    struct ds_pool_block *next;
    _Atomic uint32_t ref_count;
} ds_pool_block_t;

typedef struct ds_memory_pool {
    ds_pool_block_t *free_list;
    _Atomic uint32_t free_count;
    pthread_spinlock_t lock;
} ds_memory_pool_t;

/**
 * Lock-free buffer pool for common sizes.
 */
typedef struct ds_buffer_pool {
    void *small_buffers[BUFFER_POOL_SIZE];  /* 256 bytes */
    void *medium_buffers[BUFFER_POOL_SIZE]; /* 4KB */
    void *large_buffers[BUFFER_POOL_SIZE];  /* 64KB */
    _Atomic uint32_t small_head, small_tail;
    _Atomic uint32_t medium_head, medium_tail;
    _Atomic uint32_t large_head, large_tail;
} ds_buffer_pool_t;

/**
 * Fast buffer with size class tracking.
 */
typedef struct ds_fast_buffer {
    uint8_t *data;
    uint32_t len;
    uint32_t capacity;
    uint8_t size_class;  /* 0=small, 1=medium, 2=large, 3=heap */
} ds_fast_buffer_t;

/**
 * Coarse-grained time cache to avoid syscalls.
 */
typedef struct ds_time_cache {
    _Atomic uint64_t cached_ms;
    _Atomic uint64_t cached_sec;
} CACHE_ALIGNED ds_time_cache_t;

/**
 * Pre-formatted offset for zero-copy responses.
 */
typedef struct ds_offset {
    char str[34];  /* "0000000000000000_0000000000000000\0" */
    uint64_t read_seq;
    uint64_t byte_offset;
} ds_offset_t;

/**
 * Array-based message storage (cache-friendly).
 */
typedef struct ds_message_array {
    uint8_t **data;           /* Array of message data pointers */
    uint32_t *lengths;        /* Array of message lengths */
    ds_offset_t *offsets;     /* Array of pre-formatted offsets */
    uint32_t count;
    uint32_t capacity;
} ds_message_array_t;

/**
 * Optimized stream structure with better cache layout.
 */
typedef struct ds_fast_stream {
    /* Hot data - first cache line */
    ds_offset_t current_offset CACHE_ALIGNED;
    _Atomic uint64_t byte_offset;
    _Atomic uint32_t message_count;
    _Atomic bool closed;

    /* Message storage - second cache line */
    ds_message_array_t messages CACHE_ALIGNED;
    pthread_mutex_t msg_lock;
    pthread_cond_t cond;

    /* Cold metadata - third cache line */
    char path[256] CACHE_ALIGNED;
    char content_type[64];
    uint64_t created_at;
    int64_t ttl_seconds;

    /* Producer state */
    struct ds_producer_state *producers;
    struct ds_closed_by *closed_by;

    /* Hash chain */
    struct ds_fast_stream *next;
} ds_fast_stream_t;

/* ============================================================================
 * Ultra-fast offset formatting (no snprintf!)
 * ============================================================================ */

static const char DIGIT_PAIRS[201] =
    "00010203040506070809"
    "10111213141516171819"
    "20212223242526272829"
    "30313233343536373839"
    "40414243444546474849"
    "50515253545556575859"
    "60616263646566676869"
    "70717273747576777879"
    "80818283848586878889"
    "90919293949596979899";

static inline void fast_u64_to_str(char *buf, uint64_t val) {
    /* Format 16-digit zero-padded number */
    char temp[16];
    int pos = 15;

    /* Convert 2 digits at a time */
    while (val >= 100) {
        uint64_t q = val / 100;
        uint64_t r = val % 100;
        temp[pos--] = DIGIT_PAIRS[r * 2 + 1];
        temp[pos--] = DIGIT_PAIRS[r * 2];
        val = q;
    }

    /* Last 1-2 digits */
    if (val >= 10) {
        temp[pos--] = DIGIT_PAIRS[val * 2 + 1];
        temp[pos--] = DIGIT_PAIRS[val * 2];
    } else {
        temp[pos--] = '0' + val;
    }

    /* Zero-pad */
    while (pos >= 0) {
        temp[pos--] = '0';
    }

    memcpy(buf, temp, 16);
}

static inline void fast_format_offset(ds_offset_t *offset, uint64_t read_seq, uint64_t byte_off) {
    fast_u64_to_str(offset->str, read_seq);
    offset->str[16] = '_';
    fast_u64_to_str(offset->str + 17, byte_off);
    offset->str[33] = '\0';
    offset->read_seq = read_seq;
    offset->byte_offset = byte_off;
}

/* ============================================================================
 * Fast string comparison with length
 * ============================================================================ */

static inline bool fast_streq(const char *a, const char *b, size_t len) {
    return memcmp(a, b, len) == 0;
}

static inline bool fast_strieq(const char *a, const char *b, size_t len) {
    for (size_t i = 0; i < len; i++) {
        char ca = a[i];
        char cb = b[i];
        if (ca >= 'A' && ca <= 'Z') ca += 32;
        if (cb >= 'A' && cb <= 'Z') cb += 32;
        if (ca != cb) return false;
    }
    return true;
}

/* ============================================================================
 * Fast HTTP method detection
 * ============================================================================ */

typedef enum {
    HTTP_GET = 0,
    HTTP_POST,
    HTTP_PUT,
    HTTP_DELETE,
    HTTP_HEAD,
    HTTP_OPTIONS,
    HTTP_UNKNOWN
} http_method_t;

static inline http_method_t fast_parse_method(const char *method) {
    /* Fast path: check first character */
    switch (method[0]) {
        case 'G':
            if (LIKELY(method[1] == 'E' && method[2] == 'T' && method[3] == '\0'))
                return HTTP_GET;
            break;
        case 'P':
            if (method[1] == 'O') {
                if (LIKELY(method[2] == 'S' && method[3] == 'T' && method[4] == '\0'))
                    return HTTP_POST;
            } else if (method[1] == 'U') {
                if (LIKELY(method[2] == 'T' && method[3] == '\0'))
                    return HTTP_PUT;
            }
            break;
        case 'D':
            if (LIKELY(fast_streq(method, "DELETE", 6) && method[6] == '\0'))
                return HTTP_DELETE;
            break;
        case 'H':
            if (LIKELY(method[1] == 'E' && method[2] == 'A' && method[3] == 'D' && method[4] == '\0'))
                return HTTP_HEAD;
            break;
        case 'O':
            if (LIKELY(fast_streq(method, "OPTIONS", 7) && method[7] == '\0'))
                return HTTP_OPTIONS;
            break;
    }
    return HTTP_UNKNOWN;
}

/* ============================================================================
 * Fast content-type detection
 * ============================================================================ */

static inline bool fast_is_json(const char *ct) {
    if (UNLIKELY(!ct)) return false;

    /* Skip whitespace */
    while (*ct == ' ') ct++;

    /* Check for "application/json" (16 chars) */
    if (LIKELY(ct[0] == 'a' || ct[0] == 'A')) {
        return fast_strieq(ct, "application/json", 16) &&
               (ct[16] == '\0' || ct[16] == ';' || ct[16] == ' ');
    }
    return false;
}

/* ============================================================================
 * Coarse time cache
 * ============================================================================ */

extern ds_time_cache_t g_time_cache;

static inline uint64_t fast_time_ms(void) {
    return atomic_load_explicit(&g_time_cache.cached_ms, memory_order_relaxed);
}

static inline uint64_t fast_time_sec(void) {
    return atomic_load_explicit(&g_time_cache.cached_sec, memory_order_relaxed);
}

/* Update time cache (call from timer thread) */
void ds_update_time_cache(void);

/* ============================================================================
 * Buffer pool operations
 * ============================================================================ */

ds_buffer_pool_t *ds_buffer_pool_create(void);
void ds_buffer_pool_destroy(ds_buffer_pool_t *pool);

static inline void *ds_pool_alloc(ds_buffer_pool_t *pool, size_t size, uint8_t *size_class) {
    if (size <= SMALL_BUFFER_SIZE) {
        uint32_t head = atomic_load_explicit(&pool->small_head, memory_order_acquire);
        uint32_t tail = atomic_load_explicit(&pool->small_tail, memory_order_relaxed);
        if (head != tail) {
            uint32_t idx = head % BUFFER_POOL_SIZE;
            void *buf = pool->small_buffers[idx];
            if (atomic_compare_exchange_weak(&pool->small_head, &head, head + 1)) {
                *size_class = 0;
                return buf;
            }
        }
        *size_class = 3;  /* Fallback to heap */
        return malloc(SMALL_BUFFER_SIZE);
    }

    if (size <= MEDIUM_BUFFER_SIZE) {
        uint32_t head = atomic_load_explicit(&pool->medium_head, memory_order_acquire);
        uint32_t tail = atomic_load_explicit(&pool->medium_tail, memory_order_relaxed);
        if (head != tail) {
            uint32_t idx = head % BUFFER_POOL_SIZE;
            void *buf = pool->medium_buffers[idx];
            if (atomic_compare_exchange_weak(&pool->medium_head, &head, head + 1)) {
                *size_class = 1;
                return buf;
            }
        }
        *size_class = 3;
        return malloc(MEDIUM_BUFFER_SIZE);
    }

    if (size <= LARGE_BUFFER_SIZE) {
        uint32_t head = atomic_load_explicit(&pool->large_head, memory_order_acquire);
        uint32_t tail = atomic_load_explicit(&pool->large_tail, memory_order_relaxed);
        if (head != tail) {
            uint32_t idx = head % BUFFER_POOL_SIZE;
            void *buf = pool->large_buffers[idx];
            if (atomic_compare_exchange_weak(&pool->large_head, &head, head + 1)) {
                *size_class = 2;
                return buf;
            }
        }
        *size_class = 3;
        return malloc(LARGE_BUFFER_SIZE);
    }

    *size_class = 3;
    return malloc(size);
}

static inline void ds_pool_free(ds_buffer_pool_t *pool, void *buf, uint8_t size_class) {
    if (size_class == 3) {
        free(buf);
        return;
    }

    switch (size_class) {
        case 0: {
            uint32_t tail = atomic_load_explicit(&pool->small_tail, memory_order_relaxed);
            uint32_t head = atomic_load_explicit(&pool->small_head, memory_order_acquire);
            if (tail - head < BUFFER_POOL_SIZE) {
                pool->small_buffers[tail % BUFFER_POOL_SIZE] = buf;
                atomic_store_explicit(&pool->small_tail, tail + 1, memory_order_release);
                return;
            }
            break;
        }
        case 1: {
            uint32_t tail = atomic_load_explicit(&pool->medium_tail, memory_order_relaxed);
            uint32_t head = atomic_load_explicit(&pool->medium_head, memory_order_acquire);
            if (tail - head < BUFFER_POOL_SIZE) {
                pool->medium_buffers[tail % BUFFER_POOL_SIZE] = buf;
                atomic_store_explicit(&pool->medium_tail, tail + 1, memory_order_release);
                return;
            }
            break;
        }
        case 2: {
            uint32_t tail = atomic_load_explicit(&pool->large_tail, memory_order_relaxed);
            uint32_t head = atomic_load_explicit(&pool->large_head, memory_order_acquire);
            if (tail - head < BUFFER_POOL_SIZE) {
                pool->large_buffers[tail % BUFFER_POOL_SIZE] = buf;
                atomic_store_explicit(&pool->large_tail, tail + 1, memory_order_release);
                return;
            }
            break;
        }
    }

    free(buf);
}

/* ============================================================================
 * Message array operations
 * ============================================================================ */

static inline int ds_msg_array_init(ds_message_array_t *arr) {
    arr->data = malloc(INITIAL_MSG_CAPACITY * sizeof(uint8_t *));
    arr->lengths = malloc(INITIAL_MSG_CAPACITY * sizeof(uint32_t));
    arr->offsets = malloc(INITIAL_MSG_CAPACITY * sizeof(ds_offset_t));
    arr->count = 0;
    arr->capacity = INITIAL_MSG_CAPACITY;
    return (arr->data && arr->lengths && arr->offsets) ? 0 : -1;
}

static inline int ds_msg_array_append(ds_message_array_t *arr,
                                       const uint8_t *data, uint32_t len,
                                       uint64_t read_seq, uint64_t byte_off) {
    if (UNLIKELY(arr->count >= arr->capacity)) {
        uint32_t new_cap = arr->capacity * MSG_GROWTH_FACTOR;
        uint8_t **new_data = realloc(arr->data, new_cap * sizeof(uint8_t *));
        uint32_t *new_lengths = realloc(arr->lengths, new_cap * sizeof(uint32_t));
        ds_offset_t *new_offsets = realloc(arr->offsets, new_cap * sizeof(ds_offset_t));
        if (!new_data || !new_lengths || !new_offsets) return -1;
        arr->data = new_data;
        arr->lengths = new_lengths;
        arr->offsets = new_offsets;
        arr->capacity = new_cap;
    }

    uint8_t *msg_data = malloc(len);
    if (!msg_data) return -1;
    memcpy(msg_data, data, len);

    arr->data[arr->count] = msg_data;
    arr->lengths[arr->count] = len;
    fast_format_offset(&arr->offsets[arr->count], read_seq, byte_off);
    arr->count++;

    return 0;
}

static inline void ds_msg_array_free(ds_message_array_t *arr) {
    if (arr->data) {
        for (uint32_t i = 0; i < arr->count; i++) {
            free(arr->data[i]);
        }
        free(arr->data);
    }
    free(arr->lengths);
    free(arr->offsets);
    arr->data = NULL;
    arr->lengths = NULL;
    arr->offsets = NULL;
    arr->count = 0;
    arr->capacity = 0;
}

/* ============================================================================
 * Pre-computed static response headers
 * ============================================================================ */

/* Common headers as single string for efficient sending */
#define CORS_HEADERS \
    "Access-Control-Allow-Origin: *\r\n" \
    "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, HEAD, OPTIONS\r\n" \
    "Access-Control-Allow-Headers: Content-Type, Authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq\r\n" \
    "Access-Control-Expose-Headers: Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, ETag, Content-Type, Content-Encoding, Vary\r\n" \
    "X-Content-Type-Options: nosniff\r\n" \
    "Cross-Origin-Resource-Policy: cross-origin\r\n"

#define CORS_HEADERS_LEN (sizeof(CORS_HEADERS) - 1)

#endif /* DS_FAST_H */
