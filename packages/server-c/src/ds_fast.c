/**
 * Durable Streams Server - Ultra-Fast Implementation
 *
 * Zero-allocation hot paths, lock-free pools, time caching.
 */

#include "ds_fast.h"
#include <pthread.h>
#include <sys/time.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Global time cache */
ds_time_cache_t g_time_cache = {0};

/* Time update thread */
static pthread_t time_thread;
static volatile bool time_thread_running = false;

static void *time_update_loop(void *arg) {
    (void)arg;
    while (time_thread_running) {
        ds_update_time_cache();
        usleep(1000);  /* Update every 1ms */
    }
    return NULL;
}

void ds_update_time_cache(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    uint64_t ms = (uint64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
    atomic_store_explicit(&g_time_cache.cached_ms, ms, memory_order_relaxed);
    atomic_store_explicit(&g_time_cache.cached_sec, (uint64_t)tv.tv_sec, memory_order_relaxed);
}

void ds_time_cache_start(void) {
    ds_update_time_cache();
    time_thread_running = true;
    pthread_create(&time_thread, NULL, time_update_loop, NULL);
}

void ds_time_cache_stop(void) {
    time_thread_running = false;
    pthread_join(time_thread, NULL);
}

/* Buffer pool implementation */
ds_buffer_pool_t *ds_buffer_pool_create(void) {
    ds_buffer_pool_t *pool = aligned_alloc(CACHE_LINE_SIZE, sizeof(ds_buffer_pool_t));
    if (!pool) return NULL;
    memset(pool, 0, sizeof(*pool));

    /* Pre-allocate buffers */
    for (int i = 0; i < BUFFER_POOL_SIZE / 2; i++) {
        pool->small_buffers[i] = aligned_alloc(CACHE_LINE_SIZE, SMALL_BUFFER_SIZE);
        pool->medium_buffers[i] = aligned_alloc(CACHE_LINE_SIZE, MEDIUM_BUFFER_SIZE);
        pool->large_buffers[i] = aligned_alloc(CACHE_LINE_SIZE, LARGE_BUFFER_SIZE);
    }

    atomic_store(&pool->small_tail, BUFFER_POOL_SIZE / 2);
    atomic_store(&pool->medium_tail, BUFFER_POOL_SIZE / 2);
    atomic_store(&pool->large_tail, BUFFER_POOL_SIZE / 2);

    return pool;
}

void ds_buffer_pool_destroy(ds_buffer_pool_t *pool) {
    if (!pool) return;

    /* Free remaining buffers */
    uint32_t head, tail;

    head = atomic_load(&pool->small_head);
    tail = atomic_load(&pool->small_tail);
    for (uint32_t i = head; i < tail; i++) {
        free(pool->small_buffers[i % BUFFER_POOL_SIZE]);
    }

    head = atomic_load(&pool->medium_head);
    tail = atomic_load(&pool->medium_tail);
    for (uint32_t i = head; i < tail; i++) {
        free(pool->medium_buffers[i % BUFFER_POOL_SIZE]);
    }

    head = atomic_load(&pool->large_head);
    tail = atomic_load(&pool->large_tail);
    for (uint32_t i = head; i < tail; i++) {
        free(pool->large_buffers[i % BUFFER_POOL_SIZE]);
    }

    free(pool);
}
