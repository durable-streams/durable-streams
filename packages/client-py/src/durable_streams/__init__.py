"""
Durable Streams Python Client

A Python client library for the Durable Streams protocol.

This package provides both synchronous and asynchronous APIs for reading and
writing to durable streams.

Example usage:
    >>> from durable_streams import stream, astream, DurableStream
    >>>
    >>> # Simple catch-up read
    >>> with stream("https://example.com/stream") as res:
    ...     for chunk in res:
    ...         print(chunk)
    >>>
    >>> # JSON streaming
    >>> with stream("https://example.com/stream") as res:
    ...     for item in res.iter_json():
    ...         print(item)
"""

from importlib.metadata import PackageNotFoundError, version

from durable_streams._errors import (
    DurableStreamError,
    FetchError,
    RetentionGoneError,
    SeqConflictError,
    SSEBytesIterationError,
    SSENotSupportedError,
    SSEReadAllError,
    StreamConsumedError,
    StreamExistsError,
    StreamNotFoundError,
)
from durable_streams._types import (
    AppendResult,
    HeadersLike,
    HeadResult,
    LiveMode,
    Offset,
    ParamsLike,
    StreamEvent,
)
from durable_streams.adurable_stream import AsyncDurableStream
from durable_streams.astream import astream
from durable_streams.durable_stream import DurableStream
from durable_streams.stream import stream

__all__ = [
    # Types
    "LiveMode",
    "Offset",
    "StreamEvent",
    "HeadResult",
    "AppendResult",
    "HeadersLike",
    "ParamsLike",
    # Errors
    "DurableStreamError",
    "FetchError",
    "RetentionGoneError",
    "SeqConflictError",
    "StreamConsumedError",
    "StreamNotFoundError",
    "StreamExistsError",
    "SSENotSupportedError",
    "SSEBytesIterationError",
    "SSEReadAllError",
    # Top-level functions
    "stream",
    "astream",
    # Handle classes
    "DurableStream",
    "AsyncDurableStream",
]

# Use importlib.metadata for version (works with installed package)
# Fall back to hard-coded version for editable installs
try:
    __version__ = version("durable-streams")
except PackageNotFoundError:
    __version__ = "0.1.0"
