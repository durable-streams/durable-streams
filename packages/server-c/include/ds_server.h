/**
 * Durable Streams Server - HTTP Server
 *
 * High-performance HTTP server using libmicrohttpd.
 */

#ifndef DS_SERVER_H
#define DS_SERVER_H

#include "ds_types.h"
#include "ds_store.h"

/* Forward declaration */
struct MHD_Daemon;

/**
 * Server instance.
 */
typedef struct ds_server {
    struct MHD_Daemon *daemon;
    ds_store_t *store;
    ds_server_config_t config;
    volatile bool running;
} ds_server_t;

/**
 * Create and start a new server.
 * Returns NULL on failure.
 */
ds_server_t *ds_server_create(const ds_server_config_t *config);

/**
 * Stop and destroy the server.
 */
void ds_server_destroy(ds_server_t *server);

/**
 * Get the server's store (for testing).
 */
ds_store_t *ds_server_get_store(ds_server_t *server);

/**
 * Clear all streams (for testing).
 */
void ds_server_clear(ds_server_t *server);

/**
 * Get the actual port the server is listening on.
 */
uint16_t ds_server_get_port(ds_server_t *server);

#endif /* DS_SERVER_H */
