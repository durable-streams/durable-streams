"""Tests for one-shot consumption behavior of StreamResponse."""

from unittest.mock import MagicMock

import pytest

from durable_streams._errors import StreamConsumedError
from durable_streams._response import AsyncStreamResponse, StreamResponse


class TestStreamResponseOneShot:
    """Test that StreamResponse enforces one-shot consumption."""

    @pytest.fixture
    def mock_response(self) -> MagicMock:
        """Create a mock httpx Response."""
        response = MagicMock()
        response.headers = {
            "Stream-Next-Offset": "123",
            "Content-Type": "application/json",
            "Stream-Up-To-Date": "true",  # Important: prevents live tailing
        }
        response.status_code = 200
        response.reason_phrase = "OK"
        response.iter_bytes.return_value = iter([b'[{"id": 1}]'])
        response.read.return_value = b'[{"id": 1}]'
        response.close.return_value = None
        return response

    @pytest.fixture
    def stream_response(
        self, mock_response: MagicMock
    ) -> StreamResponse[dict[str, int]]:
        """Create a StreamResponse for testing."""
        return StreamResponse(
            url="https://example.com/stream",
            response=mock_response,
            client=MagicMock(),
            live=False,
            start_offset="-1",
            offset="123",
            cursor=None,
            fetch_next=MagicMock(),
            is_sse=False,
        )

    def test_cannot_iterate_twice(
        self, stream_response: StreamResponse[dict[str, int]]
    ) -> None:
        """Test that iterating twice raises StreamConsumedError."""
        # First iteration should work
        list(stream_response)

        # Second iteration should raise
        with pytest.raises(StreamConsumedError) as exc_info:
            list(stream_response)

        assert "__iter__" in str(exc_info.value)

    def test_cannot_read_after_iterate(
        self, stream_response: StreamResponse[dict[str, int]]
    ) -> None:
        """Test that read_bytes after iteration raises StreamConsumedError."""
        list(stream_response)

        with pytest.raises(StreamConsumedError) as exc_info:
            stream_response.read_bytes()

        assert "read_bytes" in str(exc_info.value)

    def test_cannot_iterate_after_read(
        self, stream_response: StreamResponse[dict[str, int]], mock_response: MagicMock
    ) -> None:
        """Test that iteration after read raises StreamConsumedError."""
        # Reset mock for read
        mock_response.read.return_value = b'[{"id": 1}]'

        stream_response.read_json()

        with pytest.raises(StreamConsumedError) as exc_info:
            list(stream_response)

        assert "__iter__" in str(exc_info.value)

    def test_cannot_call_different_iter_methods(
        self, stream_response: StreamResponse[dict[str, int]]
    ) -> None:
        """Test that calling different iter methods raises StreamConsumedError."""
        # Use iter_json
        list(stream_response.iter_json())

        # Try to use iter_text
        with pytest.raises(StreamConsumedError) as exc_info:
            list(stream_response.iter_text())

        assert "iter_text" in str(exc_info.value)
        assert "iter_json" in str(exc_info.value)

    def test_error_message_includes_methods(
        self, stream_response: StreamResponse[dict[str, int]], mock_response: MagicMock
    ) -> None:
        """Test that error message includes both method names."""
        mock_response.read.return_value = b'[{"id": 1}]'

        stream_response.read_json()

        with pytest.raises(StreamConsumedError) as exc_info:
            stream_response.read_text()

        error = exc_info.value
        assert error.attempted_method == "read_text"
        assert error.consumed_by == "read_json"


class TestAsyncStreamResponseOneShot:
    """Test that AsyncStreamResponse enforces one-shot consumption."""

    @pytest.fixture
    def mock_response(self) -> MagicMock:
        """Create a mock httpx Response."""
        response = MagicMock()
        response.headers = {
            "Stream-Next-Offset": "123",
            "Content-Type": "application/json",
            "Stream-Up-To-Date": "true",  # Important: prevents live tailing
        }
        response.status_code = 200
        response.reason_phrase = "OK"

        async def mock_aiter_bytes():
            yield b'[{"id": 1}]'

        async def mock_aread():
            return b'[{"id": 1}]'

        async def mock_aclose():
            pass

        response.aiter_bytes = mock_aiter_bytes
        response.aread = mock_aread
        response.aclose = mock_aclose
        return response

    @pytest.fixture
    def async_stream_response(
        self, mock_response: MagicMock
    ) -> AsyncStreamResponse[dict[str, int]]:
        """Create an AsyncStreamResponse for testing."""
        return AsyncStreamResponse(
            url="https://example.com/stream",
            response=mock_response,
            client=MagicMock(),
            live=False,
            start_offset="-1",
            offset="123",
            cursor=None,
            fetch_next=MagicMock(),
            is_sse=False,
        )

    @pytest.mark.anyio
    async def test_cannot_iterate_twice(
        self, async_stream_response: AsyncStreamResponse[dict[str, int]]
    ) -> None:
        """Test that iterating twice raises StreamConsumedError."""
        # First iteration
        async for _ in async_stream_response:
            pass

        # Second iteration should raise
        with pytest.raises(StreamConsumedError):
            async for _ in async_stream_response:
                pass

    @pytest.mark.anyio
    async def test_cannot_read_after_iterate(
        self, async_stream_response: AsyncStreamResponse[dict[str, int]]
    ) -> None:
        """Test that read after iteration raises StreamConsumedError."""
        async for _ in async_stream_response:
            pass

        with pytest.raises(StreamConsumedError):
            await async_stream_response.read_bytes()
