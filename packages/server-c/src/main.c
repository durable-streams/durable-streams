/**
 * Durable Streams Server - Main Entry Point
 *
 * High-performance C server for the Durable Streams protocol.
 */

#include "ds_server.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <getopt.h>

static volatile sig_atomic_t running = 1;

static void signal_handler(int sig) {
    (void)sig;
    running = 0;
}

static void print_usage(const char *prog) {
    printf("Usage: %s [OPTIONS]\n", prog);
    printf("\n");
    printf("Durable Streams Server - High-performance C implementation\n");
    printf("\n");
    printf("Options:\n");
    printf("  -p, --port PORT          Port to listen on (default: 4437)\n");
    printf("  -h, --host HOST          Host to bind to (default: 127.0.0.1)\n");
    printf("  -t, --timeout MS         Long-poll timeout in milliseconds (default: 30000)\n");
    printf("  --no-compression         Disable response compression\n");
    printf("  --help                   Show this help message\n");
    printf("\n");
    printf("Examples:\n");
    printf("  %s                       # Start on default port 4437\n", prog);
    printf("  %s -p 8080               # Start on port 8080\n", prog);
    printf("  %s -h 0.0.0.0 -p 4437    # Bind to all interfaces\n", prog);
    printf("\n");
}

int main(int argc, char *argv[]) {
    ds_server_config_t config;
    ds_config_init(&config);

    static struct option long_options[] = {
        {"port", required_argument, 0, 'p'},
        {"host", required_argument, 0, 'h'},
        {"timeout", required_argument, 0, 't'},
        {"no-compression", no_argument, 0, 'n'},
        {"help", no_argument, 0, '?'},
        {0, 0, 0, 0}
    };

    int opt;
    int option_index = 0;

    while ((opt = getopt_long(argc, argv, "p:h:t:n", long_options, &option_index)) != -1) {
        switch (opt) {
            case 'p':
                config.port = (uint16_t)atoi(optarg);
                break;
            case 'h':
                config.host = optarg;
                break;
            case 't':
                config.long_poll_timeout_ms = atoi(optarg);
                break;
            case 'n':
                config.compression = false;
                break;
            case '?':
            default:
                print_usage(argv[0]);
                return opt == '?' ? 0 : 1;
        }
    }

    /* Set up signal handlers */
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    printf("Starting Durable Streams Server...\n");
    printf("  Host: %s\n", config.host);
    printf("  Port: %d\n", config.port);
    printf("  Long-poll timeout: %d ms\n", config.long_poll_timeout_ms);
    printf("  Compression: %s\n", config.compression ? "enabled" : "disabled");
    printf("\n");

    ds_server_t *server = ds_server_create(&config);
    if (!server) {
        fprintf(stderr, "Failed to create server\n");
        return 1;
    }

    printf("Server running on http://%s:%d\n", config.host, config.port);
    printf("Press Ctrl+C to stop\n");

    /* Main loop - just wait for signals */
    while (running) {
        sleep(1);
    }

    printf("\nShutting down...\n");
    ds_server_destroy(server);
    printf("Server stopped\n");

    return 0;
}
