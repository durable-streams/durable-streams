"""
Parsing utilities for the Durable Streams protocol.

This module handles parsing of response headers and JSON data.
"""

import json
from collections.abc import Callable
from typing import Any, TypeVar, cast

from durable_streams._errors import DurableStreamError
from durable_streams._types import (
    STREAM_CLOSED_HEADER,
    STREAM_CURSOR_HEADER,
    STREAM_NEXT_OFFSET_HEADER,
    STREAM_SSE_DATA_ENCODING_HEADER,
    STREAM_UP_TO_DATE_HEADER,
    Offset,
)

T = TypeVar("T")


class ResponseMetadata:
    """
    Parsed metadata from a stream response.

    Attributes:
        next_offset: The next offset to read from
        cursor: Optional cursor for CDN collapsing
        up_to_date: Whether the response is at the current end of stream
        stream_closed: Whether the stream has been closed (EOF)
        content_type: The content type of the response
        sse_encoding: SSE data encoding signaled by server (e.g., "base64")
    """

    __slots__ = ("next_offset", "cursor", "up_to_date", "stream_closed", "content_type", "sse_encoding")

    def __init__(
        self,
        next_offset: Offset | None = None,
        cursor: str | None = None,
        up_to_date: bool = False,
        stream_closed: bool = False,
        content_type: str | None = None,
        sse_encoding: str | None = None,
    ) -> None:
        self.next_offset = next_offset
        self.cursor = cursor
        self.up_to_date = up_to_date
        self.stream_closed = stream_closed
        self.content_type = content_type
        self.sse_encoding = sse_encoding


def parse_response_headers(headers: dict[str, str]) -> ResponseMetadata:
    """
    Parse stream metadata from response headers.

    Args:
        headers: Response headers dict (case-insensitive keys)

    Returns:
        Parsed ResponseMetadata
    """
    # Headers may have different casing, so normalize to lowercase for lookup
    lower_headers = {k.lower(): v for k, v in headers.items()}

    next_offset = lower_headers.get(STREAM_NEXT_OFFSET_HEADER.lower())
    cursor = lower_headers.get(STREAM_CURSOR_HEADER.lower())
    up_to_date = STREAM_UP_TO_DATE_HEADER.lower() in lower_headers
    stream_closed = (
        lower_headers.get(STREAM_CLOSED_HEADER.lower(), "").lower() == "true"
    )
    content_type = lower_headers.get("content-type")
    sse_encoding = lower_headers.get(STREAM_SSE_DATA_ENCODING_HEADER.lower())

    return ResponseMetadata(
        next_offset=next_offset,
        cursor=cursor,
        up_to_date=up_to_date,
        stream_closed=stream_closed,
        content_type=content_type,
        sse_encoding=sse_encoding,
    )


def parse_httpx_headers(headers: Any) -> dict[str, str]:
    """
    Convert httpx Headers object to a plain dict.

    Args:
        headers: httpx Headers object

    Returns:
        Plain dict of headers
    """
    return dict(headers.items())


def flatten_json_array(data: Any) -> list[Any]:
    """
    Flatten a JSON value for iteration.

    For application/json streams, GET responses are JSON arrays.
    This function normalizes the response:
    - Arrays are returned as-is (their items)
    - Single values are wrapped in a list

    Args:
        data: Parsed JSON data

    Returns:
        List of items
    """
    if isinstance(data, list):
        return cast(list[Any], data)
    return [data]


def parse_json_response(data: bytes | str) -> Any:
    """
    Parse JSON from bytes or string.

    Args:
        data: JSON data as bytes or string

    Returns:
        Parsed JSON value

    Raises:
        DurableStreamError: If JSON is malformed (code="PARSE_ERROR")
    """
    try:
        if isinstance(data, bytes):
            return json.loads(data.decode("utf-8"))
        return json.loads(data)
    except json.JSONDecodeError as e:
        # Convert to string for preview
        data_str = data.decode("utf-8") if isinstance(data, bytes) else data
        preview = data_str[:100] + "..." if len(data_str) > 100 else data_str
        raise DurableStreamError(
            f"Failed to parse JSON response: {e}. Data: {preview}",
            code="PARSE_ERROR",
        ) from e


def decode_json_items(
    data: bytes | str,
    decoder: Callable[[Any], T] | None = None,
) -> list[T]:
    """
    Parse and flatten JSON response, optionally applying a decoder.

    Args:
        data: JSON data as bytes or string
        decoder: Optional function to decode each item

    Returns:
        List of decoded items
    """
    parsed = parse_json_response(data)
    items = flatten_json_array(parsed)

    if decoder is not None:
        return [decoder(item) for item in items]
    return items  # type: ignore[return-value]


def wrap_for_json_append(data: str | bytes) -> str:
    """
    Wrap pre-serialized JSON data for append operations.

    The protocol flattens arrays one level, so single values
    are wrapped in an array: x -> [x]

    Args:
        data: Pre-serialized JSON string or bytes

    Returns:
        Data wrapped in a JSON array string
    """
    json_str = data.decode("utf-8") if isinstance(data, bytes) else data
    return f"[{json_str}]"


def batch_for_json_append(items: list[str | bytes]) -> bytes:
    """
    Batch multiple pre-serialized JSON items for a JSON append request.

    For JSON streams, multiple values are sent as a JSON array.

    Args:
        items: List of pre-serialized JSON strings or bytes

    Returns:
        JSON-encoded bytes
    """
    if not items:
        raise ValueError("Cannot send empty batch")
    # Join pre-serialized JSON strings with commas and wrap in array
    json_strings = [
        item.decode("utf-8") if isinstance(item, bytes) else item for item in items
    ]
    return ("[" + ",".join(json_strings) + "]").encode("utf-8")


def batch_for_bytes_append(chunks: list[bytes]) -> bytes:
    """
    Batch multiple byte chunks for a bytes append request.

    For byte streams, chunks are concatenated.

    Args:
        chunks: List of byte chunks to batch

    Returns:
        Concatenated bytes
    """
    if not chunks:
        raise ValueError("Cannot send empty batch")
    return b"".join(chunks)
