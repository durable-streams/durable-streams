"""
StreamResponse and AsyncStreamResponse implementations.

These are one-shot response objects for consuming stream data.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Iterator
from typing import (
    TYPE_CHECKING,
    Any,
    Generic,
    Literal,
    TypeVar,
    cast,
)

from durable_streams._errors import (
    SSEBytesIterationError,
    SSEReadAllError,
    StreamConsumedError,
)
from durable_streams._parse import (
    decode_json_items,
)
from durable_streams._types import (
    LiveMode,
    Offset,
    StreamEvent,
)

if TYPE_CHECKING:
    import httpx

T = TypeVar("T")


class StreamResponse(Generic[T]):
    """
    Synchronous stream response object.

    This is a one-shot response - you can consume it in exactly one mode.
    Attempting to consume it again (or in a different mode) raises StreamConsumedError.

    Usage as a context manager is recommended:

        with stream(url) as res:
            for chunk in res:
                process(chunk)

    Consumption modes (choose ONE):
    - Iteration: `for chunk in res` yields bytes
    - `iter_text()`: yields decoded strings
    - `iter_json()`: yields parsed JSON items (flattened)
    - `iter_json_batches()`: yields lists of JSON items (preserves boundaries)
    - `iter_events()`: yields StreamEvent objects with metadata
    - `read_bytes()`: returns all bytes
    - `read_text()`: returns all text
    - `read_json()`: returns flattened list of JSON items
    - `read_json_batches()`: returns list of lists (preserves boundaries)
    """

    def __init__(
        self,
        *,
        url: str,
        response: httpx.Response,
        client: httpx.Client,
        live: LiveMode,
        start_offset: Offset | None,
        offset: Offset | None,
        cursor: str | None,
        fetch_next: Callable[[Offset, str | None], httpx.Response],
        is_sse: bool = False,
        own_client: bool = False,
    ) -> None:
        self._url = url
        self._response = response
        self._client = client
        self._live = live
        self._start_offset = start_offset or "-1"
        self._offset = offset or ""
        self._cursor = cursor
        self._fetch_next = fetch_next
        self._is_sse = is_sse
        self._own_client = own_client

        self._consumed_by: str | None = None
        self._closed = False
        self._up_to_date = False

        # Response metadata (updated on each response)
        self._headers = dict(response.headers)
        self._status = response.status_code
        self._status_text = response.reason_phrase or ""

        # Extract initial metadata
        self._content_type = response.headers.get("content-type")
        self._update_metadata_from_response(response)

    def _update_metadata_from_response(self, response: httpx.Response) -> None:
        """Update internal state from response headers."""
        from durable_streams._parse import (
            parse_httpx_headers,
            parse_response_headers,
        )

        # Update HTTP response metadata
        self._headers = dict(response.headers)
        self._status = response.status_code
        self._status_text = response.reason_phrase or ""

        headers = parse_httpx_headers(response.headers)
        meta = parse_response_headers(headers)

        if meta.next_offset:
            self._offset = meta.next_offset
        if meta.cursor:
            self._cursor = meta.cursor
        self._up_to_date = meta.up_to_date
        if meta.content_type and not self._content_type:
            self._content_type = meta.content_type

    def _ensure_not_consumed(self, method: str) -> None:
        """Raise if already consumed."""
        if self._consumed_by is not None:
            raise StreamConsumedError(
                attempted_method=method,
                consumed_by=self._consumed_by,
            )

    def _mark_consumed(self, method: str) -> None:
        """Mark as consumed by the given method."""
        self._consumed_by = method

    def _should_continue_live(self) -> bool:
        """
        Check if we should continue with live updates.

        The key insight is:
        - live=False: Stop at first up-to-date (catch-up only)
        - live="auto"/"long-poll"/"sse": Continue tailing even after up-to-date
        """
        if self._closed:
            return False
        # live=False means catch-up only - stop at first up-to-date
        if self._live is False:
            return not self._up_to_date
        # Otherwise, keep tailing until explicitly closed
        return True

    @property
    def url(self) -> str:
        """The stream URL."""
        return self._url

    @property
    def content_type(self) -> str | None:
        """The stream's content type."""
        return self._content_type

    @property
    def live(self) -> LiveMode:
        """The live mode for this session."""
        return cast(LiveMode, self._live)

    @property
    def offset(self) -> Offset:
        """Current offset (updates as data is consumed)."""
        return self._offset

    @property
    def cursor(self) -> str | None:
        """Current cursor for CDN collapsing."""
        return self._cursor

    @property
    def up_to_date(self) -> bool:
        """Whether we've caught up to the stream head."""
        return self._up_to_date

    @property
    def start_offset(self) -> Offset:
        """The starting offset for this session."""
        return self._start_offset

    @property
    def headers(self) -> dict[str, str]:
        """HTTP response headers from the most recent server response."""
        return self._headers

    @property
    def status(self) -> int:
        """HTTP status code from the most recent server response."""
        return self._status

    @property
    def status_text(self) -> str:
        """HTTP status text from the most recent server response."""
        return self._status_text

    @property
    def ok(self) -> bool:
        """Whether the most recent response was successful (status 200-299)."""
        return 200 <= self._status < 300

    @property
    def closed(self) -> bool:
        """Whether the stream is closed."""
        return self._closed

    def close(self) -> None:
        """Close the stream and release resources."""
        if not self._closed:
            self._closed = True
            self._response.close()
            # Close the client if we created it internally
            if self._own_client:
                self._client.close()

    def __enter__(self) -> StreamResponse[T]:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    # === Raw bytes iteration ===

    def __iter__(self) -> Iterator[bytes]:
        """
        Iterate over raw bytes chunks.

        Raises SSEBytesIterationError if in SSE mode - use iter_text() instead.
        """
        self._ensure_not_consumed("__iter__")

        if self._is_sse:
            raise SSEBytesIterationError()

        self._mark_consumed("__iter__")
        return self._iter_bytes_internal()

    def _iter_bytes_internal(self) -> Iterator[bytes]:
        """Internal bytes iteration with live continuation."""
        # Yield from first response
        try:
            for chunk in self._response.iter_bytes():
                yield chunk
        finally:
            self._response.close()

        # Continue with live updates if needed
        while self._should_continue_live():
            response = self._fetch_next(self._offset, self._cursor)
            try:
                self._update_metadata_from_response(response)

                # Handle 204 No Content (long-poll timeout)
                if response.status_code == 204:
                    response.close()
                    continue

                for chunk in response.iter_bytes():
                    yield chunk
            finally:
                response.close()

    # === Text iteration ===

    def iter_text(self, encoding: str = "utf-8") -> Iterator[str]:
        """
        Iterate over decoded text chunks.

        Args:
            encoding: Text encoding (default: utf-8).
                Note: In SSE mode, this must be "utf-8" per the SSE specification.

        Yields:
            Decoded text strings

        Raises:
            ValueError: If non-UTF-8 encoding is specified in SSE mode
        """
        self._ensure_not_consumed("iter_text")

        # SSE is UTF-8 only per spec
        if self._is_sse and encoding.lower().replace("-", "") != "utf8":
            raise ValueError(
                f"SSE mode only supports UTF-8 encoding (got {encoding!r}). "
                "The SSE specification requires UTF-8."
            )

        self._mark_consumed("iter_text")
        return self._iter_text_internal(encoding)

    def _iter_text_internal(self, encoding: str) -> Iterator[str]:
        """Internal text iteration using incremental decoding."""
        import codecs

        if self._is_sse:
            yield from self._iter_sse_text()
        else:
            # Use incremental decoder for correct handling of multi-byte chars
            # split across chunk boundaries
            decoder = codecs.getincrementaldecoder(encoding)("replace")
            try:
                for chunk in self._response.iter_bytes():
                    text = decoder.decode(chunk)
                    if text:
                        yield text
                # Flush any remaining bytes
                final = decoder.decode(b"", final=True)
                if final:
                    yield final
            finally:
                self._response.close()

            while self._should_continue_live():
                response = self._fetch_next(self._offset, self._cursor)
                decoder = codecs.getincrementaldecoder(encoding)("replace")
                try:
                    self._update_metadata_from_response(response)

                    if response.status_code == 204:
                        response.close()
                        continue

                    for chunk in response.iter_bytes():
                        text = decoder.decode(chunk)
                        if text:
                            yield text
                    final = decoder.decode(b"", final=True)
                    if final:
                        yield final
                finally:
                    response.close()

    def _iter_sse_text(self) -> Iterator[str]:
        """Iterate SSE data events as text."""
        from durable_streams._sse import SSEDataEvent, parse_sse_sync

        for event in parse_sse_sync(self._response.iter_bytes()):
            if isinstance(event, SSEDataEvent):
                yield event.data
            else:
                # Control event - update metadata
                self._offset = event.stream_next_offset
                if event.stream_cursor:
                    self._cursor = event.stream_cursor
                self._up_to_date = event.up_to_date

    # === JSON iteration ===

    def iter_json(
        self,
        decode: Callable[[Any], T] | None = None,
    ) -> Iterator[T]:
        """
        Iterate over parsed JSON items.

        JSON arrays are flattened - each array element is yielded separately.

        Args:
            decode: Optional function to decode each item

        Yields:
            Parsed (and optionally decoded) JSON items
        """
        self._ensure_not_consumed("iter_json")
        self._mark_consumed("iter_json")
        return self._iter_json_internal(decode)

    def _iter_json_internal(
        self,
        decode: Callable[[Any], T] | None,
    ) -> Iterator[T]:
        """Internal JSON iteration with flattening."""
        for batch in self._iter_json_batches_internal(decode):
            yield from batch

    def iter_json_batches(
        self,
        decode: Callable[[Any], T] | None = None,
    ) -> Iterator[list[T]]:
        """
        Iterate over JSON batches (preserves array boundaries).

        Args:
            decode: Optional function to decode each item

        Yields:
            Lists of parsed (and optionally decoded) JSON items
        """
        self._ensure_not_consumed("iter_json_batches")
        self._mark_consumed("iter_json_batches")
        return self._iter_json_batches_internal(decode)

    def _iter_json_batches_internal(
        self,
        decode: Callable[[Any], T] | None,
    ) -> Iterator[list[T]]:
        """Internal JSON batch iteration."""
        if self._is_sse:
            yield from self._iter_sse_json_batches(decode)
        else:
            # Read and parse the first response
            try:
                content = self._response.read()
                if content:
                    items = decode_json_items(content, decode)
                    if items:
                        yield items
            finally:
                self._response.close()

            # Continue with live updates if needed
            while self._should_continue_live():
                response = self._fetch_next(self._offset, self._cursor)
                try:
                    self._update_metadata_from_response(response)

                    if response.status_code == 204:
                        response.close()
                        continue

                    content = response.read()
                    if content:
                        items = decode_json_items(content, decode)
                        if items:
                            yield items
                finally:
                    response.close()

    def _iter_sse_json_batches(
        self,
        decode: Callable[[Any], T] | None,
    ) -> Iterator[list[T]]:
        """Iterate SSE data events as JSON batches."""
        from durable_streams._sse import SSEDataEvent, parse_sse_sync

        for event in parse_sse_sync(self._response.iter_bytes()):
            if isinstance(event, SSEDataEvent):
                items = decode_json_items(event.data, decode)
                if items:
                    yield items
            else:
                # Control event - update metadata
                self._offset = event.stream_next_offset
                if event.stream_cursor:
                    self._cursor = event.stream_cursor
                self._up_to_date = event.up_to_date

    # === Event iteration ===

    def iter_events(
        self,
        mode: Literal["bytes", "text", "json", "json_batches"] = "json",
        *,
        encoding: str = "utf-8",
        decode: Callable[[Any], T] | None = None,
    ) -> Iterator[StreamEvent[Any]]:
        """
        Iterate over events with metadata.

        Args:
            mode: Data mode - "bytes", "text", "json", or "json_batches"
            encoding: Text encoding for text mode
            decode: Optional JSON decoder

        Yields:
            StreamEvent objects with data and metadata
        """
        self._ensure_not_consumed("iter_events")

        if mode == "bytes" and self._is_sse:
            raise SSEBytesIterationError()

        self._mark_consumed("iter_events")
        return self._iter_events_internal(mode, encoding, decode)

    def _iter_events_internal(
        self,
        mode: Literal["bytes", "text", "json", "json_batches"],
        encoding: str,
        decode: Callable[[Any], T] | None,
    ) -> Iterator[StreamEvent[Any]]:
        """Internal event iteration."""
        if self._is_sse:
            yield from self._iter_sse_events(mode, decode)
        else:
            # Handle first response
            try:
                content = self._response.read()
                if content:
                    data = self._convert_content(content, mode, encoding, decode)
                    yield StreamEvent(
                        data=data,
                        next_offset=self._offset,
                        up_to_date=self._up_to_date,
                        cursor=self._cursor,
                    )
            finally:
                self._response.close()

            # Continue with live updates
            while self._should_continue_live():
                response = self._fetch_next(self._offset, self._cursor)
                try:
                    self._update_metadata_from_response(response)

                    if response.status_code == 204:
                        response.close()
                        continue

                    content = response.read()
                    if content:
                        data = self._convert_content(content, mode, encoding, decode)
                        yield StreamEvent(
                            data=data,
                            next_offset=self._offset,
                            up_to_date=self._up_to_date,
                            cursor=self._cursor,
                        )
                finally:
                    response.close()

    def _convert_content(
        self,
        content: bytes,
        mode: Literal["bytes", "text", "json", "json_batches"],
        encoding: str,
        decode: Callable[[Any], T] | None,
    ) -> Any:
        """Convert content based on mode."""
        if mode == "bytes":
            return content
        if mode == "text":
            return content.decode(encoding)
        if mode == "json":
            # Return flattened items
            return decode_json_items(content, decode)
        if mode == "json_batches":
            # Return as list (single batch)
            return decode_json_items(content, decode)
        return content

    def _iter_sse_events(
        self,
        mode: Literal["bytes", "text", "json", "json_batches"],
        decode: Callable[[Any], T] | None,
    ) -> Iterator[StreamEvent[Any]]:
        """
        Iterate SSE events with metadata.

        SSE events come in data -> control order, so we buffer data events
        until we see the control event, then emit them with the correct
        metadata from the control event. This ensures StreamEvent.next_offset
        and other metadata are accurate for checkpointing.
        """
        from durable_streams._sse import SSEDataEvent, parse_sse_sync

        # Buffer to hold data events until we see their control event
        buffered_data: list[Any] = []

        for event in parse_sse_sync(self._response.iter_bytes()):
            if isinstance(event, SSEDataEvent):
                # Convert data based on mode but don't yield yet
                if mode == "text":
                    data: Any = event.data
                elif mode == "json" or mode == "json_batches":
                    data = decode_json_items(event.data, decode)
                else:
                    data = event.data.encode("utf-8")
                buffered_data.append(data)
            else:
                # Control event - update metadata first
                self._offset = event.stream_next_offset
                if event.stream_cursor:
                    self._cursor = event.stream_cursor
                self._up_to_date = event.up_to_date

                # Now emit all buffered data with correct metadata
                for data in buffered_data:
                    yield StreamEvent(
                        data=data,
                        next_offset=self._offset,
                        up_to_date=self._up_to_date,
                        cursor=self._cursor,
                    )
                buffered_data.clear()

        # Handle any remaining data (unlikely but be safe)
        for data in buffered_data:
            yield StreamEvent(
                data=data,
                next_offset=self._offset,
                up_to_date=self._up_to_date,
                cursor=self._cursor,
            )

    # === Read-all methods ===

    def read_bytes(self) -> bytes:
        """
        Read all bytes until up-to-date.

        Returns:
            All bytes concatenated
        """
        self._ensure_not_consumed("read_bytes")

        if self._is_sse:
            raise SSEBytesIterationError()

        self._mark_consumed("read_bytes")
        return self._read_bytes_internal()

    def _read_bytes_internal(self) -> bytes:
        """Internal read-all for bytes (accumulate until up-to-date)."""
        chunks: list[bytes] = []

        # Read first response
        try:
            chunks.append(self._response.read())
        finally:
            self._response.close()

        # Continue until up-to-date (read-all methods always stop at up-to-date)
        while not self._up_to_date:
            if self._live is False:
                break
            response = self._fetch_next(self._offset, self._cursor)
            try:
                self._update_metadata_from_response(response)

                if response.status_code == 204:
                    # 204 means "long-poll timeout, nothing new" - we're caught up
                    # Mark as up-to-date to prevent endless polling if header is missing
                    self._up_to_date = True
                    response.close()
                    continue

                chunks.append(response.read())
            finally:
                response.close()

        return b"".join(chunks)

    def read_text(self, encoding: str = "utf-8") -> str:
        """
        Read all text until up-to-date.

        Note: Not supported in SSE mode. Use iter_text() for SSE streams,
        or use live=False for read-all semantics.

        Args:
            encoding: Text encoding

        Returns:
            All text concatenated

        Raises:
            SSEReadAllError: If called in SSE mode
        """
        self._ensure_not_consumed("read_text")

        if self._is_sse:
            raise SSEReadAllError("read_text")

        self._mark_consumed("read_text")
        return self._read_text_internal(encoding)

    def _read_text_internal(self, encoding: str) -> str:
        """Internal read-all for text."""
        data = self._read_bytes_internal()
        return data.decode(encoding)

    def read_json(
        self,
        decode: Callable[[Any], T] | None = None,
    ) -> list[T]:
        """
        Read all JSON items until up-to-date.

        Returns flattened list of items (arrays are expanded).

        Note: Not supported in SSE mode. Use iter_json() for SSE streams,
        or use live=False for read-all semantics.

        Args:
            decode: Optional function to decode each item

        Returns:
            List of all JSON items

        Raises:
            SSEReadAllError: If called in SSE mode
        """
        self._ensure_not_consumed("read_json")

        if self._is_sse:
            raise SSEReadAllError("read_json")

        self._mark_consumed("read_json")
        return self._read_json_internal(decode)

    def _read_json_internal(
        self,
        decode: Callable[[Any], T] | None,
    ) -> list[T]:
        """Internal read-all for JSON (stops at up-to-date)."""
        all_items: list[T] = []

        # Read first response
        try:
            content = self._response.read()
            if content:
                items = decode_json_items(content, decode)
                all_items.extend(items)
        finally:
            self._response.close()

        # Continue until up-to-date (read-all methods stop at up-to-date)
        while not self._up_to_date:
            if self._live is False:
                break
            response = self._fetch_next(self._offset, self._cursor)
            try:
                self._update_metadata_from_response(response)

                if response.status_code == 204:
                    # 204 means "long-poll timeout, nothing new" - we're caught up
                    # Mark as up-to-date to prevent endless polling if header is missing
                    self._up_to_date = True
                    response.close()
                    continue

                content = response.read()
                if content:
                    items = decode_json_items(content, decode)
                    all_items.extend(items)
            finally:
                response.close()

        return all_items

    def read_json_batches(
        self,
        decode: Callable[[Any], T] | None = None,
    ) -> list[list[T]]:
        """
        Read all JSON batches until up-to-date.

        Preserves array boundaries from each response.

        Note: Not supported in SSE mode. Use iter_json_batches() for SSE streams,
        or use live=False for read-all semantics.

        Args:
            decode: Optional function to decode each item

        Returns:
            List of lists of JSON items

        Raises:
            SSEReadAllError: If called in SSE mode
        """
        self._ensure_not_consumed("read_json_batches")

        if self._is_sse:
            raise SSEReadAllError("read_json_batches")

        self._mark_consumed("read_json_batches")
        return self._read_json_batches_internal(decode)

    def _read_json_batches_internal(
        self,
        decode: Callable[[Any], T] | None,
    ) -> list[list[T]]:
        """Internal read-all for JSON batches (stops at up-to-date)."""
        all_batches: list[list[T]] = []

        try:
            content = self._response.read()
            if content:
                items = decode_json_items(content, decode)
                if items:
                    all_batches.append(items)
        finally:
            self._response.close()

        while not self._up_to_date:
            if self._live is False:
                break
            response = self._fetch_next(self._offset, self._cursor)
            try:
                self._update_metadata_from_response(response)

                if response.status_code == 204:
                    # 204 means "long-poll timeout, nothing new" - we're caught up
                    # Mark as up-to-date to prevent endless polling if header is missing
                    self._up_to_date = True
                    response.close()
                    continue

                content = response.read()
                if content:
                    items = decode_json_items(content, decode)
                    if items:
                        all_batches.append(items)
            finally:
                response.close()

        return all_batches


class AsyncStreamResponse(Generic[T]):
    """
    Asynchronous stream response object.

    This is a one-shot response - you can consume it in exactly one mode.

    Usage as an async context manager is recommended:

        async with astream(url) as res:
            async for chunk in res:
                process(chunk)
    """

    def __init__(
        self,
        *,
        url: str,
        response: httpx.Response,
        client: httpx.AsyncClient,
        live: LiveMode,
        start_offset: Offset | None,
        offset: Offset | None,
        cursor: str | None,
        fetch_next: Callable[[Offset, str | None], Any],  # Returns awaitable
        is_sse: bool = False,
        own_client: bool = False,
    ) -> None:
        self._url = url
        self._response = response
        self._client = client
        self._live = live
        self._start_offset = start_offset or "-1"
        self._offset = offset or ""
        self._cursor = cursor
        self._fetch_next = fetch_next
        self._is_sse = is_sse
        self._own_client = own_client

        self._consumed_by: str | None = None
        self._closed = False
        self._up_to_date = False

        # Response metadata (updated on each response)
        self._headers = dict(response.headers)
        self._status = response.status_code
        self._status_text = response.reason_phrase or ""

        self._content_type = response.headers.get("content-type")
        self._update_metadata_from_response(response)

    def _update_metadata_from_response(self, response: httpx.Response) -> None:
        """Update internal state from response headers."""
        from durable_streams._parse import (
            parse_httpx_headers,
            parse_response_headers,
        )

        # Update HTTP response metadata
        self._headers = dict(response.headers)
        self._status = response.status_code
        self._status_text = response.reason_phrase or ""

        headers = parse_httpx_headers(response.headers)
        meta = parse_response_headers(headers)

        if meta.next_offset:
            self._offset = meta.next_offset
        if meta.cursor:
            self._cursor = meta.cursor
        self._up_to_date = meta.up_to_date
        if meta.content_type and not self._content_type:
            self._content_type = meta.content_type

    def _ensure_not_consumed(self, method: str) -> None:
        """Raise if already consumed."""
        if self._consumed_by is not None:
            raise StreamConsumedError(
                attempted_method=method,
                consumed_by=self._consumed_by,
            )

    def _mark_consumed(self, method: str) -> None:
        """Mark as consumed by the given method."""
        self._consumed_by = method

    def _should_continue_live(self) -> bool:
        """
        Check if we should continue with live updates.

        The key insight is:
        - live=False: Stop at first up-to-date (catch-up only)
        - live="auto"/"long-poll"/"sse": Continue tailing even after up-to-date
        """
        if self._closed:
            return False
        # live=False means catch-up only - stop at first up-to-date
        if self._live is False:
            return not self._up_to_date
        # Otherwise, keep tailing until explicitly closed
        return True

    @property
    def url(self) -> str:
        return self._url

    @property
    def content_type(self) -> str | None:
        return self._content_type

    @property
    def live(self) -> LiveMode:
        return cast(LiveMode, self._live)

    @property
    def offset(self) -> Offset:
        return self._offset

    @property
    def cursor(self) -> str | None:
        return self._cursor

    @property
    def up_to_date(self) -> bool:
        return self._up_to_date

    @property
    def start_offset(self) -> Offset:
        """The starting offset for this session."""
        return self._start_offset

    @property
    def headers(self) -> dict[str, str]:
        """HTTP response headers from the most recent server response."""
        return self._headers

    @property
    def status(self) -> int:
        """HTTP status code from the most recent server response."""
        return self._status

    @property
    def status_text(self) -> str:
        """HTTP status text from the most recent server response."""
        return self._status_text

    @property
    def ok(self) -> bool:
        """Whether the most recent response was successful (status 200-299)."""
        return 200 <= self._status < 300

    @property
    def closed(self) -> bool:
        return self._closed

    async def aclose(self) -> None:
        """Close the stream and release resources."""
        if not self._closed:
            self._closed = True
            await self._response.aclose()
            # Close the client if we created it internally
            if self._own_client:
                await self._client.aclose()

    async def __aenter__(self) -> AsyncStreamResponse[T]:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.aclose()

    # === Raw bytes iteration ===

    def __aiter__(self) -> AsyncIterator[bytes]:
        """Iterate over raw bytes chunks."""
        self._ensure_not_consumed("__aiter__")

        if self._is_sse:
            raise SSEBytesIterationError()

        self._mark_consumed("__aiter__")
        return self._aiter_bytes_internal()

    async def _aiter_bytes_internal(self) -> AsyncIterator[bytes]:
        """Internal async bytes iteration."""
        try:
            async for chunk in self._response.aiter_bytes():
                yield chunk
        finally:
            await self._response.aclose()

        while self._should_continue_live():
            response = await self._fetch_next(self._offset, self._cursor)
            try:
                self._update_metadata_from_response(response)

                if response.status_code == 204:
                    await response.aclose()
                    continue

                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                await response.aclose()

    # === Text iteration ===

    def iter_text(self, encoding: str = "utf-8") -> AsyncIterator[str]:
        """
        Iterate over decoded text chunks.

        Args:
            encoding: Text encoding (default: utf-8).
                Note: In SSE mode, this must be "utf-8" per the SSE specification.

        Raises:
            ValueError: If non-UTF-8 encoding is specified in SSE mode
        """
        self._ensure_not_consumed("iter_text")

        # SSE is UTF-8 only per spec
        if self._is_sse and encoding.lower().replace("-", "") != "utf8":
            raise ValueError(
                f"SSE mode only supports UTF-8 encoding (got {encoding!r}). "
                "The SSE specification requires UTF-8."
            )

        self._mark_consumed("iter_text")
        return self._aiter_text_internal(encoding)

    async def _aiter_text_internal(self, encoding: str) -> AsyncIterator[str]:
        """Internal async text iteration using incremental decoding."""
        import codecs

        if self._is_sse:
            async for text in self._aiter_sse_text():
                yield text
        else:
            # Use incremental decoder for correct handling of multi-byte chars
            # split across chunk boundaries
            decoder = codecs.getincrementaldecoder(encoding)("replace")
            try:
                async for chunk in self._response.aiter_bytes():
                    text = decoder.decode(chunk)
                    if text:
                        yield text
                # Flush any remaining bytes
                final = decoder.decode(b"", final=True)
                if final:
                    yield final
            finally:
                await self._response.aclose()

            while self._should_continue_live():
                response = await self._fetch_next(self._offset, self._cursor)
                decoder = codecs.getincrementaldecoder(encoding)("replace")
                try:
                    self._update_metadata_from_response(response)

                    if response.status_code == 204:
                        await response.aclose()
                        continue

                    async for chunk in response.aiter_bytes():
                        text = decoder.decode(chunk)
                        if text:
                            yield text
                    final = decoder.decode(b"", final=True)
                    if final:
                        yield final
                finally:
                    await response.aclose()

    async def _aiter_sse_text(self) -> AsyncIterator[str]:
        """Iterate SSE data events as text."""
        from durable_streams._sse import SSEDataEvent, parse_sse_async

        async for event in parse_sse_async(self._response.aiter_bytes()):
            if isinstance(event, SSEDataEvent):
                yield event.data
            else:
                self._offset = event.stream_next_offset
                if event.stream_cursor:
                    self._cursor = event.stream_cursor
                self._up_to_date = event.up_to_date

    # === JSON iteration ===

    def iter_json(
        self,
        decode: Callable[[Any], T] | None = None,
    ) -> AsyncIterator[T]:
        """Iterate over parsed JSON items (flattened)."""
        self._ensure_not_consumed("iter_json")
        self._mark_consumed("iter_json")
        return self._aiter_json_internal(decode)

    async def _aiter_json_internal(
        self,
        decode: Callable[[Any], T] | None,
    ) -> AsyncIterator[T]:
        """Internal async JSON iteration."""
        async for batch in self._aiter_json_batches_internal(decode):
            for item in batch:
                yield item

    def iter_json_batches(
        self,
        decode: Callable[[Any], T] | None = None,
    ) -> AsyncIterator[list[T]]:
        """Iterate over JSON batches (preserves array boundaries)."""
        self._ensure_not_consumed("iter_json_batches")
        self._mark_consumed("iter_json_batches")
        return self._aiter_json_batches_internal(decode)

    async def _aiter_json_batches_internal(
        self,
        decode: Callable[[Any], T] | None,
    ) -> AsyncIterator[list[T]]:
        """Internal async JSON batch iteration."""
        if self._is_sse:
            async for batch in self._aiter_sse_json_batches(decode):
                yield batch
        else:
            try:
                content = await self._response.aread()
                if content:
                    items = decode_json_items(content, decode)
                    if items:
                        yield items
            finally:
                await self._response.aclose()

            while self._should_continue_live():
                response = await self._fetch_next(self._offset, self._cursor)
                try:
                    self._update_metadata_from_response(response)

                    if response.status_code == 204:
                        await response.aclose()
                        continue

                    content = await response.aread()
                    if content:
                        items = decode_json_items(content, decode)
                        if items:
                            yield items
                finally:
                    await response.aclose()

    async def _aiter_sse_json_batches(
        self,
        decode: Callable[[Any], T] | None,
    ) -> AsyncIterator[list[T]]:
        """Iterate SSE data events as JSON batches."""
        from durable_streams._sse import SSEDataEvent, parse_sse_async

        async for event in parse_sse_async(self._response.aiter_bytes()):
            if isinstance(event, SSEDataEvent):
                items = decode_json_items(event.data, decode)
                if items:
                    yield items
            else:
                self._offset = event.stream_next_offset
                if event.stream_cursor:
                    self._cursor = event.stream_cursor
                self._up_to_date = event.up_to_date

    # === Event iteration ===

    def iter_events(
        self,
        mode: Literal["bytes", "text", "json", "json_batches"] = "json",
        *,
        encoding: str = "utf-8",
        decode: Callable[[Any], T] | None = None,
    ) -> AsyncIterator[StreamEvent[Any]]:
        """Iterate over events with metadata."""
        self._ensure_not_consumed("iter_events")

        if mode == "bytes" and self._is_sse:
            raise SSEBytesIterationError()

        self._mark_consumed("iter_events")
        return self._aiter_events_internal(mode, encoding, decode)

    async def _aiter_events_internal(
        self,
        mode: Literal["bytes", "text", "json", "json_batches"],
        encoding: str,
        decode: Callable[[Any], T] | None,
    ) -> AsyncIterator[StreamEvent[Any]]:
        """Internal async event iteration."""
        if self._is_sse:
            async for event in self._aiter_sse_events(mode, decode):
                yield event
        else:
            try:
                content = await self._response.aread()
                if content:
                    data = self._convert_content(content, mode, encoding, decode)
                    yield StreamEvent(
                        data=data,
                        next_offset=self._offset,
                        up_to_date=self._up_to_date,
                        cursor=self._cursor,
                    )
            finally:
                await self._response.aclose()

            while self._should_continue_live():
                response = await self._fetch_next(self._offset, self._cursor)
                try:
                    self._update_metadata_from_response(response)

                    if response.status_code == 204:
                        await response.aclose()
                        continue

                    content = await response.aread()
                    if content:
                        data = self._convert_content(content, mode, encoding, decode)
                        yield StreamEvent(
                            data=data,
                            next_offset=self._offset,
                            up_to_date=self._up_to_date,
                            cursor=self._cursor,
                        )
                finally:
                    await response.aclose()

    def _convert_content(
        self,
        content: bytes,
        mode: Literal["bytes", "text", "json", "json_batches"],
        encoding: str,
        decode: Callable[[Any], T] | None,
    ) -> Any:
        """Convert content based on mode."""
        if mode == "bytes":
            return content
        if mode == "text":
            return content.decode(encoding)
        if mode == "json":
            return decode_json_items(content, decode)
        if mode == "json_batches":
            return decode_json_items(content, decode)
        return content

    async def _aiter_sse_events(
        self,
        mode: Literal["bytes", "text", "json", "json_batches"],
        decode: Callable[[Any], T] | None,
    ) -> AsyncIterator[StreamEvent[Any]]:
        """
        Iterate SSE events with metadata.

        SSE events come in data -> control order, so we buffer data events
        until we see the control event, then emit them with the correct
        metadata from the control event. This ensures StreamEvent.next_offset
        and other metadata are accurate for checkpointing.
        """
        from durable_streams._sse import SSEDataEvent, parse_sse_async

        # Buffer to hold data events until we see their control event
        buffered_data: list[Any] = []

        async for event in parse_sse_async(self._response.aiter_bytes()):
            if isinstance(event, SSEDataEvent):
                # Convert data based on mode but don't yield yet
                if mode == "text":
                    data: Any = event.data
                elif mode in ("json", "json_batches"):
                    data = decode_json_items(event.data, decode)
                else:
                    data = event.data.encode("utf-8")
                buffered_data.append(data)
            else:
                # Control event - update metadata first
                self._offset = event.stream_next_offset
                if event.stream_cursor:
                    self._cursor = event.stream_cursor
                self._up_to_date = event.up_to_date

                # Now emit all buffered data with correct metadata
                for data in buffered_data:
                    yield StreamEvent(
                        data=data,
                        next_offset=self._offset,
                        up_to_date=self._up_to_date,
                        cursor=self._cursor,
                    )
                buffered_data.clear()

        # Handle any remaining data (unlikely but be safe)
        for data in buffered_data:
            yield StreamEvent(
                data=data,
                next_offset=self._offset,
                up_to_date=self._up_to_date,
                cursor=self._cursor,
            )

    # === Read-all methods ===

    async def read_bytes(self) -> bytes:
        """Read all bytes until up-to-date."""
        self._ensure_not_consumed("read_bytes")

        if self._is_sse:
            raise SSEBytesIterationError()

        self._mark_consumed("read_bytes")
        return await self._aread_bytes_internal()

    async def _aread_bytes_internal(self) -> bytes:
        """Internal async read-all for bytes (accumulate until up-to-date)."""
        chunks: list[bytes] = []
        try:
            chunks.append(await self._response.aread())
        finally:
            await self._response.aclose()

        # Continue until up-to-date (read-all methods always stop at up-to-date)
        while not self._up_to_date:
            if self._live is False:
                break
            response = await self._fetch_next(self._offset, self._cursor)
            try:
                self._update_metadata_from_response(response)

                if response.status_code == 204:
                    # 204 means "long-poll timeout, nothing new" - we're caught up
                    # Mark as up-to-date to prevent endless polling if header is missing
                    self._up_to_date = True
                    await response.aclose()
                    continue

                chunks.append(await response.aread())
            finally:
                await response.aclose()

        return b"".join(chunks)

    async def read_text(self, encoding: str = "utf-8") -> str:
        """
        Read all text until up-to-date.

        Note: Not supported in SSE mode. Use iter_text() for SSE streams,
        or use live=False for read-all semantics.

        Raises:
            SSEReadAllError: If called in SSE mode
        """
        self._ensure_not_consumed("read_text")

        if self._is_sse:
            raise SSEReadAllError("read_text")

        self._mark_consumed("read_text")
        return await self._aread_text_internal(encoding)

    async def _aread_text_internal(self, encoding: str) -> str:
        """Internal async read-all for text."""
        data = await self._aread_bytes_internal()
        return data.decode(encoding)

    async def read_json(
        self,
        decode: Callable[[Any], T] | None = None,
    ) -> list[T]:
        """
        Read all JSON items until up-to-date.

        Note: Not supported in SSE mode. Use iter_json() for SSE streams,
        or use live=False for read-all semantics.

        Raises:
            SSEReadAllError: If called in SSE mode
        """
        self._ensure_not_consumed("read_json")

        if self._is_sse:
            raise SSEReadAllError("read_json")

        self._mark_consumed("read_json")
        return await self._aread_json_internal(decode)

    async def _aread_json_internal(
        self,
        decode: Callable[[Any], T] | None,
    ) -> list[T]:
        """Internal async read-all for JSON (stops at up-to-date)."""
        all_items: list[T] = []

        try:
            content = await self._response.aread()
            if content:
                items = decode_json_items(content, decode)
                all_items.extend(items)
        finally:
            await self._response.aclose()

        while not self._up_to_date:
            if self._live is False:
                break
            response = await self._fetch_next(self._offset, self._cursor)
            try:
                self._update_metadata_from_response(response)

                if response.status_code == 204:
                    # 204 means "long-poll timeout, nothing new" - we're caught up
                    # Mark as up-to-date to prevent endless polling if header is missing
                    self._up_to_date = True
                    await response.aclose()
                    continue

                content = await response.aread()
                if content:
                    items = decode_json_items(content, decode)
                    all_items.extend(items)
            finally:
                await response.aclose()

        return all_items

    async def read_json_batches(
        self,
        decode: Callable[[Any], T] | None = None,
    ) -> list[list[T]]:
        """
        Read all JSON batches until up-to-date.

        Note: Not supported in SSE mode. Use iter_json_batches() for SSE streams,
        or use live=False for read-all semantics.

        Raises:
            SSEReadAllError: If called in SSE mode
        """
        self._ensure_not_consumed("read_json_batches")

        if self._is_sse:
            raise SSEReadAllError("read_json_batches")

        self._mark_consumed("read_json_batches")
        return await self._aread_json_batches_internal(decode)

    async def _aread_json_batches_internal(
        self,
        decode: Callable[[Any], T] | None,
    ) -> list[list[T]]:
        """Internal async read-all for JSON batches (stops at up-to-date)."""
        all_batches: list[list[T]] = []

        try:
            content = await self._response.aread()
            if content:
                items = decode_json_items(content, decode)
                if items:
                    all_batches.append(items)
        finally:
            await self._response.aclose()

        while not self._up_to_date:
            if self._live is False:
                break
            response = await self._fetch_next(self._offset, self._cursor)
            try:
                self._update_metadata_from_response(response)

                if response.status_code == 204:
                    # 204 means "long-poll timeout, nothing new" - we're caught up
                    # Mark as up-to-date to prevent endless polling if header is missing
                    self._up_to_date = True
                    await response.aclose()
                    continue

                content = await response.aread()
                if content:
                    items = decode_json_items(content, decode)
                    if items:
                        all_batches.append(items)
            finally:
                await response.aclose()

        return all_batches
