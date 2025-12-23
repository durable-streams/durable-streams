"""
AsyncDurableStream - Asynchronous handle class for read/write operations.

This provides a persistent async handle to a stream with methods for creating,
reading, appending, and deleting streams.
"""

from __future__ import annotations

import asyncio
import json
from collections import deque
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any

import httpx

from durable_streams._errors import (
    SeqConflictError,
    StreamExistsError,
    StreamNotFoundError,
    error_from_status,
)
from durable_streams._parse import (
    batch_for_bytes_append,
    batch_for_json_append,
    parse_httpx_headers,
    wrap_for_json_append,
)
from durable_streams._types import (
    STREAM_EXPIRES_AT_HEADER,
    STREAM_NEXT_OFFSET_HEADER,
    STREAM_SEQ_HEADER,
    STREAM_TTL_HEADER,
    AppendResult,
    HeadersLike,
    HeadResult,
    LiveMode,
    Offset,
    ParamsLike,
)
from durable_streams._util import (
    build_url_with_params,
    encode_body,
    is_json_content_type,
    resolve_headers_async,
    resolve_params_async,
)
from durable_streams.astream import AsyncStreamSession
from durable_streams.astream import astream as astream_fn


@dataclass
class _QueuedMessage:
    """Internal type for batching queue."""

    data: Any
    seq: str | None
    content_type: str | None
    future: asyncio.Future[AppendResult] | None = None


class AsyncDurableStream:
    """
    An asynchronous handle to a durable stream for read/write operations.

    This is a lightweight, reusable handle - not a persistent connection.
    Create sessions as needed via stream().

    Example:
        >>> # Create a new stream
        >>> handle = await AsyncDurableStream.create(
        ...     "https://example.com/stream",
        ...     content_type="application/json",
        ... )
        >>>
        >>> # Append data
        >>> await handle.append({"message": "hello"})
        >>>
        >>> # Read data
        >>> async with handle.stream() as res:
        ...     async for item in res.iter_json():
        ...         print(item)
    """

    def __init__(
        self,
        url: str,
        *,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        content_type: str | None = None,
        client: httpx.AsyncClient | None = None,
        timeout: float | httpx.Timeout | None = None,
        batching: bool = True,
        on_error: Callable[
            [Exception],
            Coroutine[Any, Any, dict[str, Any] | None] | dict[str, Any] | None,
        ]
        | None = None,
    ) -> None:
        """
        Create a handle to a durable stream.

        No network IO is performed by the constructor.

        Args:
            url: The URL of the durable stream
            headers: HTTP headers (static strings or callables)
            params: Query parameters (static strings or callables)
            content_type: Content type for the stream
            client: Optional httpx.AsyncClient to use
            timeout: Request timeout
            batching: Enable automatic batching for append() calls
            on_error: Async error handler callback
        """
        self._url = url
        self._headers = headers
        self._params = params
        self._content_type = content_type
        self._timeout = timeout or 30.0
        self._batching = batching
        self._on_error = on_error

        self._own_client = client is None
        self._client = client or httpx.AsyncClient(timeout=self._timeout)

        # Batching infrastructure
        self._batch_lock = asyncio.Lock()
        self._batch_queue: deque[_QueuedMessage] = deque()
        self._batch_in_flight = False

    @property
    def url(self) -> str:
        """The URL of the durable stream."""
        return self._url

    @property
    def content_type(self) -> str | None:
        """The content type of the stream."""
        return self._content_type

    async def aclose(self) -> None:
        """Close the handle and release resources."""
        if self._own_client:
            await self._client.aclose()

    async def __aenter__(self) -> AsyncDurableStream:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.aclose()

    # === Static factory methods ===

    @classmethod
    async def connect(
        cls,
        url: str,
        *,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        client: httpx.AsyncClient | None = None,
        timeout: float | httpx.Timeout | None = None,
        **kwargs: Any,
    ) -> AsyncDurableStream:
        """
        Connect to an existing stream (validates via HEAD).

        Returns:
            AsyncDurableStream handle with content_type populated
        """
        handle = cls(
            url,
            headers=headers,
            params=params,
            client=client,
            timeout=timeout,
            **kwargs,
        )
        try:
            await handle.head()
        except Exception:
            # Close the handle to avoid leaking the client if we created it
            await handle.aclose()
            raise
        return handle

    @classmethod
    async def create(
        cls,
        url: str,
        *,
        content_type: str | None = None,
        ttl_seconds: int | None = None,
        expires_at: str | None = None,
        body: bytes | str | Any | None = None,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        client: httpx.AsyncClient | None = None,
        timeout: float | httpx.Timeout | None = None,
        **kwargs: Any,
    ) -> AsyncDurableStream:
        """
        Create a new stream and return a handle.

        Returns:
            AsyncDurableStream handle
        """
        handle = cls(
            url,
            headers=headers,
            params=params,
            content_type=content_type,
            client=client,
            timeout=timeout,
            **kwargs,
        )
        try:
            await handle.create_stream(
                content_type=content_type,
                ttl_seconds=ttl_seconds,
                expires_at=expires_at,
                body=body,
            )
        except Exception:
            # Close the handle to avoid leaking the client if we created it
            await handle.aclose()
            raise
        return handle

    @classmethod
    async def head_static(
        cls,
        url: str,
        *,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        client: httpx.AsyncClient | None = None,
        timeout: float | httpx.Timeout | None = None,
    ) -> HeadResult:
        """Get stream metadata without creating a handle."""
        handle = cls(
            url,
            headers=headers,
            params=params,
            client=client,
            timeout=timeout,
        )
        try:
            return await handle.head()
        finally:
            if client is None:
                await handle.aclose()

    @classmethod
    async def delete_static(
        cls,
        url: str,
        *,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        client: httpx.AsyncClient | None = None,
        timeout: float | httpx.Timeout | None = None,
    ) -> None:
        """Delete a stream without creating a handle."""
        handle = cls(
            url,
            headers=headers,
            params=params,
            client=client,
            timeout=timeout,
        )
        try:
            await handle.delete()
        finally:
            if client is None:
                await handle.aclose()

    # === Instance methods ===

    async def head(self) -> HeadResult:
        """Get metadata for this stream via HEAD request."""
        resolved_headers = await resolve_headers_async(self._headers)
        resolved_params = await resolve_params_async(self._params)
        request_url = build_url_with_params(self._url, resolved_params)

        response = await self._client.head(
            request_url,
            headers=resolved_headers,
            timeout=self._timeout,
        )

        if response.status_code == 404:
            raise StreamNotFoundError(url=self._url)

        if not response.is_success:
            headers_dict = parse_httpx_headers(response.headers)
            raise error_from_status(
                response.status_code,
                self._url,
                headers=headers_dict,
            )

        content_type = response.headers.get("content-type")
        offset = response.headers.get(STREAM_NEXT_OFFSET_HEADER)
        etag = response.headers.get("etag")
        cache_control = response.headers.get("cache-control")

        if content_type:
            self._content_type = content_type

        return HeadResult(
            exists=True,
            content_type=content_type,
            offset=offset,
            etag=etag,
            cache_control=cache_control,
        )

    async def create_stream(
        self,
        *,
        content_type: str | None = None,
        ttl_seconds: int | None = None,
        expires_at: str | None = None,
        body: bytes | str | Any | None = None,
    ) -> None:
        """Create this stream on the server."""
        resolved_headers = await resolve_headers_async(self._headers)
        resolved_params = await resolve_params_async(self._params)
        request_url = build_url_with_params(self._url, resolved_params)

        ct = content_type or self._content_type
        if ct:
            resolved_headers["content-type"] = ct
        if ttl_seconds is not None:
            resolved_headers[STREAM_TTL_HEADER] = str(ttl_seconds)
        if expires_at:
            resolved_headers[STREAM_EXPIRES_AT_HEADER] = expires_at

        request_body: bytes | None = None
        if body is not None:
            request_body = encode_body(body)

        response = await self._client.put(
            request_url,
            headers=resolved_headers,
            content=request_body,
            timeout=self._timeout,
        )

        if response.status_code == 409:
            raise StreamExistsError(url=self._url)

        if not response.is_success:
            headers_dict = parse_httpx_headers(response.headers)
            raise error_from_status(
                response.status_code,
                self._url,
                body=response.text,
                headers=headers_dict,
                operation="create",
            )

        response_ct = response.headers.get("content-type")
        if response_ct:
            self._content_type = response_ct
        elif ct:
            self._content_type = ct

    async def delete(self) -> None:
        """Delete this stream."""
        resolved_headers = await resolve_headers_async(self._headers)
        resolved_params = await resolve_params_async(self._params)
        request_url = build_url_with_params(self._url, resolved_params)

        response = await self._client.delete(
            request_url,
            headers=resolved_headers,
            timeout=self._timeout,
        )

        if response.status_code == 404:
            raise StreamNotFoundError(url=self._url)

        if not response.is_success and response.status_code != 204:
            headers_dict = parse_httpx_headers(response.headers)
            raise error_from_status(
                response.status_code,
                self._url,
                headers=headers_dict,
            )

    async def append(
        self,
        data: bytes | str | Any,
        *,
        seq: str | None = None,
        content_type: str | None = None,
    ) -> AppendResult:
        """
        Append data to the stream.

        When batching is enabled (default), multiple concurrent append() calls
        will be batched together into a single request. All callers await until
        their data is durably acknowledged or an error occurs.

        Returns:
            AppendResult with the new tail offset
        """
        if self._batching:
            return await self._append_with_batching(data, seq, content_type)
        return await self._append_direct(data, seq, content_type)

    async def _append_direct(
        self,
        data: Any,
        seq: str | None,
        content_type: str | None,
    ) -> AppendResult:
        """Direct append without batching."""
        resolved_headers = await resolve_headers_async(self._headers)
        resolved_params = await resolve_params_async(self._params)
        request_url = build_url_with_params(self._url, resolved_params)

        ct = content_type or self._content_type
        if ct:
            resolved_headers["content-type"] = ct

        if seq:
            resolved_headers[STREAM_SEQ_HEADER] = seq

        if is_json_content_type(ct):
            body = json.dumps(wrap_for_json_append(data)).encode("utf-8")
        else:
            body = encode_body(data)

        response = await self._client.post(
            request_url,
            headers=resolved_headers,
            content=body,
            timeout=self._timeout,
        )

        if response.status_code == 409:
            raise SeqConflictError()

        if not response.is_success and response.status_code != 204:
            headers_dict = parse_httpx_headers(response.headers)
            raise error_from_status(
                response.status_code,
                self._url,
                body=response.text,
                headers=headers_dict,
            )

        next_offset = response.headers.get(STREAM_NEXT_OFFSET_HEADER)
        if not next_offset:
            raise ValueError(
                f"Server did not return {STREAM_NEXT_OFFSET_HEADER} header. "
                "This indicates a protocol violation."
            )
        return AppendResult(next_offset=next_offset)

    async def _append_with_batching(
        self,
        data: Any,
        seq: str | None,
        content_type: str | None,
    ) -> AppendResult:
        """Append with batching.

        All callers await until their data is durably acknowledged or an error
        occurs. The "leader" task (first to see _batch_in_flight=False)
        performs the flush and fulfills all queued futures.
        """
        is_leader = False
        loop = asyncio.get_running_loop()
        msg = _QueuedMessage(
            data=data, seq=seq, content_type=content_type, future=loop.create_future()
        )

        async with self._batch_lock:
            self._batch_queue.append(msg)

            # If no request in flight, this task becomes the leader
            if not self._batch_in_flight:
                self._batch_in_flight = True
                is_leader = True

        if is_leader:
            # Leader performs the flush loop
            await self._flush_batch()

        # All callers (including leader) await their future
        # This blocks until the batch containing this message completes
        assert msg.future is not None  # For type checker
        return await msg.future

    async def _flush_batch(self) -> None:
        """Flush the batch queue.

        Uses a loop instead of recursion to avoid stack overflow under
        sustained high-throughput writes. Fulfills all queued futures
        with either the result or the exception.
        """
        while True:
            async with self._batch_lock:
                if not self._batch_queue:
                    self._batch_in_flight = False
                    return

                # Take all queued messages
                messages = list(self._batch_queue)
                self._batch_queue.clear()

            try:
                result = await self._send_batch(messages)
                # Fulfill all futures with the shared result
                for msg in messages:
                    if msg.future is not None:
                        msg.future.set_result(result)
                # Loop continues to check if more messages accumulated
            except Exception as e:
                # Propagate error to all waiting callers
                for msg in messages:
                    if msg.future is not None:
                        msg.future.set_exception(e)
                # Reset the in-flight flag and exit
                async with self._batch_lock:
                    self._batch_in_flight = False
                return

    async def _send_batch(self, messages: list[_QueuedMessage]) -> AppendResult:
        """Send a batch of messages."""
        resolved_headers = await resolve_headers_async(self._headers)
        resolved_params = await resolve_params_async(self._params)
        request_url = build_url_with_params(self._url, resolved_params)

        ct = messages[0].content_type or self._content_type
        if ct:
            resolved_headers["content-type"] = ct

        highest_seq: str | None = None
        for msg in reversed(messages):
            if msg.seq is not None:
                highest_seq = msg.seq
                break

        if highest_seq:
            resolved_headers[STREAM_SEQ_HEADER] = highest_seq

        if is_json_content_type(ct):
            values = [msg.data for msg in messages]
            body = batch_for_json_append(values)
        else:
            chunks = [encode_body(msg.data) for msg in messages]
            body = batch_for_bytes_append(chunks)

        response = await self._client.post(
            request_url,
            headers=resolved_headers,
            content=body,
            timeout=self._timeout,
        )

        if response.status_code == 409:
            raise SeqConflictError()

        if not response.is_success and response.status_code != 204:
            headers_dict = parse_httpx_headers(response.headers)
            raise error_from_status(
                response.status_code,
                self._url,
                body=response.text,
                headers=headers_dict,
            )

        next_offset = response.headers.get(STREAM_NEXT_OFFSET_HEADER)
        if not next_offset:
            raise ValueError(
                f"Server did not return {STREAM_NEXT_OFFSET_HEADER} header. "
                "This indicates a protocol violation."
            )
        return AppendResult(next_offset=next_offset)

    def stream(
        self,
        *,
        offset: Offset | None = None,
        live: LiveMode = "auto",
        cursor: str | None = None,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        **kwargs: Any,
    ) -> AsyncStreamSession:
        """
        Start an async read session for this stream.

        Returns an async context manager for reading from the stream.

        Example:
            async with handle.stream() as res:
                async for item in res.iter_json():
                    print(item)
        """
        merged_headers: HeadersLike = {}
        if self._headers:
            merged_headers.update(self._headers)
        if headers:
            merged_headers.update(headers)

        merged_params: ParamsLike = {}
        if self._params:
            merged_params.update(self._params)
        if params:
            merged_params.update(params)

        return astream_fn(
            self._url,
            offset=offset,
            live=live,
            cursor=cursor,
            headers=merged_headers or None,
            params=merged_params or None,
            on_error=self._on_error,
            client=self._client,
            timeout=self._timeout,
            **kwargs,
        )
