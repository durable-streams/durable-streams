"""
DurableStream - Synchronous handle class for read/write operations.

This provides a persistent handle to a stream with methods for creating,
reading, appending, and deleting streams.
"""

from __future__ import annotations

import json
import threading
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
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
from durable_streams._response import StreamResponse
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
    resolve_headers_sync,
    resolve_params_sync,
)
from durable_streams.stream import stream as stream_fn


@dataclass
class _QueuedMessage:
    """Internal type for batching queue."""

    data: Any
    seq: str | None
    content_type: str | None
    future: Future[AppendResult] = field(default_factory=lambda: Future())


class DurableStream:
    """
    A synchronous handle to a durable stream for read/write operations.

    This is a lightweight, reusable handle - not a persistent connection.
    Create sessions as needed via stream().

    Example:
        >>> # Create a new stream
        >>> handle = DurableStream.create(
        ...     "https://example.com/stream",
        ...     content_type="application/json",
        ... )
        >>>
        >>> # Append data
        >>> handle.append({"message": "hello"})
        >>>
        >>> # Read data
        >>> with handle.stream() as res:
        ...     for item in res.iter_json():
        ...         print(item)
    """

    def __init__(
        self,
        url: str,
        *,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        content_type: str | None = None,
        client: httpx.Client | None = None,
        timeout: float | httpx.Timeout | None = None,
        batching: bool = True,
        on_error: Callable[[Exception], dict[str, Any] | None] | None = None,
    ) -> None:
        """
        Create a handle to a durable stream.

        No network IO is performed by the constructor.

        Args:
            url: The URL of the durable stream
            headers: HTTP headers (static strings or callables)
            params: Query parameters (static strings or callables)
            content_type: Content type for the stream
            client: Optional httpx.Client to use
            timeout: Request timeout
            batching: Enable automatic batching for append() calls
            on_error: Error handler callback
        """
        self._url = url
        self._headers = headers
        self._params = params
        self._content_type = content_type
        self._timeout = timeout or 30.0
        self._batching = batching
        self._on_error = on_error

        # Client management
        self._own_client = client is None
        self._client = client or httpx.Client(timeout=self._timeout)

        # Batching infrastructure
        self._batch_lock = threading.Lock()
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

    def close(self) -> None:
        """Close the handle and release resources."""
        if self._own_client:
            self._client.close()

    def __enter__(self) -> DurableStream:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    # === Static factory methods ===

    @classmethod
    def connect(
        cls,
        url: str,
        *,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        client: httpx.Client | None = None,
        timeout: float | httpx.Timeout | None = None,
        **kwargs: Any,
    ) -> DurableStream:
        """
        Connect to an existing stream (validates via HEAD).

        Args:
            url: Stream URL
            headers: HTTP headers
            params: Query parameters
            client: Optional httpx.Client
            timeout: Request timeout
            **kwargs: Additional arguments

        Returns:
            DurableStream handle with content_type populated

        Raises:
            StreamNotFoundError: If stream doesn't exist
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
            handle.head()  # Validates existence and populates content_type
        except Exception:
            # Close the handle to avoid leaking the client if we created it
            handle.close()
            raise
        return handle

    @classmethod
    def create(
        cls,
        url: str,
        *,
        content_type: str | None = None,
        ttl_seconds: int | None = None,
        expires_at: str | None = None,
        body: bytes | str | Any | None = None,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        client: httpx.Client | None = None,
        timeout: float | httpx.Timeout | None = None,
        **kwargs: Any,
    ) -> DurableStream:
        """
        Create a new stream and return a handle.

        Args:
            url: Stream URL
            content_type: Content type for the stream
            ttl_seconds: Time-to-live in seconds
            expires_at: Absolute expiry time (RFC3339)
            body: Optional initial body
            headers: HTTP headers
            params: Query parameters
            client: Optional httpx.Client
            timeout: Request timeout
            **kwargs: Additional arguments

        Returns:
            DurableStream handle

        Raises:
            StreamExistsError: If stream already exists with different config
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
            handle.create_stream(
                content_type=content_type,
                ttl_seconds=ttl_seconds,
                expires_at=expires_at,
                body=body,
            )
        except Exception:
            # Close the handle to avoid leaking the client if we created it
            handle.close()
            raise
        return handle

    @classmethod
    def head_static(
        cls,
        url: str,
        *,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        client: httpx.Client | None = None,
        timeout: float | httpx.Timeout | None = None,
    ) -> HeadResult:
        """
        Get stream metadata without creating a handle.

        Args:
            url: Stream URL
            headers: HTTP headers
            params: Query parameters
            client: Optional httpx.Client
            timeout: Request timeout

        Returns:
            HeadResult with stream metadata
        """
        handle = cls(
            url,
            headers=headers,
            params=params,
            client=client,
            timeout=timeout,
        )
        try:
            return handle.head()
        finally:
            if client is None:
                handle.close()

    @classmethod
    def delete_static(
        cls,
        url: str,
        *,
        headers: HeadersLike | None = None,
        params: ParamsLike | None = None,
        client: httpx.Client | None = None,
        timeout: float | httpx.Timeout | None = None,
    ) -> None:
        """
        Delete a stream without creating a handle.

        Args:
            url: Stream URL
            headers: HTTP headers
            params: Query parameters
            client: Optional httpx.Client
            timeout: Request timeout
        """
        handle = cls(
            url,
            headers=headers,
            params=params,
            client=client,
            timeout=timeout,
        )
        try:
            handle.delete()
        finally:
            if client is None:
                handle.close()

    # === Instance methods ===

    def head(self) -> HeadResult:
        """
        Get metadata for this stream via HEAD request.

        Returns:
            HeadResult with stream metadata

        Raises:
            StreamNotFoundError: If stream doesn't exist
        """
        resolved_headers = resolve_headers_sync(self._headers)
        resolved_params = resolve_params_sync(self._params)
        request_url = build_url_with_params(self._url, resolved_params)

        response = self._client.head(
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

        headers_dict = parse_httpx_headers(response.headers)
        content_type = response.headers.get("content-type")
        offset = response.headers.get(STREAM_NEXT_OFFSET_HEADER)
        etag = response.headers.get("etag")
        cache_control = response.headers.get("cache-control")

        # Update instance content type
        if content_type:
            self._content_type = content_type

        return HeadResult(
            exists=True,
            content_type=content_type,
            offset=offset,
            etag=etag,
            cache_control=cache_control,
        )

    def create_stream(
        self,
        *,
        content_type: str | None = None,
        ttl_seconds: int | None = None,
        expires_at: str | None = None,
        body: bytes | str | Any | None = None,
    ) -> None:
        """
        Create this stream on the server.

        Args:
            content_type: Content type for the stream
            ttl_seconds: Time-to-live in seconds
            expires_at: Absolute expiry time (RFC3339)
            body: Optional initial body

        Raises:
            StreamExistsError: If stream already exists with different config
        """
        resolved_headers = resolve_headers_sync(self._headers)
        resolved_params = resolve_params_sync(self._params)
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

        response = self._client.put(
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

        # Update content type from response
        response_ct = response.headers.get("content-type")
        if response_ct:
            self._content_type = response_ct
        elif ct:
            self._content_type = ct

    def delete(self) -> None:
        """
        Delete this stream.

        Raises:
            StreamNotFoundError: If stream doesn't exist
        """
        resolved_headers = resolve_headers_sync(self._headers)
        resolved_params = resolve_params_sync(self._params)
        request_url = build_url_with_params(self._url, resolved_params)

        response = self._client.delete(
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

    def append(
        self,
        data: bytes | str | Any,
        *,
        seq: str | None = None,
        content_type: str | None = None,
    ) -> AppendResult:
        """
        Append data to the stream.

        When batching is enabled (default), multiple concurrent append() calls
        will be batched together into a single request. All callers block until
        their data is durably acknowledged or an error occurs.

        Args:
            data: Data to append (bytes, string, or JSON-serializable value)
            seq: Optional sequence number for writer coordination
            content_type: Optional content type override

        Returns:
            AppendResult with the new tail offset

        Raises:
            SeqConflictError: If seq is lower than last appended
            DurableStreamError: For other protocol errors
        """
        if self._batching:
            return self._append_with_batching(data, seq, content_type)
        return self._append_direct(data, seq, content_type)

    def _append_direct(
        self,
        data: Any,
        seq: str | None,
        content_type: str | None,
    ) -> AppendResult:
        """Direct append without batching."""
        resolved_headers = resolve_headers_sync(self._headers)
        resolved_params = resolve_params_sync(self._params)
        request_url = build_url_with_params(self._url, resolved_params)

        ct = content_type or self._content_type
        if ct:
            resolved_headers["content-type"] = ct

        if seq:
            resolved_headers[STREAM_SEQ_HEADER] = seq

        # For JSON mode, wrap in array (server flattens one level)
        if is_json_content_type(ct):
            body = json.dumps(wrap_for_json_append(data)).encode("utf-8")
        else:
            body = encode_body(data)

        response = self._client.post(
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

    def _append_with_batching(
        self,
        data: Any,
        seq: str | None,
        content_type: str | None,
    ) -> AppendResult:
        """Append with batching - collect messages and send in batches.

        All callers block until their data is durably acknowledged or an error
        occurs. The "leader" thread (first to see _batch_in_flight=False)
        performs the flush and fulfills all queued futures.
        """
        is_leader = False
        msg = _QueuedMessage(data=data, seq=seq, content_type=content_type)

        with self._batch_lock:
            self._batch_queue.append(msg)

            # If no request in flight, this thread becomes the leader
            if not self._batch_in_flight:
                self._batch_in_flight = True
                is_leader = True

        if is_leader:
            # Leader performs the flush loop
            self._flush_batch()

        # All callers (including leader) wait on their future
        # This blocks until the batch containing this message completes
        return msg.future.result()

    def _flush_batch(self) -> None:
        """Flush the batch queue and send a single request.

        Uses a loop instead of recursion to avoid stack overflow under
        sustained high-throughput writes. Fulfills all queued futures
        with either the result or the exception.
        """
        while True:
            with self._batch_lock:
                if not self._batch_queue:
                    self._batch_in_flight = False
                    return

                # Take all queued messages
                messages = list(self._batch_queue)
                self._batch_queue.clear()

            try:
                result = self._send_batch(messages)
                # Fulfill all futures with the shared result
                for msg in messages:
                    msg.future.set_result(result)
                # Loop continues to check if more messages accumulated
            except Exception as e:
                # Propagate error to all waiting callers
                for msg in messages:
                    msg.future.set_exception(e)
                # Reset the in-flight flag and exit
                with self._batch_lock:
                    self._batch_in_flight = False
                return

    def _send_batch(self, messages: list[_QueuedMessage]) -> AppendResult:
        """Send a batch of messages as a single POST request."""
        resolved_headers = resolve_headers_sync(self._headers)
        resolved_params = resolve_params_sync(self._params)
        request_url = build_url_with_params(self._url, resolved_params)

        # Get content type
        ct = messages[0].content_type or self._content_type
        if ct:
            resolved_headers["content-type"] = ct

        # Get highest seq
        highest_seq: str | None = None
        for msg in reversed(messages):
            if msg.seq is not None:
                highest_seq = msg.seq
                break

        if highest_seq:
            resolved_headers[STREAM_SEQ_HEADER] = highest_seq

        # Build batched body
        if is_json_content_type(ct):
            # JSON mode: send array of values
            values = [msg.data for msg in messages]
            body = batch_for_json_append(values)
        else:
            # Bytes mode: concatenate
            chunks = [encode_body(msg.data) for msg in messages]
            body = batch_for_bytes_append(chunks)

        response = self._client.post(
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
    ) -> StreamResponse[Any]:
        """
        Start a read session for this stream.

        Args:
            offset: Starting offset
            live: Live mode behavior
            cursor: Cursor for CDN collapsing
            headers: Additional headers (merged with handle headers)
            params: Additional params (merged with handle params)
            **kwargs: Additional arguments

        Returns:
            StreamResponse for consuming stream data
        """
        # Merge headers and params
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

        return stream_fn(
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
