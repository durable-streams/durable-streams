"""
Top-level astream() function for asynchronous stream reading.

This is the primary async API for read-only stream consumption.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

import httpx

from durable_streams_client._errors import (
    error_from_status,
)
from durable_streams_client._parse import parse_httpx_headers, parse_response_headers
from durable_streams_client._response import AsyncStreamResponse
from durable_streams_client._types import (
    CURSOR_QUERY_PARAM,
    DEFAULT_BACKOFF,
    LIVE_QUERY_PARAM,
    OFFSET_QUERY_PARAM,
    BackoffOptions,
    HeadersLike,
    LiveMode,
    Offset,
    ParamsLike,
)
from durable_streams_client._util import (
    build_url_with_params,
    resolve_headers_async,
    resolve_params_async,
)

T = TypeVar("T")


async def astream(
    url: str,
    *,
    offset: Offset | None = None,
    live: LiveMode = "auto",
    cursor: str | None = None,
    headers: HeadersLike | None = None,
    params: ParamsLike | None = None,
    on_error: Callable[
        [Exception], Coroutine[Any, Any, dict[str, Any] | None] | dict[str, Any] | None
    ]
    | None = None,
    backoff: BackoffOptions | None = None,
    client: httpx.AsyncClient | None = None,
    timeout: float | httpx.Timeout | None = None,
    **kwargs: Any,
) -> AsyncStreamResponse[T]:
    """
    Create an async streaming session to read from a durable stream.

    This function makes the initial request and returns an AsyncStreamResponse
    object that can be used to consume the stream data in various ways.

    Args:
        url: The full URL to the durable stream
        offset: Starting offset (None means start of stream)
        live: Live mode behavior:
            - False: Catch-up only, stop at first up-to-date
            - "auto" (default): Behavior driven by consumption method
            - "long-poll": Explicit long-poll mode for live updates
            - "sse": Explicit SSE mode for live updates
        cursor: Echo of last Stream-Cursor for CDN collapsing
        headers: HTTP headers (static strings or callables)
        params: Query parameters (static strings or callables)
        on_error: Async error handler callback
        backoff: Backoff options for retries
        client: Optional httpx.AsyncClient to use (will not be closed)
        timeout: Request timeout
        **kwargs: Additional arguments passed to httpx

    Returns:
        AsyncStreamResponse object for consuming stream data

    Example:
        >>> async with await astream("https://example.com/stream") as res:
        ...     async for item in res.iter_json():
        ...         print(item)
    """
    # Use provided client or create a new one
    own_client = client is None
    http_client = client or httpx.AsyncClient(timeout=timeout or 30.0)

    try:
        return await _astream_internal(
            url=url,
            offset=offset,
            live=live,
            cursor=cursor,
            headers=headers,
            params=params,
            on_error=on_error,
            _backoff=backoff or DEFAULT_BACKOFF,
            client=http_client,
            _own_client=own_client,
            timeout=timeout,
            **kwargs,
        )
    except Exception:
        if own_client:
            await http_client.aclose()
        raise


async def _astream_internal(
    *,
    url: str,
    offset: Offset | None,
    live: LiveMode,
    cursor: str | None,
    headers: HeadersLike | None,
    params: ParamsLike | None,
    on_error: Callable[
        [Exception], Coroutine[Any, Any, dict[str, Any] | None] | dict[str, Any] | None
    ]
    | None,
    _backoff: BackoffOptions,  # Reserved for future backoff implementation
    client: httpx.AsyncClient,
    _own_client: bool,  # Reserved for future client lifecycle management
    timeout: float | httpx.Timeout | None,
    **kwargs: Any,
) -> AsyncStreamResponse[Any]:
    """Internal implementation of astream()."""
    # Build query parameters
    query_params: dict[str, str] = {}

    if offset is not None:
        query_params[OFFSET_QUERY_PARAM] = offset

    is_sse = False
    if live == "long-poll":
        query_params[LIVE_QUERY_PARAM] = "long-poll"
    elif live == "sse":
        query_params[LIVE_QUERY_PARAM] = "sse"
        is_sse = True

    if cursor:
        query_params[CURSOR_QUERY_PARAM] = cursor

    # Resolve user-provided headers and params
    resolved_headers = await resolve_headers_async(headers)
    resolved_params = await resolve_params_async(params)

    all_params = {**resolved_params, **query_params}
    request_url = build_url_with_params(url, all_params)

    current_headers = resolved_headers.copy()
    current_params = resolved_params.copy()

    while True:
        try:
            response = await client.get(
                request_url,
                headers=current_headers,
                timeout=timeout,
                **kwargs,
            )

            if not response.is_success:
                headers_dict = parse_httpx_headers(response.headers)
                body = response.text
                error = error_from_status(
                    response.status_code,
                    url,
                    body=body,
                    headers=headers_dict,
                )
                raise error

            break

        except Exception as e:
            if on_error is not None:
                result = on_error(e)
                # Handle both sync and async on_error
                if hasattr(result, "__await__"):
                    retry_opts = await result
                else:
                    retry_opts = result

                if retry_opts is None:
                    raise

                if "params" in retry_opts:
                    current_params = {**current_params, **retry_opts["params"]}
                if "headers" in retry_opts:
                    current_headers = {**current_headers, **retry_opts["headers"]}

                all_params = {**current_params, **query_params}
                request_url = build_url_with_params(url, all_params)
                continue

            raise

    headers_dict = parse_httpx_headers(response.headers)
    meta = parse_response_headers(headers_dict)

    async def fetch_next(
        next_offset: Offset, next_cursor: str | None
    ) -> httpx.Response:
        """Fetch the next chunk for live updates."""
        next_params: dict[str, str] = {}
        next_params[OFFSET_QUERY_PARAM] = next_offset

        if live == "auto" or live == "long-poll":
            next_params[LIVE_QUERY_PARAM] = "long-poll"
        elif live == "sse":
            next_params[LIVE_QUERY_PARAM] = "sse"

        if next_cursor:
            next_params[CURSOR_QUERY_PARAM] = next_cursor

        resolved_hdrs = await resolve_headers_async(headers)
        resolved_prms = await resolve_params_async(params)

        all_prms = {**resolved_prms, **next_params}
        next_url = build_url_with_params(url, all_prms)

        resp = await client.get(
            next_url,
            headers=resolved_hdrs,
            timeout=timeout,
            **kwargs,
        )

        if not resp.is_success and resp.status_code != 204:
            hdrs = parse_httpx_headers(resp.headers)
            body = resp.text
            error = error_from_status(
                resp.status_code,
                url,
                body=body,
                headers=hdrs,
            )
            raise error

        return resp

    return AsyncStreamResponse(
        url=url,
        response=response,
        client=client,
        live=live,
        start_offset=offset,  # Original offset passed to astream()
        offset=meta.next_offset,  # Current offset from response headers
        cursor=meta.cursor,
        fetch_next=fetch_next,
        is_sse=is_sse,
    )
