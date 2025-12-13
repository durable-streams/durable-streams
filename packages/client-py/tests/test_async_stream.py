"""
Comprehensive tests for async stream functions and AsyncDurableStream.

Tests the async API matching the sync API coverage.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from durable_streams import (
    AsyncDurableStream,
    StreamConsumedError,
    astream,
)
from durable_streams._errors import StreamNotFoundError


class MockAsyncResponse:
    """Mock httpx.Response for async testing."""

    def __init__(
        self,
        content: bytes | str = b"",
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
    ):
        if isinstance(content, str):
            content = content.encode("utf-8")
        self._content = content
        self.status_code = status_code
        self.headers = httpx.Headers(headers or {})
        self.ok = 200 <= status_code < 400
        self.is_success = self.ok
        self.text = content.decode("utf-8") if content else ""
        self.reason_phrase = "OK" if self.ok else "Error"

    async def aread(self) -> bytes:
        return self._content

    async def aiter_bytes(self, _chunk_size: int = 1024):
        yield self._content

    async def aclose(self):
        pass


def setup_async_mock_client(mock_response: MockAsyncResponse) -> MagicMock:
    """Set up a mock httpx.AsyncClient that uses the streaming API."""
    mock_client = MagicMock(spec=httpx.AsyncClient)
    captured_request = MagicMock()
    mock_client.build_request.return_value = captured_request
    mock_client.send = AsyncMock(return_value=mock_response)
    return mock_client


def setup_async_mock_client_error(mock_response: MockAsyncResponse) -> MagicMock:
    """Set up a mock client that returns an error response."""
    mock_client = MagicMock(spec=httpx.AsyncClient)
    captured_request = MagicMock()
    mock_client.build_request.return_value = captured_request
    mock_client.send = AsyncMock(return_value=mock_response)
    return mock_client


def get_async_request_headers(mock_client: MagicMock, call_index: int = 0) -> dict:
    """Extract headers from the captured build_request call."""
    if call_index < len(mock_client.build_request.call_args_list):
        call_kwargs = mock_client.build_request.call_args_list[call_index]
        return dict(call_kwargs[1].get("headers", {}))
    return {}


def get_async_request_url(mock_client: MagicMock, call_index: int = 0) -> str:
    """Extract URL from the captured build_request call."""
    if call_index < len(mock_client.build_request.call_args_list):
        call_args = mock_client.build_request.call_args_list[call_index]
        return str(call_args[0][1])
    return ""


class TestAstreamBasicFunctionality:
    """Basic functionality tests for astream()."""

    @pytest.mark.anyio
    async def test_astream_makes_request_and_returns_response(self):
        """Should make request and return AsyncStreamResponse."""
        mock_response = MockAsyncResponse(
            b'[{"message": "hello"}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_20",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        res = await astream(
            "https://example.com/stream",
            client=mock_client,
        )

        mock_client.send.assert_called_once()
        assert res.url == "https://example.com/stream"
        assert res.content_type == "application/json"
        assert res.live == "auto"
        await res.aclose()

    @pytest.mark.anyio
    async def test_astream_throws_on_404(self):
        """Should throw StreamNotFoundError on 404."""
        mock_response = MockAsyncResponse(
            b"Not Found",
            status_code=404,
        )
        mock_client = setup_async_mock_client_error(mock_response)

        with pytest.raises(StreamNotFoundError) as exc_info:
            await astream("https://example.com/stream", client=mock_client)

        assert exc_info.value.status == 404

    @pytest.mark.anyio
    async def test_astream_respects_offset_option(self):
        """Should include offset in query parameters."""
        mock_response = MockAsyncResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "2_10",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        res = await astream(
            "https://example.com/stream",
            client=mock_client,
            offset="1_5",
        )

        called_url = get_async_request_url(mock_client)
        assert "offset=1_5" in called_url
        await res.aclose()


class TestAsyncStreamResponseConsumption:
    """Tests for AsyncStreamResponse consumption methods."""

    @pytest.mark.anyio
    async def test_read_text_async(self):
        """Should read text asynchronously."""
        mock_response = MockAsyncResponse(
            b"hello world",
            headers={
                "content-type": "text/plain",
                "Stream-Next-Offset": "1_11",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        res = await astream("https://example.com/stream", client=mock_client)
        text = await res.read_text()
        assert text == "hello world"

    @pytest.mark.anyio
    async def test_read_json_async(self):
        """Should read JSON asynchronously."""
        mock_response = MockAsyncResponse(
            b'[{"id": 1}, {"id": 2}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_30",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        res = await astream("https://example.com/stream", client=mock_client)
        result = await res.read_json()
        assert result == [{"id": 1}, {"id": 2}]

    @pytest.mark.anyio
    async def test_read_bytes_async(self):
        """Should read bytes asynchronously."""
        mock_response = MockAsyncResponse(
            bytes([1, 2, 3, 4, 5]),
            headers={
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        res = await astream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        body = await res.read_bytes()
        assert body == bytes([1, 2, 3, 4, 5])


class TestAsyncStreamIterators:
    """Tests for async iteration methods."""

    @pytest.mark.anyio
    async def test_aiter_bytes(self):
        """Should async iterate bytes."""
        mock_response = MockAsyncResponse(
            b"stream data",
            headers={
                "Stream-Next-Offset": "1_11",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        res = await astream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        chunks = []
        async for chunk in res:
            chunks.append(chunk)

        assert len(chunks) >= 1
        assert b"stream data" in b"".join(chunks)

    @pytest.mark.anyio
    async def test_aiter_json(self):
        """Should async iterate JSON items."""
        mock_response = MockAsyncResponse(
            b'[{"id": 1}, {"id": 2}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_30",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        res = await astream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        items = []
        async for item in res.iter_json():
            items.append(item)

        assert items == [{"id": 1}, {"id": 2}]


class TestAsyncConsumptionExclusivity:
    """Tests for async one-shot consumption semantics."""

    @pytest.mark.anyio
    async def test_throws_when_calling_read_bytes_twice(self):
        """Should throw when calling read_bytes() twice."""
        mock_response = MockAsyncResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        res = await astream("https://example.com/stream", client=mock_client)
        await res.read_bytes()

        with pytest.raises(StreamConsumedError):
            await res.read_bytes()

    @pytest.mark.anyio
    async def test_throws_when_calling_read_json_after_read_bytes(self):
        """Should throw when calling read_json() after read_bytes()."""
        mock_response = MockAsyncResponse(
            b'[{"id": 1}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        res = await astream("https://example.com/stream", client=mock_client)
        await res.read_bytes()

        with pytest.raises(StreamConsumedError):
            await res.read_json()


class TestAsyncContextManager:
    """Tests for async context manager protocol."""

    @pytest.mark.anyio
    async def test_async_context_manager(self):
        """Should close response when exiting async context."""
        mock_response = MockAsyncResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_4",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        res = await astream("https://example.com/stream", client=mock_client)
        async with res:
            await res.read_bytes()

        assert res.closed


class TestAsyncDurableStreamBasics:
    """Tests for AsyncDurableStream class."""

    @pytest.mark.anyio
    async def test_head_async(self):
        """Should call HEAD asynchronously."""
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.head = AsyncMock(
            return_value=MockAsyncResponse(
                headers={
                    "content-type": "application/json",
                    "Stream-Next-Offset": "1_0",
                    "etag": "abc123",
                },
            )
        )

        handle = AsyncDurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        result = await handle.head()

        mock_client.head.assert_called_once()
        assert result.exists is True
        assert result.content_type == "application/json"
        await handle.aclose()

    @pytest.mark.anyio
    async def test_create_async(self):
        """Should create stream asynchronously."""
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.put = AsyncMock(
            return_value=MockAsyncResponse(
                status_code=201,
                headers={"content-type": "application/json"},
            )
        )

        handle = AsyncDurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        await handle.create_stream(content_type="application/json")

        mock_client.put.assert_called_once()
        await handle.aclose()

    @pytest.mark.anyio
    async def test_append_async(self):
        """Should append asynchronously."""
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(
            return_value=MockAsyncResponse(
                headers={"Stream-Next-Offset": "1_11"},
            )
        )

        handle = AsyncDurableStream(
            "https://example.com/stream",
            client=mock_client,
            content_type="text/plain",
            batching=False,
        )

        result = await handle.append("hello world")

        mock_client.post.assert_called_once()
        assert result.next_offset == "1_11"
        await handle.aclose()

    @pytest.mark.anyio
    async def test_delete_async(self):
        """Should delete asynchronously."""
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.delete = AsyncMock(return_value=MockAsyncResponse())

        handle = AsyncDurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        await handle.delete()

        mock_client.delete.assert_called_once()
        await handle.aclose()

    @pytest.mark.anyio
    async def test_stream_async(self):
        """Should stream asynchronously."""
        mock_response = MockAsyncResponse(
            b"hello world",
            headers={
                "content-type": "text/plain",
                "Stream-Next-Offset": "1_11",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.build_request.return_value = MagicMock()
        mock_client.send = AsyncMock(return_value=mock_response)

        handle = AsyncDurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        res = await handle.stream(live=False)
        text = await res.read_text()

        assert text == "hello world"
        await handle.aclose()


class TestAsyncDurableStreamStaticMethods:
    """Tests for AsyncDurableStream static methods."""

    @pytest.mark.anyio
    async def test_connect_async(self):
        """Should connect asynchronously."""
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.head = AsyncMock(
            return_value=MockAsyncResponse(
                headers={"content-type": "application/json"},
            )
        )

        handle = await AsyncDurableStream.connect(
            "https://example.com/stream",
            client=mock_client,
        )

        assert handle.content_type == "application/json"
        await handle.aclose()

    @pytest.mark.anyio
    async def test_create_static_async(self):
        """Should create via static method."""
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.put = AsyncMock(
            return_value=MockAsyncResponse(
                status_code=201,
                headers={"content-type": "application/json"},
            )
        )

        handle = await AsyncDurableStream.create(
            "https://example.com/stream",
            client=mock_client,
            content_type="application/json",
        )

        assert handle.content_type == "application/json"
        await handle.aclose()

    @pytest.mark.anyio
    async def test_delete_static_async(self):
        """Should delete via static method."""
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.delete = AsyncMock(return_value=MockAsyncResponse())

        await AsyncDurableStream.delete_static(
            "https://example.com/stream",
            client=mock_client,
        )

        mock_client.delete.assert_called_once()


class TestAsyncDurableStreamErrors:
    """Tests for async error handling."""

    @pytest.mark.anyio
    async def test_head_throws_on_404(self):
        """Should throw StreamNotFoundError on 404."""
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.head = AsyncMock(return_value=MockAsyncResponse(status_code=404))

        handle = AsyncDurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        with pytest.raises(StreamNotFoundError):
            await handle.head()

        await handle.aclose()

    @pytest.mark.anyio
    async def test_append_throws_on_409(self):
        """Should throw SeqConflictError on 409."""
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=MockAsyncResponse(status_code=409))

        handle = AsyncDurableStream(
            "https://example.com/stream",
            client=mock_client,
            batching=False,
        )

        from durable_streams import SeqConflictError

        with pytest.raises(SeqConflictError):
            await handle.append("data", seq="old-seq")

        await handle.aclose()


class TestAsyncFunctionHeaders:
    """Tests for async function headers."""

    @pytest.mark.anyio
    async def test_calls_async_function_headers(self):
        """Should call async function headers."""
        mock_response = MockAsyncResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        async def header_fn():
            return "Bearer async-token"

        res = await astream(
            "https://example.com/stream",
            client=mock_client,
            headers={"Authorization": header_fn},
        )

        headers = get_async_request_headers(mock_client)
        assert headers["Authorization"] == "Bearer async-token"
        await res.aclose()

    @pytest.mark.anyio
    async def test_calls_async_function_params(self):
        """Should call async function params."""
        mock_response = MockAsyncResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_async_mock_client(mock_response)

        async def param_fn():
            return "async-tenant"

        res = await astream(
            "https://example.com/stream",
            client=mock_client,
            params={"tenant": param_fn},
        )

        called_url = get_async_request_url(mock_client)
        assert "tenant=async-tenant" in called_url
        await res.aclose()
