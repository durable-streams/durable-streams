# durable-streams

Python client for the Durable Streams protocol.

## Overview

The Durable Streams client provides two main APIs:

1. **`stream()` / `astream()` functions** - Read-only APIs for consuming streams
2. **`DurableStream` / `AsyncDurableStream` classes** - Handles for read/write operations

## Installation

```bash
pip install durable-streams
```

Or with uv:

```bash
uv add durable-streams
```

## Quick Start

### Reading from a Stream

```python
from durable_streams import stream

# Default iteration yields raw bytes chunks
with stream("https://streams.example.com/my-stream") as res:
    for chunk in res:  # bytes
        process(chunk)

# Iterate over JSON items (flattened from arrays)
with stream("https://streams.example.com/my-stream") as res:
    for item in res.iter_json():
        print(item)

# Read all items at once
with stream("https://streams.example.com/my-stream", live=False) as res:
    items = res.read_json()
    print(f"Got {len(items)} items")
```

### Async Reading

```python
from durable_streams import astream

# Direct async context manager - no await needed!
async with astream("https://streams.example.com/my-stream") as res:
    async for chunk in res:  # bytes
        process(chunk)

# Or iterate JSON
async with astream("https://streams.example.com/my-stream") as res:
    async for item in res.iter_json():
        print(item)
```

### Writing to a Stream

```python
from durable_streams import DurableStream

# Create a new stream
handle = DurableStream.create(
    "https://streams.example.com/my-stream",
    content_type="application/json",
    ttl_seconds=3600,
)

# Append data
handle.append({"message": "hello"})
handle.append({"message": "world"})

# Read back
with handle.stream() as res:
    for item in res.iter_json():
        print(item)
```

## API Reference

### Top-Level Functions

#### `stream(url, *, offset=None, live="auto", ...)`

Create a synchronous streaming session.

```python
from durable_streams import stream

res = stream(
    url="https://example.com/stream",
    offset="12345",           # Resume from offset
    live="auto",              # Live mode (see below)
    headers={"Authorization": "Bearer token"},
    params={"tenant": "my-tenant"},
)
```

#### `astream(url, *, offset=None, live="auto", ...)`

Create an asynchronous streaming session.

```python
from durable_streams import astream

res = await astream(
    url="https://example.com/stream",
    offset="12345",
    live="auto",
)
```

### Live Modes

The `live` parameter controls streaming behavior:

- `False` - Catch-up only. Stop after reaching the end of the stream.
- `"auto"` (default) - Behavior depends on consumption method:
  - `read_*()` methods: Stop after reaching up-to-date
  - Iteration methods: Continue with long-poll for live updates
- `"long-poll"` - Explicit long-poll mode for live updates
- `"sse"` - Explicit Server-Sent Events mode for live updates

### StreamResponse / AsyncStreamResponse

Response objects returned by `stream()` and `astream()`. These are **one-shot** -
you can only consume them in one mode. Attempting to consume again raises `StreamConsumedError`.

#### Context Manager Usage (Recommended)

```python
# Sync
with stream(url) as res:
    for chunk in res:
        process(chunk)

# Async
async with astream(url) as res:
    async for chunk in res:
        process(chunk)
```

#### Raw Bytes Iteration

```python
# Default iteration yields bytes
with stream(url) as res:
    for chunk in res:  # bytes
        print(len(chunk))
```

**Note:** Raw bytes iteration is not available in SSE mode. Use `iter_text()` or `iter_json()` instead.

#### Text Iteration

```python
with stream(url) as res:
    for text in res.iter_text(encoding="utf-8"):
        print(text)
```

#### JSON Iteration

```python
# Iterate over individual items (arrays are flattened)
with stream(url) as res:
    for item in res.iter_json():
        print(item)

# With a custom decoder
with stream(url) as res:
    for item in res.iter_json(decode=MyModel.from_dict):
        print(item)
```

#### JSON Batches (Preserves Array Boundaries)

```python
with stream(url) as res:
    for batch in res.iter_json_batches():
        print(f"Got batch of {len(batch)} items")
```

#### Events with Metadata

```python
from durable_streams import StreamEvent

with stream(url) as res:
    for event in res.iter_events(mode="json"):
        print(f"Data: {event.data}")
        print(f"Offset: {event.next_offset}")
        print(f"Up-to-date: {event.up_to_date}")
        print(f"Cursor: {event.cursor}")
```

#### Read-All Methods

```python
with stream(url, live=False) as res:
    # Read all bytes
    data = res.read_bytes()

    # Read all text
    text = res.read_text()

    # Read all JSON items (flattened)
    items = res.read_json()

    # Read JSON batches (preserves boundaries)
    batches = res.read_json_batches()
```

### DurableStream / AsyncDurableStream

Handle classes for read/write operations on streams.

#### Creating Handles

```python
from durable_streams import DurableStream

# Create a new stream
handle = DurableStream.create(
    url="https://example.com/stream",
    content_type="application/json",
    ttl_seconds=3600,
    headers={"Authorization": "Bearer token"},
)

# Connect to existing stream
handle = DurableStream.connect(
    url="https://example.com/stream",
    headers={"Authorization": "Bearer token"},
)

# Direct instantiation (no network call)
handle = DurableStream(
    url="https://example.com/stream",
    headers={"Authorization": "Bearer token"},
)
```

#### Instance Methods

```python
# Get metadata
result = handle.head()
print(f"Offset: {result.offset}")
print(f"Content-Type: {result.content_type}")

# Append data
handle.append({"event": "click"})
handle.append({"event": "scroll"}, seq="seq-001")

# Delete stream
handle.delete()

# Read stream
with handle.stream(offset="12345") as res:
    for item in res.iter_json():
        print(item)
```

#### Async Version

```python
from durable_streams import AsyncDurableStream

handle = await AsyncDurableStream.create(
    url="https://example.com/stream",
    content_type="application/json",
)

await handle.append({"event": "click"})

async with handle.stream() as res:
    async for item in res.iter_json():
        print(item)
```

### Automatic Batching

By default, multiple `append()` calls made while a POST is in-flight are batched together:

```python
import asyncio
from durable_streams import AsyncDurableStream

handle = await AsyncDurableStream.create(url, content_type="application/json")

# These may be sent in a single batched request
await asyncio.gather(
    handle.append({"event": "a"}),
    handle.append({"event": "b"}),
    handle.append({"event": "c"}),
)
```

Disable batching if needed:

```python
handle = DurableStream(url, batching=False)
```

## Error Handling

```python
from durable_streams import (
    stream,
    DurableStreamError,
    FetchError,
    SeqConflictError,
    RetentionGoneError,
    StreamConsumedError,
)

try:
    with stream(url) as res:
        items = res.read_json()
except StreamConsumedError:
    print("Stream was already consumed")
except SeqConflictError:
    print("Sequence conflict during append")
except RetentionGoneError:
    print("Offset is before earliest retained position")
except DurableStreamError as e:
    print(f"Protocol error: {e.message} (status={e.status}, code={e.code})")
except FetchError as e:
    print(f"Network error: {e.message}")
```

### Error Recovery with on_error

```python
def handle_error(error):
    if isinstance(error, FetchError) and error.status == 401:
        new_token = refresh_token()
        return {"headers": {"Authorization": f"Bearer {new_token}"}}
    # Return None to propagate the error
    return None

with stream(url, on_error=handle_error) as res:
    for item in res.iter_json():
        print(item)
```

## Types

### StreamEvent

```python
@dataclass(frozen=True, slots=True)
class StreamEvent(Generic[T]):
    data: T
    next_offset: str
    up_to_date: bool
    cursor: str | None = None
```

### LiveMode

```python
LiveMode = Literal["auto", "long-poll", "sse"] | bool
```

### HeadResult

```python
@dataclass(frozen=True, slots=True)
class HeadResult:
    exists: Literal[True]
    content_type: str | None = None
    offset: str | None = None
    etag: str | None = None
    cache_control: str | None = None
```

### AppendResult

```python
@dataclass(frozen=True, slots=True)
class AppendResult:
    next_offset: str
```

## Development

This package uses [uv](https://github.com/astral-sh/uv) for development.

### Setup

```bash
cd packages/client-py
uv sync --dev
```

### Run Tests

```bash
uv run pytest
uv run pytest --cov=durable_streams
```

### Linting and Formatting

```bash
uv run ruff check .
uv run ruff format .
```

### Type Checking

```bash
uv run pyright
```

### Build

```bash
uv build
```

## Protocol Compliance

This client implements the [Durable Streams Protocol](../../PROTOCOL.md), including:

- **Read modes**: Catch-up, Long-poll, and SSE
- **Headers**: `Stream-Next-Offset`, `Stream-Cursor`, `Stream-Up-To-Date`, `Stream-Seq`
- **JSON mode**: Array flattening on reads, array wrapping on appends
- **Batching**: Automatic request batching for high-throughput appends

## License

MIT
