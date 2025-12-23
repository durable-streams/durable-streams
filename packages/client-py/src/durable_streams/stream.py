"""
Top-level stream() function for synchronous stream reading.

This is the primary API for read-only stream consumption.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx

from durable_streams._errors import (
    SSENotSupportedError,
    error_from_status,
)
from durable_streams._parse import parse_httpx_headers, parse_response_headers
from durable_streams._response import StreamResponse
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
    resolve_headers_sync,
    resolve_params_sync,
)


def stream(
    url: str,
    *,
    offset: Offset | None = None,
    live: LiveMode = "auto",
    cursor: str | None = None,
    headers: HeadersLike | None = None,
    params: ParamsLike | None = None,
    on_error: Callable[[Exception], dict[str, Any] | None] | None = None,
    client: httpx.Client | None = None,
    timeout: float | httpx.Timeout | None = None,
    **kwargs: Any,
) -> StreamResponse[Any]:
    """
    Create a streaming session to read from a durable stream.

    This function makes the initial request and returns a StreamResponse object
    that can be used to consume the stream data in various ways.

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
        on_error: Error handler callback
        client: Optional httpx.Client to use (will not be closed)
        timeout: Request timeout
        **kwargs: Additional arguments passed to httpx

    Returns:
        StreamResponse object for consuming stream data

    Example:
        >>> with stream("https://example.com/stream") as res:
        ...     for item in res.iter_json():
        ...         print(item)
    """
    # Use provided client or create a new one
    own_client = client is None
    http_client = client or httpx.Client(timeout=timeout or 30.0)

    try:
        return _stream_internal(
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
            http_client.close()
        raise


def _stream_internal(
    *,
    url: str,
    offset: Offset | None,
    live: LiveMode,
    cursor: str | None,
    headers: HeadersLike | None,
    params: ParamsLike | None,
    on_error: Callable[[Exception], dict[str, Any] | None] | None,
    client: httpx.Client,
    _own_client: bool,  # Reserved for future client lifecycle management
    timeout: float | httpx.Timeout | None,
    **kwargs: Any,
) -> StreamResponse[Any]:
    """Internal implementation of stream()."""
    # Build query parameters
    query_params: dict[str, str] = {}

    # Add offset if provided
    if offset is not None:
        query_params[OFFSET_QUERY_PARAM] = offset

    # Add live mode for explicit modes
    is_sse = False
    if live == "long-poll":
        query_params[LIVE_QUERY_PARAM] = "long-poll"
    elif live == "sse":
        query_params[LIVE_QUERY_PARAM] = "sse"
        is_sse = True

    # Add cursor if provided
    if cursor:
        query_params[CURSOR_QUERY_PARAM] = cursor

    # Track mutations from on_error that should persist to fetch_next
    header_mutations: dict[str, str] = {}
    param_mutations: dict[str, str] = {}

    # Make the initial request with retry loop for on_error
    while True:
        # Re-resolve headers/params on each retry so callables (e.g., token fetchers)
        # can return fresh values
        resolved_headers = resolve_headers_sync(headers)
        resolved_params = resolve_params_sync(params)

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
            response = client.send(request, stream=True)

            # Check for errors
            if not response.is_success:
                # For errors, we need to read the body for error details
                body = response.read().decode("utf-8", errors="replace")
                response.close()
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
            # If there's an on_error handler, give it a chance to recover
            if on_error is not None:
                retry_opts = on_error(e)

                if retry_opts is None:
                    # No recovery, re-raise
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
            response.close()
            raise SSENotSupportedError(
                f"SSE mode is not compatible with content type: {content_type}. "
                "SSE is only supported for text/* or application/json streams."
            )

    # Parse initial metadata
    headers_dict = parse_httpx_headers(response.headers)
    meta = parse_response_headers(headers_dict)

    # Create fetch_next function for live continuation
    # Capture the mutations from on_error so they persist to follow-up requests
    captured_header_mutations = header_mutations.copy()
    captured_param_mutations = param_mutations.copy()

    def fetch_next(next_offset: Offset, next_cursor: str | None) -> httpx.Response:
        """Fetch the next chunk for live updates."""
        next_params: dict[str, str] = {}
        next_params[OFFSET_QUERY_PARAM] = next_offset

        # For auto mode, use long-poll for subsequent requests
        if live == "auto" or live == "long-poll":
            next_params[LIVE_QUERY_PARAM] = "long-poll"
        elif live == "sse":
            next_params[LIVE_QUERY_PARAM] = "sse"

        if next_cursor:
            next_params[CURSOR_QUERY_PARAM] = next_cursor

        # Re-resolve dynamic headers/params, then apply any mutations from on_error
        resolved_hdrs = resolve_headers_sync(headers)
        resolved_prms = resolve_params_sync(params)

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
                resp = client.send(request, stream=True)

                if not resp.is_success and resp.status_code != 204:
                    # For errors, read body for error details then close
                    body = resp.read().decode("utf-8", errors="replace")
                    resp.close()
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
                    retry_opts = on_error(e)
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

    return StreamResponse(
        url=url,
        response=response,
        client=client,
        live=live,
        start_offset=offset,  # Original offset passed to stream()
        offset=meta.next_offset,  # Current offset from response headers
        cursor=meta.cursor,
        fetch_next=fetch_next,
        is_sse=is_sse,
        own_client=_own_client,
    )
