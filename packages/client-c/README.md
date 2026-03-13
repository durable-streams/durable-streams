# Durable Streams C Client

A pure C client library for the Durable Streams protocol using libcurl.

## Requirements

- C11 compatible compiler (gcc, clang)
- libcurl (with development headers)

### Installing libcurl

**Ubuntu/Debian:**

```bash
sudo apt-get install libcurl4-openssl-dev
```

**macOS (Homebrew):**

```bash
brew install curl
```

**Fedora/RHEL:**

```bash
sudo dnf install libcurl-devel
```

## Building

```bash
make
```

This builds:

- `build/libdurablestreams.a` - Static library
- `build/conformance_adapter` - Conformance test adapter

## Usage

```c
#include "durable_streams.h"

int main() {
    // Create client
    ds_client_config_t config = {
        .base_url = "http://localhost:4437",
        .timeout_ms = 30000
    };
    ds_client_t *client = ds_client_new(&config);

    // Create stream
    ds_stream_t *stream = ds_stream_new(client, "/my-stream");

    ds_create_options_t create_opts = {
        .content_type = "application/json"
    };
    ds_result_t result = {0};
    ds_stream_create(stream, &create_opts, &result);
    printf("Created at offset: %s\n", result.next_offset);
    ds_result_cleanup(&result);

    // Append data
    const char *data = "[{\"event\":\"test\"}]";
    ds_stream_set_content_type(stream, "application/json");
    ds_stream_append(stream, data, strlen(data), NULL, &result);
    printf("Appended at offset: %s\n", result.next_offset);
    ds_result_cleanup(&result);

    // Read data
    ds_read_options_t read_opts = {
        .live = DS_LIVE_NONE
    };
    ds_iterator_t *iter = ds_stream_read(stream, &read_opts);

    ds_chunk_t chunk = {0};
    while (ds_iterator_next(iter, &chunk) == DS_OK) {
        printf("Data: %.*s\n", (int)chunk.data_len, chunk.data);
        ds_chunk_cleanup(&chunk);
    }
    ds_iterator_free(iter);

    // Clean up
    ds_stream_free(stream);
    ds_client_free(client);

    return 0;
}
```

## API Reference

### Client

```c
// Create a new client
ds_client_t *ds_client_new(const ds_client_config_t *config);

// Free client resources
void ds_client_free(ds_client_t *client);
```

### Stream Operations

```c
// Create a stream handle
ds_stream_t *ds_stream_new(ds_client_t *client, const char *path);

// Set content type
void ds_stream_set_content_type(ds_stream_t *stream, const char *content_type);

// Create stream (PUT)
ds_error_t ds_stream_create(ds_stream_t *stream, const ds_create_options_t *options, ds_result_t *result);

// Append to stream (POST)
ds_error_t ds_stream_append(ds_stream_t *stream, const char *data, size_t data_len,
                            const ds_append_options_t *options, ds_result_t *result);

// Close stream
ds_error_t ds_stream_close(ds_stream_t *stream, const ds_close_options_t *options, ds_close_result_t *result);

// Get stream metadata (HEAD)
ds_error_t ds_stream_head(ds_stream_t *stream, const char **headers, ds_result_t *result);

// Delete stream (DELETE)
ds_error_t ds_stream_delete(ds_stream_t *stream, const char **headers, ds_result_t *result);
```

### Reading

```c
// Create a read iterator
ds_iterator_t *ds_stream_read(ds_stream_t *stream, const ds_read_options_t *options);

// Get next chunk
ds_error_t ds_iterator_next(ds_iterator_t *iter, ds_chunk_t *chunk);

// Check iterator state
const char *ds_iterator_offset(const ds_iterator_t *iter);
bool ds_iterator_up_to_date(const ds_iterator_t *iter);
bool ds_iterator_stream_closed(const ds_iterator_t *iter);

// Free iterator
void ds_iterator_free(ds_iterator_t *iter);
```

### Idempotent Producer

```c
// Create a producer
ds_producer_t *ds_producer_new(ds_client_t *client, const char *url, const char *producer_id,
                               const ds_producer_config_t *config);

// Append data (queued for batching)
ds_error_t ds_producer_append(ds_producer_t *producer, const char *data, size_t data_len);

// Flush queued data
ds_error_t ds_producer_flush(ds_producer_t *producer, long timeout_ms);

// Close stream via producer
ds_error_t ds_producer_close_stream(ds_producer_t *producer, const char *final_data, size_t data_len,
                                    ds_close_result_t *result, long timeout_ms);

// Free producer
void ds_producer_free(ds_producer_t *producer);
```

### Live Modes

```c
typedef enum {
    DS_LIVE_NONE = 0,      // Catch-up only
    DS_LIVE_LONG_POLL = 1, // Long-polling
    DS_LIVE_SSE = 2        // Server-Sent Events
} ds_live_mode_t;
```

### Error Handling

```c
typedef enum {
    DS_OK = 0,
    DS_ERR_INVALID_ARGUMENT = -1,
    DS_ERR_OUT_OF_MEMORY = -2,
    DS_ERR_NETWORK = -3,
    DS_ERR_HTTP = -4,
    DS_ERR_NOT_FOUND = -5,
    DS_ERR_CONFLICT = -6,
    DS_ERR_STREAM_CLOSED = -7,
    DS_ERR_INVALID_OFFSET = -8,
    DS_ERR_PARSE_ERROR = -9,
    DS_ERR_TIMEOUT = -10,
    DS_ERR_STALE_EPOCH = -11,
    DS_ERR_SEQUENCE_GAP = -12,
    DS_ERR_DONE = -13,
    DS_ERR_INTERNAL = -99
} ds_error_t;

// Get error message
const char *ds_error_string(ds_error_t error);
```

## Running Conformance Tests

```bash
# Build the adapter
make adapter

# Run tests (from repo root)
pnpm test:run -- --client c
```

## License

MIT
