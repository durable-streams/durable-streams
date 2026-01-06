# Durable Streams Fortran Client

A Fortran client library for the [Durable Streams](https://github.com/durable-streams/durable-streams) protocol.

## Features

- **Full Protocol Support**: Create, append, read, delete, and head operations
- **JSON Mode**: Automatic JSON array flattening per protocol spec
- **Live Reading**: Long-poll support for real-time streaming
- **Iterator API**: Efficient chunk-by-chunk reading
- **Custom Headers**: Support for authentication and custom headers
- **Modern Fortran**: Uses Fortran 2008 features (OOP, allocatable strings)
- **libcurl Integration**: HTTP via C interop with libcurl

## Requirements

- Fortran 2008 compatible compiler (gfortran 6+, Intel Fortran 18+)
- libcurl development files
- CMake 3.12+ (optional, Makefile also provided)

## Installation

### Using CMake

```bash
mkdir build && cd build
cmake ..
make
make install  # optional
```

### Using Make

```bash
make
make test  # run tests
```

## Quick Start

```fortran
program example
    use durable_streams
    implicit none

    type(DurableStream) :: stream
    type(StreamError) :: err
    type(AppendResult) :: result

    ! Initialize and create a stream
    call stream%init("https://example.com/streams/my-stream")
    call stream%create(content_type=JSON_CONTENT_TYPE, error=err)

    if (err%code /= DS_OK) then
        print *, "Error: ", trim(err%message)
        stop 1
    end if

    ! Append data
    call stream%append('{"message": "Hello, World!"}', result=result, error=err)
    print *, "Appended at offset: ", result%next_offset%to_string()

    ! Read all data
    character(len=:), allocatable :: data
    call stream%read_all(data, start_offset(), err)
    print *, "Data: ", trim(data)

    ! Cleanup
    call stream%delete(err)
    call stream%close()
end program example
```

## API Reference

### DurableStream Type

The main handle for stream operations.

```fortran
type(DurableStream) :: stream
```

#### Initialization

```fortran
! Initialize a stream handle
call stream%init(url)

! Connect to existing stream (verifies it exists via HEAD)
call stream%connect(url, error)

! Close and cleanup
call stream%close()
```

#### Create Operation (PUT)

```fortran
call stream%create( &
    content_type="application/json", &  ! optional
    ttl_seconds=3600, &                  ! optional: TTL in seconds
    expires_at="2025-01-15T10:30:00Z", & ! optional: RFC3339 timestamp
    initial_data='[{"init": true}]', &   ! optional: initial content
    error=err &
)
```

#### Append Operation (POST)

```fortran
! Append raw bytes/string
call stream%append(data, seq=seq, if_match=etag, result=result, error=err)

! Append JSON array
type(JsonArray) :: arr
call arr%init()
call arr%add_raw('{"event": "click"}')
call stream%append(arr, result=result, error=err)
```

#### Read Operations (GET)

```fortran
! Read a single chunk
type(StreamChunk) :: chunk
call stream%read(chunk, offset, live_mode, cursor, error)

! Read all data (catches up to current end)
character(len=:), allocatable :: data
call stream%read_all(data, offset, error)

! Read as JSON array
type(JsonArray) :: items
call stream%read_json(items, offset, error)
```

#### Other Operations

```fortran
! Get metadata (HEAD)
type(StreamMetadata) :: metadata
call stream%head(metadata, error)

! Delete stream (DELETE)
call stream%delete(error)

! Add custom header (for auth, etc.)
call stream%add_header("Authorization", "Bearer token123")
```

### StreamIterator Type

For efficient chunk-by-chunk reading.

```fortran
type(StreamIterator) :: iter
type(StreamChunk) :: chunk

call iter%init(stream, start_offset(), LIVE_MODE_LONG_POLL)

do while (.not. iter%closed)
    call iter%next(chunk, err)
    if (err%code /= DS_OK) exit

    print *, "Data: ", trim(chunk%data)
    print *, "Up-to-date: ", chunk%up_to_date
end do

call iter%close()
```

### Types

#### Offset

Opaque position token in a stream.

```fortran
type(Offset) :: off

off = start_offset()           ! Start of stream (-1)
off = Offset("abc123")         ! From string
print *, off%to_string()       ! Convert to string
print *, off%is_start()        ! Check if start offset
print *, off%is_valid()        ! Check if allocated
```

#### StreamChunk

Result from a read operation.

```fortran
type(StreamChunk) :: chunk

chunk%next_offset    ! Offset for next read
chunk%data           ! Response body (allocatable string)
chunk%up_to_date     ! True if caught up to stream end
chunk%cursor         ! CDN cursor for next request
chunk%etag           ! ETag header value
```

#### StreamMetadata

Stream information from HEAD.

```fortran
type(StreamMetadata) :: meta

meta%content_type    ! Stream's MIME type
meta%next_offset     ! Current end offset
meta%ttl             ! TTL in seconds (-1 if not set)
meta%expires_at      ! Expiration timestamp
meta%etag            ! ETag value
```

#### AppendResult

Result from append operation.

```fortran
type(AppendResult) :: result

result%next_offset   ! New tail offset after append
result%etag          ! ETag value
```

#### StreamError

Error information.

```fortran
type(StreamError) :: err

err%code             ! Error code (DS_OK, DS_ERR_*, etc.)
err%http_status      ! HTTP status code
err%message          ! Human-readable message
err%operation        ! Operation that failed
err%url              ! URL of the request

print *, err%is_ok()       ! Check for success
print *, err%to_string()   ! Full error description
```

### Error Codes

```fortran
DS_OK                      ! Success
DS_ERR_NOT_FOUND           ! Stream not found (404)
DS_ERR_CONFLICT_SEQ        ! Sequence conflict (409)
DS_ERR_CONFLICT_EXISTS     ! Stream exists with different config (409)
DS_ERR_CONTENT_TYPE_MISMATCH
DS_ERR_BAD_REQUEST         ! Invalid request (400)
DS_ERR_UNAUTHORIZED        ! Authentication required (401)
DS_ERR_FORBIDDEN           ! Access denied (403)
DS_ERR_RATE_LIMITED        ! Rate limit exceeded (429)
DS_ERR_OFFSET_GONE         ! Offset before retention window (410)
DS_ERR_NETWORK             ! Network error
DS_ERR_TIMEOUT             ! Request timeout
DS_ERR_CURL                ! libcurl error
DS_ERR_JSON_PARSE          ! JSON parsing error
DS_ERR_SSE_NOT_SUPPORTED   ! SSE not supported
DS_ERR_ALREADY_CLOSED      ! Stream/iterator already closed
```

### Live Modes

```fortran
LIVE_MODE_NONE       ! Catch-up only, stop when up-to-date
LIVE_MODE_AUTO       ! Auto-select based on operation
LIVE_MODE_LONG_POLL  ! HTTP long-polling
LIVE_MODE_SSE        ! Server-Sent Events (limited support)
```

### JSON Utilities

```fortran
type(JsonArray) :: arr
type(JsonValue) :: val

! Initialize array
call arr%init(capacity=100)  ! optional capacity

! Add items
call arr%add_null()
call arr%add_bool(.true.)
call arr%add_number(42.0d0)
call arr%add_string("hello")
call arr%add_raw('{"key": "value"}')  ! raw JSON

! Get items
val = arr%get(1)
print *, arr%size()

! Convert to JSON string
print *, arr%to_string()  ! -> '[...]'

! Clear array
call arr%clear()
```

## Examples

See the `examples/` directory:

- `basic_usage.f90` - Basic CRUD operations
- `live_read.f90` - Live reading with long-poll
- `json_example.f90` - JSON array handling

## Protocol Compliance

This client implements the [Durable Streams Protocol](../../PROTOCOL.md):

- **Offset handling**: Opaque, lexicographically sortable tokens
- **JSON mode**: Arrays flattened on append, wrapped on read
- **Headers**: Proper Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date handling
- **Content-Type**: Preserved from creation, enforced on append

## Limitations

- SSE (Server-Sent Events) mode has limited support
- No automatic batching (unlike TS/Python clients)
- No async operations (Fortran limitation)

## Building from Source

### Prerequisites

Ubuntu/Debian:
```bash
sudo apt-get install gfortran libcurl4-openssl-dev cmake
```

macOS:
```bash
brew install gcc curl cmake
```

### Build

```bash
# Using CMake
mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make

# Using Make
make
```

### Test

```bash
# Using CMake
cd build && ctest

# Using Make
make test
```

## License

MIT License - see the repository root for details.
