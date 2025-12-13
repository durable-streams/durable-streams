"""
Comprehensive tests for stream() function.

Matches TypeScript client test coverage from stream-api.test.ts.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from durable_streams import (
    DurableStreamError,
    StreamConsumedError,
    stream,
)
from durable_streams._errors import StreamNotFoundError


class MockResponse:
    """Mock httpx.Response for testing."""

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

    def read(self) -> bytes:
        return self._content

    def iter_bytes(self, _chunk_size: int = 1024):
        yield self._content

    def close(self):
        pass


def setup_mock_client(mock_response: MockResponse) -> MagicMock:
    """Set up a mock httpx.Client that uses the streaming API."""
    mock_client = MagicMock(spec=httpx.Client)
    captured_request = MagicMock()
    mock_client.build_request.return_value = captured_request
    mock_client.send.return_value = mock_response
    return mock_client


def setup_mock_client_multi(responses: list[MockResponse]) -> MagicMock:
    """Set up a mock httpx.Client with multiple responses."""
    mock_client = MagicMock(spec=httpx.Client)
    captured_request = MagicMock()
    mock_client.build_request.return_value = captured_request
    mock_client.send.side_effect = responses
    return mock_client


def get_request_url(mock_client: MagicMock, call_index: int = 0) -> str:
    """Extract URL from the captured build_request call."""
    if call_index < len(mock_client.build_request.call_args_list):
        call_args = mock_client.build_request.call_args_list[call_index]
        return str(call_args[0][1])
    return ""


def get_request_headers(mock_client: MagicMock, call_index: int = 0) -> dict:
    """Extract headers from the captured build_request call."""
    if call_index < len(mock_client.build_request.call_args_list):
        call_kwargs = mock_client.build_request.call_args_list[call_index]
        return dict(call_kwargs[1].get("headers", {}))
    return {}


class TestStreamBasicFunctionality:
    """Basic functionality tests."""

    def test_stream_makes_request_and_returns_response(self):
        """Should make the first request and return a StreamResponse."""
        mock_response = MockResponse(
            b'[{"message": "hello"}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_20",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
        )

        mock_client.send.assert_called_once()
        assert res.url == "https://example.com/stream"
        assert res.content_type == "application/json"
        assert res.live == "auto"

    def test_stream_throws_on_404(self):
        """Should throw StreamNotFoundError on 404."""
        mock_response = MockResponse(
            b"Not Found",
            status_code=404,
            headers={"content-type": "text/plain"},
        )
        mock_client = setup_mock_client(mock_response)

        with pytest.raises(StreamNotFoundError) as exc_info:
            stream("https://example.com/stream", client=mock_client)
        assert exc_info.value.status == 404

    def test_stream_respects_offset_option(self):
        """Should include offset in query parameters."""
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "2_10",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        stream(
            "https://example.com/stream",
            client=mock_client,
            offset="1_5",
        )

        called_url = get_request_url(mock_client)
        assert "offset=1_5" in called_url

    def test_stream_sets_live_query_param_for_explicit_modes(self):
        """Should set live query param for explicit modes."""
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        stream(
            "https://example.com/stream",
            client=mock_client,
            live="long-poll",
        )

        called_url = get_request_url(mock_client)
        assert "live=long-poll" in called_url


class TestStreamResponseConsumption:
    """Tests for StreamResponse consumption methods."""

    def test_read_text_accumulates_text(self):
        """Should accumulate text with read_text()."""
        mock_response = MockResponse(
            b"hello world",
            headers={
                "content-type": "text/plain",
                "Stream-Next-Offset": "1_11",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream("https://example.com/stream", client=mock_client)
        text = res.read_text()
        assert text == "hello world"

    def test_read_json_accumulates_json(self):
        """Should accumulate JSON with read_json()."""
        mock_response = MockResponse(
            b'[{"id": 1}, {"id": 2}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_30",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream("https://example.com/stream", client=mock_client)
        result = res.read_json()
        assert result == [{"id": 1}, {"id": 2}]

    def test_read_bytes_accumulates_bytes(self):
        """Should accumulate bytes with read_bytes()."""
        mock_response = MockResponse(
            bytes([1, 2, 3, 4, 5]),
            headers={
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        body = res.read_bytes()
        assert body == bytes([1, 2, 3, 4, 5])


class TestStreamIterators:
    """Tests for iteration methods."""

    def test_iter_bytes_returns_chunks(self):
        """Should iterate bytes chunks."""
        mock_response = MockResponse(
            b"stream data",
            headers={
                "Stream-Next-Offset": "1_11",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        chunks = list(res)
        assert len(chunks) >= 1
        assert b"stream data" in b"".join(chunks)

    def test_iter_json_returns_items(self):
        """Should iterate JSON items."""
        mock_response = MockResponse(
            b'[{"id": 1}, {"id": 2}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_30",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        items = list(res.iter_json())
        assert items == [{"id": 1}, {"id": 2}]

    def test_iter_text_returns_strings(self):
        """Should iterate text chunks."""
        mock_response = MockResponse(
            b"hello world",
            headers={
                "content-type": "text/plain",
                "Stream-Next-Offset": "1_11",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        text_chunks = list(res.iter_text())
        assert "".join(text_chunks) == "hello world"


class TestConsumptionExclusivity:
    """Tests for one-shot consumption semantics."""

    def test_throws_when_calling_read_bytes_twice(self):
        """Should throw when calling read_bytes() twice."""
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream("https://example.com/stream", client=mock_client)
        res.read_bytes()

        with pytest.raises(StreamConsumedError):
            res.read_bytes()

    def test_throws_when_calling_read_json_after_read_bytes(self):
        """Should throw when calling read_json() after read_bytes()."""
        mock_response = MockResponse(
            b'[{"id": 1}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream("https://example.com/stream", client=mock_client)
        res.read_bytes()

        with pytest.raises(StreamConsumedError):
            res.read_json()

    def test_throws_when_iterating_after_read_json(self):
        """Should throw when iterating after read_json()."""
        mock_response = MockResponse(
            b'[{"id": 1}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream("https://example.com/stream", client=mock_client)
        res.read_json()

        with pytest.raises(StreamConsumedError):
            iter(res)


class TestContextManager:
    """Tests for context manager protocol."""

    def test_context_manager_closes_response(self):
        """Should close response when exiting context."""
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_4",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_response.close = MagicMock()
        mock_client = setup_mock_client(mock_response)

        with stream("https://example.com/stream", client=mock_client) as res:
            _ = res.read_bytes()

        assert res.closed


class TestAuthHeaders:
    """Tests for authentication and custom headers."""

    def test_includes_token_auth_header(self):
        """Should include Authorization header."""
        mock_response = MockResponse(
            b"ok",
            headers={
                "Stream-Next-Offset": "1_2",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        stream(
            "https://example.com/stream",
            client=mock_client,
            headers={"Authorization": "Bearer my-token"},
        )

        headers = get_request_headers(mock_client)
        assert "Authorization" in headers
        assert headers["Authorization"] == "Bearer my-token"

    def test_includes_custom_headers(self):
        """Should include custom headers."""
        mock_response = MockResponse(
            b"ok",
            headers={
                "Stream-Next-Offset": "1_2",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        stream(
            "https://example.com/stream",
            client=mock_client,
            headers={"x-custom": "value"},
        )

        headers = get_request_headers(mock_client)
        assert headers["x-custom"] == "value"


class TestFirstRequestSemantics:
    """Tests for first request semantics."""

    def test_rejects_on_401_auth_failure(self):
        """Should reject on 401 Unauthorized."""
        mock_response = MockResponse(
            b"Unauthorized",
            status_code=401,
        )
        mock_client = setup_mock_client(mock_response)

        with pytest.raises(DurableStreamError) as exc_info:
            stream("https://example.com/stream", client=mock_client)
        assert exc_info.value.status == 401

    def test_rejects_on_403_forbidden(self):
        """Should reject on 403 Forbidden."""
        mock_response = MockResponse(
            b"Forbidden",
            status_code=403,
        )
        mock_client = setup_mock_client(mock_response)

        with pytest.raises(DurableStreamError) as exc_info:
            stream("https://example.com/stream", client=mock_client)
        assert exc_info.value.status == 403

    def test_response_state_from_first_response_headers(self):
        """Should resolve with correct state from first response headers."""
        mock_response = MockResponse(
            b"data",
            headers={
                "content-type": "text/plain",
                "Stream-Next-Offset": "5_100",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            offset="5_50",
        )

        assert res.offset == "5_100"
        assert res.up_to_date is True
        assert res.content_type == "text/plain"

    def test_only_makes_one_request_on_resolve(self):
        """Should only make one request when stream() resolves."""
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_4",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        stream("https://example.com/stream", client=mock_client)

        assert mock_client.send.call_count == 1


class TestResponseMetadata:
    """Tests for response metadata properties (headers, status, ok, etc.)."""

    def test_exposes_http_headers(self):
        """Should expose response headers from first response."""
        mock_response = MockResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "etag": "abc123",
                "cache-control": "max-age=60",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream("https://example.com/stream", client=mock_client)

        assert res.headers.get("etag") == "abc123"
        assert res.headers.get("cache-control") == "max-age=60"
        assert res.headers.get("content-type") == "application/json"

    def test_exposes_status_code(self):
        """Should expose HTTP status from first response."""
        mock_response = MockResponse(
            b"[]",
            status_code=200,
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream("https://example.com/stream", client=mock_client)

        assert res.status == 200
        assert res.status_text == "OK"
        assert res.ok is True

    def test_exposes_start_offset(self):
        """Should expose the starting offset for this session."""
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "5_100",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            offset="5_50",
        )

        # start_offset should be the initial offset we passed in
        assert res.start_offset == "5_50"
        # offset should be updated from the response headers
        assert res.offset == "5_100"

    def test_ok_is_true_for_success(self):
        """Should be true for successful responses."""
        mock_response = MockResponse(
            b"[]",
            status_code=200,
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream("https://example.com/stream", client=mock_client)
        assert res.ok is True

    def test_headers_after_consumption(self):
        """Should expose headers even after consumption."""
        mock_response = MockResponse(
            b'[{"id": 1}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
                "etag": "test-etag",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream("https://example.com/stream", client=mock_client)

        assert res.headers.get("etag") == "test-etag"
        assert res.status == 200

        # Consume the response
        items = res.read_json()
        assert len(items) == 1

        # Metadata still accessible after consumption
        assert res.headers.get("etag") == "test-etag"


class TestLiveModeSemantics:
    """Tests for live mode behavior."""

    def test_stops_at_up_to_date_when_live_false(self):
        """Should stop at upToDate when live: false."""
        mock_response = MockResponse(
            b"chunk1",
            headers={
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        data = res.read_bytes()

        # Should only fetch once (no live polling)
        assert mock_client.send.call_count == 1
        assert data == b"chunk1"
        assert res.up_to_date is True

    def test_continues_polling_when_live_long_poll(self):
        """Should continue polling when live: 'long-poll'."""
        # First response: not up-to-date
        first_response = MockResponse(
            b"chunk1",
            headers={
                "Stream-Next-Offset": "1_5",
                # No Stream-Up-To-Date header = not up to date,
            },
        )

        # Second response: up-to-date
        second_response = MockResponse(
            b"chunk2",
            headers={
                "Stream-Next-Offset": "2_10",
                "Stream-Up-To-Date": "true",
            },
        )

        mock_client = setup_mock_client_multi([first_response, second_response])

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live="long-poll",
        )

        # Use read_json with live=long-poll continues until upToDate
        data = res.read_bytes()

        assert mock_client.send.call_count == 2
        assert data == b"chunk1chunk2"

    def test_stops_at_up_to_date_with_json(self):
        """Should stop at upToDate when live: false with read_json()."""
        mock_response = MockResponse(
            b'[{"id": 1}, {"id": 2}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_10",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        items = res.read_json()

        assert mock_client.send.call_count == 1
        assert items == [{"id": 1}, {"id": 2}]
        assert res.up_to_date is True


class TestOnErrorCallback:
    """Tests for on_error callback handling."""

    def test_on_error_returns_none_reraises(self):
        """Should re-raise when on_error returns None."""
        mock_response = MockResponse(
            b"Error",
            status_code=500,
        )
        mock_client = setup_mock_client(mock_response)

        def on_error_handler(_e: Exception) -> dict[str, Any] | None:
            return None  # No recovery

        with pytest.raises(DurableStreamError):
            stream(
                "https://example.com/stream",
                client=mock_client,
                on_error=on_error_handler,
            )

    def test_on_error_can_retry_with_new_headers(self):
        """Should retry with headers from on_error."""
        # First call fails
        first_response = MockResponse(
            b"Unauthorized",
            status_code=401,
        )

        # Second call succeeds
        second_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_4",
                "Stream-Up-To-Date": "true",
            },
        )

        mock_client = setup_mock_client_multi([first_response, second_response])

        retry_count = 0

        def on_error_handler(_e: Exception) -> dict[str, Any] | None:
            nonlocal retry_count
            retry_count += 1
            if retry_count == 1:
                # First error - retry with new auth
                return {"headers": {"Authorization": "Bearer new-token"}}
            return None  # Don't retry again

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            on_error=on_error_handler,
        )

        assert mock_client.send.call_count == 2
        assert res.url == "https://example.com/stream"


class TestParams:
    """Tests for query parameters."""

    def test_includes_custom_params(self):
        """Should include custom query params."""
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_4",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        stream(
            "https://example.com/stream",
            client=mock_client,
            params={"tenant": "acme", "version": "v1"},
        )

        called_url = get_request_url(mock_client)
        assert "tenant=acme" in called_url
        assert "version=v1" in called_url


class TestEvents:
    """Tests for event iteration."""

    def test_iter_events_yields_events_with_metadata(self):
        """Should yield StreamEvent objects with metadata."""
        mock_response = MockResponse(
            b'[{"id": 1}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_10",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        events = list(res.iter_events())
        assert len(events) == 1
        assert events[0].data == [{"id": 1}]
        assert events[0].next_offset == "1_10"
        assert events[0].up_to_date is True

    def test_iter_events_text_mode(self):
        """Should yield text data in text mode."""
        mock_response = MockResponse(
            b"hello",
            headers={
                "content-type": "text/plain",
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        events = list(res.iter_events(mode="text"))
        assert len(events) == 1
        assert events[0].data == "hello"

    def test_iter_events_bytes_mode(self):
        """Should yield bytes data in bytes mode."""
        mock_response = MockResponse(
            b"\x01\x02\x03",
            headers={
                "Stream-Next-Offset": "1_3",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        events = list(res.iter_events(mode="bytes"))
        assert len(events) == 1
        assert events[0].data == b"\x01\x02\x03"


class TestJsonBatches:
    """Tests for JSON batch methods."""

    def test_iter_json_batches_preserves_boundaries(self):
        """Should preserve batch boundaries."""
        mock_response = MockResponse(
            b'[{"id": 1}, {"id": 2}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_10",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live=False,
        )

        batches = list(res.iter_json_batches())
        assert len(batches) == 1
        assert batches[0] == [{"id": 1}, {"id": 2}]

    def test_read_json_batches_returns_list_of_lists(self):
        """Should return list of lists."""
        # Two responses
        first_response = MockResponse(
            b'[{"id": 1}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_5",
                # No Stream-Up-To-Date header = not up to date,
            },
        )
        second_response = MockResponse(
            b'[{"id": 2}, {"id": 3}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "2_10",
                "Stream-Up-To-Date": "true",
            },
        )

        mock_client = setup_mock_client_multi([first_response, second_response])

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live="long-poll",
        )

        batches = res.read_json_batches()
        assert len(batches) == 2
        assert batches[0] == [{"id": 1}]
        assert batches[1] == [{"id": 2}, {"id": 3}]
