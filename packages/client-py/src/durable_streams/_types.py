"""
Core types for the Durable Streams client.

This module defines the fundamental types used throughout the library.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import (
    Any,
    Generic,
    Literal,
    TypeVar,
)

# Type alias for stream offsets - opaque strings
Offset = str

# Type parameter for generic data
T = TypeVar("T")

# Live mode options
LiveMode = Literal["auto", "long-poll", "sse"] | bool


@dataclass(frozen=True, slots=True)
class StreamEvent(Generic[T]):
    """
    A stream event with data and metadata.

    This is returned by iter_events() and provides access to both the payload
    and stream metadata like offset and up-to-date status.

    Attributes:
        data: The event payload (bytes, str, or parsed JSON depending on mode)
        next_offset: The offset to use for resuming from after this event
        up_to_date: True if this event represents the current end of stream
        cursor: Optional cursor for CDN collapsing (if provided by server)
    """

    data: T
    next_offset: Offset
    up_to_date: bool
    cursor: str | None = None


@dataclass(frozen=True, slots=True)
class HeadResult:
    """
    Result from a HEAD request on a stream.

    Attributes:
        exists: Always True (if stream doesn't exist, an error is raised)
        content_type: The stream's content type
        offset: The tail offset (next offset after current end of stream)
        etag: ETag for cache validation
        cache_control: Cache-Control header value
    """

    exists: Literal[True]
    content_type: str | None = None
    offset: Offset | None = None
    etag: str | None = None
    cache_control: str | None = None


@dataclass(frozen=True, slots=True)
class AppendResult:
    """
    Result from an append operation.

    Attributes:
        next_offset: The new tail offset after the append
    """

    next_offset: Offset


# Type for headers - can be static strings or callables
HeadersLike = dict[str, str | Callable[[], str]]

# Type for params - can be static strings or callables
ParamsLike = dict[str, str | Callable[[], str] | None]

# Type for JSON decode function
JsonDecoder = Callable[[Any], T]


# Protocol constants
STREAM_NEXT_OFFSET_HEADER = "Stream-Next-Offset"
STREAM_CURSOR_HEADER = "Stream-Cursor"
STREAM_UP_TO_DATE_HEADER = "Stream-Up-To-Date"
STREAM_SEQ_HEADER = "Stream-Seq"
STREAM_TTL_HEADER = "Stream-TTL"
STREAM_EXPIRES_AT_HEADER = "Stream-Expires-At"

OFFSET_QUERY_PARAM = "offset"
LIVE_QUERY_PARAM = "live"
CURSOR_QUERY_PARAM = "cursor"

# Content types compatible with SSE
SSE_COMPATIBLE_CONTENT_TYPES = ("text/", "application/json")
