"""
Top-level astream() function for asynchronous stream reading.

This is the primary async API for read-only stream consumption.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine, Generator
from typing import Any, cast

import httpx

from durable_streams._errors import (
    SSENotSupportedError,
    error_from_status,
)
from durable_streams._parse import parse_httpx_headers, parse_response_headers
from durable_streams._response import AsyncStreamResponse
from durable_streams._types import (
    CURSOR_QUERY_PARAM,
    LIVE_QUERY_PARAM,
    OFFSET_QUERY_PARAM,
    HeadersLike,
    LiveMode,
    Offset,
    ParamsLike,
)
from durable_streams._util import (
    build_url_with_params,
    is_sse_compatible_content_type,
    resolve_headers_async,
    resolve_params_async,
)


class AsyncStreamSession:
    """
    Async context manager wrapper for astream().

    RECOMMENDED: Use as an async context manager directly:

        async with astream(url) as res:
            async for item in res.iter_json():
                print(item)

    ALSO SUPPORTED (but less safe): Await first, then use:

        res = await astream(url)
        async with res:
            async for item in res.iter_json():
                print(item)

    WARNING: If you use ``await astream(url)`` without wrapping the result
    in an ``async with`` block, the connection will NOT be automatically closed.
    This can lead to resource leaks. Always prefer the direct context manager pattern.
    """

    def __init__(
        self,
        url: str,
        *,
        offset: Offset | None = None,
        live: LiveMode = "auto",
        cursor: str | None = None,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        on_error: Callable[
            [Exception],
            Coroutine[Any, Any, dict[str, Any] | None] | dict[str, Any] | None,
        ]
        | None = None,
        client: httpx.AsyncClient | None = None,
        timeout: float | httpx.Timeout | None = None,
        **kwargs: Any,
    ) -> None:
        self._url = url
        self._offset = offset
        self._live = live
        self._cursor = cursor
        self._headers = headers
        self._params = params
        self._on_error = on_error
        self._client = client
        self._timeout = timeout
        self._kwargs = kwargs
        self._response: AsyncStreamResponse[Any] | None = None

    def __await__(self) -> Generator[Any, None, AsyncStreamResponse[Any]]:
        """
        Allow: res = await astream(url)

        WARNING: When using this pattern, you are responsible for closing the
        response manually (via ``await res.aclose()`` or ``async with res:``).
        Prefer the direct context manager pattern: ``async with astream(url) as res:``
        """
        import warnings

        warnings.warn(
            "Using 'await astream(url)' returns an unclosed response. "
            "Prefer 'async with astream(url) as res:' to ensure proper cleanup, "
            "or wrap the result in 'async with res:' after awaiting.",
            ResourceWarning,
            stacklevel=3,
        )
        return self._create_response().__await__()

    async def _create_response(self) -> AsyncStreamResponse[Any]:
        """Create the async stream response."""
        self._response = await _astream_impl(
            url=self._url,
            offset=self._offset,
            live=cast(LiveMode, self._live),
            cursor=self._cursor,
            headers=self._headers,
            params=self._params,
            on_error=self._on_error,
            client=self._client,
            timeout=self._timeout,
            **self._kwargs,
        )
        return self._response

    async def __aenter__(self) -> AsyncStreamResponse[Any]:
        """Allow: async with astream(url) as res:"""
        if self._response is None:
            await self._create_response()
        assert self._response is not None
        return self._response

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> None:
        """Close the response on exit."""
        if self._response is not None:
            await self._response.aclose()


def astream(
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
    client: httpx.AsyncClient | None = None,
    timeout: float | httpx.Timeout | None = None,
    **kwargs: Any,
) -> AsyncStreamSession:
    """
    Create an async streaming session to read from a durable stream.

    This function returns an async context manager that can be used directly
    with `async with`, or awaited to get the response object.

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
        client: Optional httpx.AsyncClient to use (will not be closed)
        timeout: Request timeout
        **kwargs: Additional arguments passed to httpx

    Returns:
        AsyncStreamSession that can be used as async context manager or awaited

    Example:
        # Preferred: direct async context manager
        >>> async with astream("https://example.com/stream") as res:
        ...     async for item in res.iter_json():
        ...         print(item)

        # Also works: await then use
        >>> res = await astream("https://example.com/stream")
        >>> async with res:
        ...     async for item in res.iter_json():
        ...         print(item)
    """
    return AsyncStreamSession(
        url,
        offset=offset,
        live=live,
        cursor=cursor,
        headers=headers,
        params=params,
        on_error=on_error,
        client=client,
        timeout=timeout,
        **kwargs,
    )


async def _astream_impl(
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
    client: httpx.AsyncClient | None = None,
    timeout: float | httpx.Timeout | None = None,
    **kwargs: Any,
) -> AsyncStreamResponse[Any]:
    """Internal implementation that creates the actual response."""
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

    # Track mutations from on_error that should persist to fetch_next
    header_mutations: dict[str, str] = {}
    param_mutations: dict[str, str] = {}

    # Make the initial request with retry loop for on_error
    while True:
        # Re-resolve headers/params on each retry so callables (e.g., token fetchers)
        # can return fresh values
        resolved_headers = await resolve_headers_async(headers)
        resolved_params = await resolve_params_async(params)

        # Apply any mutations from previous on_error calls
        current_headers = {**resolved_headers, **header_mutations}
        current_params = {**resolved_params, **param_mutations}

        # Add Accept header for SSE mode (standard SSE negotiation)
        if is_sse and "accept" not in {k.lower() for k in current_headers}:
            current_headers["Accept"] = "text/event-stream"

        # Merge query params (user params + protocol params)
        all_params = {**current_params, **query_params}

        # Build the request URL
        request_url = build_url_with_params(url, all_params)

        try:
            # Use streaming mode to avoid buffering the entire response
            request = client.build_request(
                "GET",
                request_url,
                headers=current_headers,
                timeout=timeout,
                **kwargs,
            )
            response = await client.send(request, stream=True)

            if not response.is_success:
                # For errors, read body for error details then close
                body_bytes = await response.aread()
                await response.aclose()
                body = body_bytes.decode("utf-8", errors="replace")
                headers_dict = parse_httpx_headers(response.headers)
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
                retry_opts: dict[str, Any] | None
                if hasattr(result, "__await__"):
                    retry_opts = await result  # type: ignore[misc]
                else:
                    retry_opts = result  # type: ignore[assignment]

                if retry_opts is None:
                    raise

                # Accumulate mutations for retry and for fetch_next
                if "params" in retry_opts:
                    param_mutations = {**param_mutations, **retry_opts["params"]}
                if "headers" in retry_opts:
                    header_mutations = {**header_mutations, **retry_opts["headers"]}

                continue

            raise

    # Check SSE compatibility after response headers are available
    if is_sse:
        content_type = response.headers.get("content-type")
        if not is_sse_compatible_content_type(content_type):
            await response.aclose()
            raise SSENotSupportedError(
                f"SSE mode is not compatible with content type: {content_type}. "
                "SSE is only supported for text/* or application/json streams."
            )

    headers_dict = parse_httpx_headers(response.headers)
    meta = parse_response_headers(headers_dict)

    # Create fetch_next function for live continuation
    # Capture the mutations from on_error so they persist to follow-up requests
    captured_header_mutations = header_mutations.copy()
    captured_param_mutations = param_mutations.copy()

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

        # Re-resolve dynamic headers/params, then apply any mutations from on_error
        resolved_hdrs = await resolve_headers_async(headers)
        resolved_prms = await resolve_params_async(params)

        # Apply captured mutations from on_error (e.g., refreshed auth)
        final_hdrs = {**resolved_hdrs, **captured_header_mutations}
        final_prms = {**resolved_prms, **captured_param_mutations}

        # Add Accept header for SSE mode (consistent with initial request)
        if is_sse and "accept" not in {k.lower() for k in final_hdrs}:
            final_hdrs["Accept"] = "text/event-stream"

        all_prms = {**final_prms, **next_params}
        next_url = build_url_with_params(url, all_prms)

        # Retry loop with on_error for follow-up requests
        while True:
            try:
                # Use streaming mode for live fetches
                request = client.build_request(
                    "GET",
                    next_url,
                    headers=final_hdrs,
                    timeout=timeout,
                    **kwargs,
                )
                resp = await client.send(request, stream=True)

                if not resp.is_success and resp.status_code != 204:
                    # For errors, read body for error details then close
                    body_bytes = await resp.aread()
                    await resp.aclose()
                    body = body_bytes.decode("utf-8", errors="replace")
                    hdrs = parse_httpx_headers(resp.headers)
                    error = error_from_status(
                        resp.status_code,
                        url,
                        body=body,
                        headers=hdrs,
                    )
                    raise error

                return resp
            except Exception as e:
                # Apply on_error for follow-up requests too
                if on_error is not None:
                    result = on_error(e)
                    if asyncio.iscoroutine(result):
                        retry_opts = await result
                    else:
                        retry_opts = result
                    if retry_opts is not None:
                        # Apply retry mutations
                        if "params" in retry_opts:
                            final_prms = {**final_prms, **retry_opts["params"]}
                            all_prms = {**final_prms, **next_params}
                            next_url = build_url_with_params(url, all_prms)
                        if "headers" in retry_opts:
                            final_hdrs = {**final_hdrs, **retry_opts["headers"]}
                        continue
                raise

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
        own_client=_own_client,
    )
