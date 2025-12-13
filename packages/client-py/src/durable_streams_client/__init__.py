"""
Durable Streams Python Client

A Python client library for the Electric Durable Streams protocol.

This package provides both synchronous and asynchronous APIs for reading and
writing to durable streams.

Example usage:
    >>> from durable_streams_client import stream, astream, DurableStream
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

from durable_streams_client._errors import (
    DurableStreamError,
    FetchError,
    RetentionGoneError,
    SeqConflictError,
    SSEBytesIterationError,
    SSENotSupportedError,
    StreamConsumedError,
    StreamExistsError,
    StreamNotFoundError,
)
from durable_streams_client._types import (
    AppendResult,
    BackoffOptions,
    HeadResult,
    HeadersLike,
    LiveMode,
    Offset,
    ParamsLike,
    StreamEvent,
)
from durable_streams_client.adurable_stream import AsyncDurableStream
from durable_streams_client.astream import astream
from durable_streams_client.durable_stream import DurableStream
from durable_streams_client.stream import stream

__all__ = [
    # Types
    "LiveMode",
    "Offset",
    "StreamEvent",
    "HeadResult",
    "AppendResult",
    "BackoffOptions",
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
    # Top-level functions
    "stream",
    "astream",
    # Handle classes
    "DurableStream",
    "AsyncDurableStream",
]

__version__ = "0.1.0"
