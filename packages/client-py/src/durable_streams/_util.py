"""
Shared utility functions for the Durable Streams client.

This module provides common utilities used by both sync and async implementations.
"""

from typing import Any

from durable_streams._types import HeadersLike, ParamsLike


def resolve_headers_sync(headers: HeadersLike | None) -> dict[str, str]:
    """
    Resolve headers from HeadersLike to a plain dict.

    Supports static string values or callable functions that return strings.

    Args:
        headers: Headers dict with static or callable values

    Returns:
        Resolved headers dict with all string values
    """
    if headers is None:
        return {}

    resolved: dict[str, str] = {}
    for key, value in headers.items():
        if callable(value):
            resolved[key] = value()
        else:
            resolved[key] = value
    return resolved


async def resolve_headers_async(headers: HeadersLike | None) -> dict[str, str]:
    """
    Async version of resolve_headers_sync.

    Supports static string values, sync callables, or async callables.

    Args:
        headers: Headers dict with static or callable values

    Returns:
        Resolved headers dict with all string values
    """
    if headers is None:
        return {}

    resolved: dict[str, str] = {}
    for key, value in headers.items():
        if callable(value):
            result = value()
            # Check if result is awaitable
            if hasattr(result, "__await__"):
                resolved[key] = await result  # type: ignore[misc]
            else:
                resolved[key] = result  # type: ignore[assignment]
        else:
            resolved[key] = value
    return resolved


def resolve_params_sync(params: ParamsLike | None) -> dict[str, str]:
    """
    Resolve params from ParamsLike to a plain dict.

    Supports static string values or callable functions that return strings.
    None values are omitted from the result.

    Args:
        params: Params dict with static or callable values

    Returns:
        Resolved params dict with all string values (None values excluded)
    """
    if params is None:
        return {}

    resolved: dict[str, str] = {}
    for key, value in params.items():
        if value is None:
            continue
        if callable(value):
            resolved[key] = value()
        else:
            resolved[key] = value
    return resolved


async def resolve_params_async(params: ParamsLike | None) -> dict[str, str]:
    """
    Async version of resolve_params_sync.

    Args:
        params: Params dict with static or callable values

    Returns:
        Resolved params dict with all string values (None values excluded)
    """
    if params is None:
        return {}

    resolved: dict[str, str] = {}
    for key, value in params.items():
        if value is None:
            continue
        if callable(value):
            result = value()
            # Check if result is awaitable
            if hasattr(result, "__await__"):
                resolved[key] = await result  # type: ignore[misc]
            else:
                resolved[key] = result  # type: ignore[assignment]
        else:
            resolved[key] = value
    return resolved


def normalize_content_type(content_type: str | None) -> str:
    """
    Normalize content type by extracting the media type (before any semicolon).

    Handles cases like "application/json; charset=utf-8".

    Args:
        content_type: The content type string

    Returns:
        Normalized content type (lowercase, no parameters)
    """
    if not content_type:
        return ""
    return content_type.split(";")[0].strip().lower()


def is_json_content_type(content_type: str | None) -> bool:
    """
    Check if a content type indicates JSON.

    Args:
        content_type: The content type string

    Returns:
        True if the content type is application/json
    """
    return normalize_content_type(content_type) == "application/json"


def is_sse_compatible_content_type(content_type: str | None) -> bool:
    """
    Check if a content type is compatible with SSE mode.

    SSE is only valid for text/* or application/json streams.

    Args:
        content_type: The content type string

    Returns:
        True if SSE mode is supported for this content type
    """
    if not content_type:
        return False
    normalized = normalize_content_type(content_type)
    return normalized.startswith("text/") or normalized == "application/json"


def encode_body(body: str | bytes | Any) -> bytes:
    """
    Encode a body value to bytes.

    - Bytes are returned as-is
    - Strings are encoded as UTF-8
    - Other values are JSON-serialized

    Args:
        body: The body value to encode

    Returns:
        Encoded bytes
    """
    import json

    if isinstance(body, bytes):
        return body
    if isinstance(body, str):
        return body.encode("utf-8")
    return json.dumps(body).encode("utf-8")


def build_url_with_params(
    base_url: str,
    params: dict[str, str],
) -> str:
    """
    Build a URL with query parameters.

    Args:
        base_url: The base URL
        params: Query parameters to add

    Returns:
        URL with query parameters
    """
    from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

    parsed = urlparse(base_url)
    # Merge with existing query params
    existing_params = parse_qs(parsed.query, keep_blank_values=True)
    # Convert from lists to single values and add new params
    merged: dict[str, str] = {}
    for key, values in existing_params.items():
        if values:
            merged[key] = values[0]
    merged.update(params)

    new_query = urlencode(merged)
    new_parsed = parsed._replace(query=new_query)
    return urlunparse(new_parsed)
