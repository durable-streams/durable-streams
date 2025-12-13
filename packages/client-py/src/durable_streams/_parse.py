"""
Parsing utilities for the Durable Streams protocol.

This module handles parsing of response headers and JSON data.
"""

import json
from collections.abc import Callable
from typing import Any, TypeVar, cast

from durable_streams._types import (
    STREAM_CURSOR_HEADER,
    STREAM_NEXT_OFFSET_HEADER,
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
        content_type: The content type of the response
    """

    __slots__ = ("next_offset", "cursor", "up_to_date", "content_type")

    def __init__(
        self,
        next_offset: Offset | None = None,
        cursor: str | None = None,
        up_to_date: bool = False,
        content_type: str | None = None,
    ) -> None:
        self.next_offset = next_offset
        self.cursor = cursor
        self.up_to_date = up_to_date
        self.content_type = content_type


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
    content_type = lower_headers.get("content-type")

    return ResponseMetadata(
        next_offset=next_offset,
        cursor=cursor,
        up_to_date=up_to_date,
        content_type=content_type,
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
    """
    if isinstance(data, bytes):
        return json.loads(data.decode("utf-8"))
    return json.loads(data)


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


def wrap_for_json_append(data: Any) -> list[Any]:
    """
    Wrap data for JSON append operations.

    The protocol flattens arrays one level, so:
    - Single values should be wrapped: x -> [x]
    - Arrays are sent as-is (server flattens to individual messages)

    Args:
        data: Data to append

    Returns:
        Data wrapped in a list for sending
    """
    # Always wrap in a list - server flattens one level
    return [data]


def batch_for_json_append(items: list[Any]) -> bytes:
    """
    Batch multiple items for a JSON append request.

    For JSON streams, multiple values are sent as a JSON array.

    Args:
        items: List of items to batch

    Returns:
        JSON-encoded bytes
    """
    # Empty check should be done by caller, but be safe
    if not items:
        raise ValueError("Cannot send empty batch")
    return json.dumps(items).encode("utf-8")


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
