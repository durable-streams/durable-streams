"""
Comprehensive tests for DurableStream class.

Matches TypeScript client test coverage from stream.test.ts.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import httpx
import pytest

from durable_streams import DurableStream, SeqConflictError
from durable_streams._errors import StreamExistsError, StreamNotFoundError


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


def setup_streaming_mock(mock_client: MagicMock, mock_response: MockResponse) -> None:
    """Set up a mock httpx.Client for streaming (build_request + send pattern)."""
    captured_request = MagicMock()
    mock_client.build_request.return_value = captured_request
    mock_client.send.return_value = mock_response


def get_streaming_url(mock_client: MagicMock, call_index: int = 0) -> str:
    """Extract URL from the captured build_request call."""
    if call_index < len(mock_client.build_request.call_args_list):
        call_args = mock_client.build_request.call_args_list[call_index]
        return str(call_args[0][1])
    return ""


def get_streaming_headers(mock_client: MagicMock, call_index: int = 0) -> dict:
    """Extract headers from the captured build_request call."""
    if call_index < len(mock_client.build_request.call_args_list):
        call_kwargs = mock_client.build_request.call_args_list[call_index]
        return dict(call_kwargs[1].get("headers", {}))
    return {}


class TestDurableStreamConstructor:
    """Tests for DurableStream constructor."""

    def test_creates_handle_without_network_io(self):
        """Should create a stream handle without network IO."""
        handle = DurableStream("https://example.com/stream")

        assert handle.url == "https://example.com/stream"
        assert handle.content_type is None
        handle.close()

    def test_accepts_static_headers(self):
        """Should accept static headers."""
        handle = DurableStream(
            "https://example.com/stream",
            headers={"Authorization": "Bearer my-token"},
        )
        assert handle.url == "https://example.com/stream"
        handle.close()

    def test_accepts_function_headers(self):
        """Should accept function headers."""
        handle = DurableStream(
            "https://example.com/stream",
            headers={"Authorization": lambda: "Bearer token"},
        )
        assert handle.url == "https://example.com/stream"
        handle.close()

    def test_accepts_custom_client(self):
        """Should accept custom httpx.Client."""
        mock_client = MagicMock(spec=httpx.Client)
        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )
        assert handle.url == "https://example.com/stream"


class TestDurableStreamHead:
    """Tests for DurableStream.head() method."""

    def test_head_calls_head_on_stream_url(self):
        """Should call HEAD on the stream URL."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.head.return_value = MockResponse(
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_0",
                "etag": "abc123",
            },
        )

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        result = handle.head()

        mock_client.head.assert_called_once()
        assert result.exists is True
        assert result.content_type == "application/json"
        assert result.offset == "1_0"
        assert result.etag == "abc123"

    def test_head_throws_on_404(self):
        """Should throw StreamNotFoundError on 404."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.head.return_value = MockResponse(
            status_code=404,
        )

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        with pytest.raises(StreamNotFoundError):
            handle.head()

    def test_head_updates_content_type_on_instance(self):
        """Should update contentType on instance."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.head.return_value = MockResponse(
            headers={"content-type": "text/plain"},
        )

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        assert handle.content_type is None
        handle.head()
        assert handle.content_type == "text/plain"


class TestDurableStreamStream:
    """Tests for DurableStream.stream() method."""

    def test_stream_reads_data(self):
        """Should read data from the stream using stream()."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_response = MockResponse(
            b"hello world",
            headers={
                "content-type": "text/plain",
                "Stream-Next-Offset": "1_11",
                "Stream-Up-To-Date": "true",
            },
        )
        setup_streaming_mock(mock_client, mock_response)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        response = handle.stream(live=False)

        mock_client.send.assert_called_once()
        text = response.read_text()
        assert text == "hello world"

    def test_stream_includes_offset_in_query_params(self):
        """Should include offset in query params when provided."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "2_5",
                "Stream-Up-To-Date": "true",
            },
        )
        setup_streaming_mock(mock_client, mock_response)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        handle.stream(offset="1_11", live=False)

        called_url = get_streaming_url(mock_client)
        assert "offset=1_11" in called_url

    def test_stream_includes_live_mode_in_query_params(self):
        """Should include live mode in query params."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        setup_streaming_mock(mock_client, mock_response)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        handle.stream(live="long-poll")

        called_url = get_streaming_url(mock_client)
        assert "live=long-poll" in called_url

    def test_stream_exposes_up_to_date_on_response(self):
        """Should expose upToDate on response."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_5",
                "Stream-Up-To-Date": "true",
            },
        )
        setup_streaming_mock(mock_client, mock_response)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        response = handle.stream(live=False)
        assert response.up_to_date is True


class TestDurableStreamStaticMethods:
    """Tests for DurableStream static methods."""

    def test_connect_validates_and_returns_handle(self):
        """DurableStream.connect should validate and return handle."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.head.return_value = MockResponse(
            headers={"content-type": "application/json"},
        )

        handle = DurableStream.connect(
            "https://example.com/stream",
            client=mock_client,
        )

        assert handle.content_type == "application/json"
        mock_client.head.assert_called_once()

    def test_head_static_returns_metadata(self):
        """DurableStream.head_static should return metadata without handle."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.head.return_value = MockResponse(
            headers={
                "content-type": "text/plain",
                "Stream-Next-Offset": "5_100",
            },
        )

        result = DurableStream.head_static(
            "https://example.com/stream",
            client=mock_client,
        )

        assert result.exists is True
        assert result.content_type == "text/plain"
        assert result.offset == "5_100"


class TestDurableStreamAuth:
    """Tests for authentication headers."""

    def test_includes_token_auth_header(self):
        """Should include token auth header."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.head.return_value = MockResponse(
            headers={"Stream-Next-Offset": "0"},
        )

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            headers={"Authorization": "Bearer my-secret-token"},
        )

        handle.head()

        call_kwargs = mock_client.head.call_args[1]
        assert call_kwargs["headers"]["Authorization"] == "Bearer my-secret-token"

    def test_includes_custom_header_names(self):
        """Should include custom header names."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.head.return_value = MockResponse(
            headers={"Stream-Next-Offset": "0"},
        )

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            headers={"x-api-key": "Bearer my-token"},
        )

        handle.head()

        call_kwargs = mock_client.head.call_args[1]
        assert call_kwargs["headers"]["x-api-key"] == "Bearer my-token"

    def test_resolves_function_headers(self):
        """Should resolve function headers."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.head.return_value = MockResponse(
            headers={"Stream-Next-Offset": "0"},
        )

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            headers={"Authorization": lambda: "Bearer dynamic-token"},
        )

        handle.head()

        call_kwargs = mock_client.head.call_args[1]
        assert call_kwargs["headers"]["Authorization"] == "Bearer dynamic-token"


class TestDurableStreamParams:
    """Tests for query parameters."""

    def test_includes_custom_query_params(self):
        """Should include custom query params."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.head.return_value = MockResponse(
            headers={"Stream-Next-Offset": "0"},
        )

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            params={"tenant": "acme", "version": "v1"},
        )

        handle.head()

        called_url = mock_client.head.call_args[0][0]
        assert "tenant=acme" in called_url
        assert "version=v1" in called_url


class TestDurableStreamCreate:
    """Tests for stream creation."""

    def test_create_sends_put_request(self):
        """Should create a stream with PUT request."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.put.return_value = MockResponse(
            status_code=201,
            headers={"content-type": "application/json"},
        )

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        handle.create_stream(content_type="application/json")

        call_kwargs = mock_client.put.call_args[1]
        assert call_kwargs["headers"]["content-type"] == "application/json"

    def test_create_sets_ttl_header(self):
        """Should set TTL header when provided."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.put.return_value = MockResponse(status_code=201)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        handle.create_stream(ttl_seconds=3600)

        call_kwargs = mock_client.put.call_args[1]
        assert call_kwargs["headers"]["Stream-TTL"] == "3600"

    def test_create_throws_on_conflict(self):
        """Should throw on conflict (409)."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.put.return_value = MockResponse(status_code=409)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        with pytest.raises(StreamExistsError):
            handle.create_stream()


class TestDurableStreamAppend:
    """Tests for stream appending."""

    def test_append_sends_post_request(self):
        """Should append data with POST request."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.post.return_value = MockResponse(
            headers={"Stream-Next-Offset": "1_11"},
        )

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            content_type="text/plain",
            batching=False,
        )

        handle.append("hello world")

        mock_client.post.assert_called_once()
        call_kwargs = mock_client.post.call_args[1]
        assert call_kwargs["content"] == b"hello world"

    def test_append_includes_seq_header(self):
        """Should include seq header when provided."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.post.return_value = MockResponse(
            headers={"Stream-Next-Offset": "1_4"},
        )

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            batching=False,
        )

        handle.append("data", seq="writer-1-001")

        call_kwargs = mock_client.post.call_args[1]
        assert call_kwargs["headers"]["Stream-Seq"] == "writer-1-001"

    def test_append_throws_on_404(self):
        """Should throw StreamNotFoundError on 404."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.post.return_value = MockResponse(status_code=404)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            batching=False,
        )

        with pytest.raises(StreamNotFoundError):
            handle.append("data")

    def test_append_throws_on_seq_conflict(self):
        """Should throw on seq conflict (409)."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.post.return_value = MockResponse(status_code=409)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            batching=False,
        )

        with pytest.raises(SeqConflictError):
            handle.append("data", seq="old-seq")


class TestDurableStreamDelete:
    """Tests for stream deletion."""

    def test_delete_sends_delete_request(self):
        """Should delete stream with DELETE request."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.delete.return_value = MockResponse()

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        handle.delete()

        mock_client.delete.assert_called_once()

    def test_delete_throws_on_404(self):
        """Should throw StreamNotFoundError on 404."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.delete.return_value = MockResponse(status_code=404)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
        )

        with pytest.raises(StreamNotFoundError):
            handle.delete()


class TestDurableStreamStaticDelete:
    """Tests for static delete."""

    def test_delete_static_sends_delete_request(self):
        """Should delete stream without creating instance."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.delete.return_value = MockResponse()

        DurableStream.delete_static(
            "https://example.com/stream",
            client=mock_client,
        )

        mock_client.delete.assert_called_once()

    def test_delete_static_includes_auth_headers(self):
        """Should include auth headers."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.delete.return_value = MockResponse()

        DurableStream.delete_static(
            "https://example.com/stream",
            client=mock_client,
            headers={"Authorization": "Bearer my-token"},
        )

        call_kwargs = mock_client.delete.call_args[1]
        assert call_kwargs["headers"]["Authorization"] == "Bearer my-token"


class TestDurableStreamCreate_Static:
    """Tests for static create."""

    def test_create_static_returns_handle(self):
        """DurableStream.create should return a handle."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_client.put.return_value = MockResponse(
            status_code=201,
            headers={"content-type": "application/json"},
        )

        handle = DurableStream.create(
            "https://example.com/stream",
            client=mock_client,
            content_type="application/json",
        )

        assert handle.url == "https://example.com/stream"
        assert handle.content_type == "application/json"


class TestDurableStreamMergedHeadersParams:
    """Tests for merging handle and call headers/params."""

    def test_merges_handle_and_call_headers(self):
        """Should merge handle-level and call-level headers."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_response = MockResponse(
            b"data",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1_4",
                "Stream-Up-To-Date": "true",
            },
        )
        setup_streaming_mock(mock_client, mock_response)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            headers={"X-Handle-Header": "from-handle"},
        )

        handle.stream(
            headers={"X-Call-Header": "from-call"},
        )

        headers = get_streaming_headers(mock_client)
        assert headers["X-Handle-Header"] == "from-handle"
        assert headers["X-Call-Header"] == "from-call"

    def test_overrides_handle_headers_with_call_headers(self):
        """Should override handle headers with call headers."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_4",
                "Stream-Up-To-Date": "true",
            },
        )
        setup_streaming_mock(mock_client, mock_response)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            headers={"Authorization": "Bearer handle-token"},
        )

        handle.stream(
            headers={"Authorization": "Bearer call-token"},
        )

        headers = get_streaming_headers(mock_client)
        assert headers["Authorization"] == "Bearer call-token"

    def test_merges_handle_and_call_params(self):
        """Should merge handle-level and call-level params."""
        mock_client = MagicMock(spec=httpx.Client)
        mock_response = MockResponse(
            b"data",
            headers={
                "Stream-Next-Offset": "1_4",
                "Stream-Up-To-Date": "true",
            },
        )
        setup_streaming_mock(mock_client, mock_response)

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            params={"tenant": "handle-tenant"},
        )

        handle.stream(
            params={"region": "call-region"},
        )

        called_url = get_streaming_url(mock_client)
        assert "tenant=handle-tenant" in called_url
        assert "region=call-region" in called_url


class TestDurableStreamContextManager:
    """Tests for context manager protocol."""

    def test_context_manager_closes_client(self):
        """Should close client when exiting context."""
        with DurableStream("https://example.com/stream") as handle:
            assert handle.url == "https://example.com/stream"

    def test_does_not_close_provided_client(self):
        """Should not close provided client."""
        mock_client = MagicMock(spec=httpx.Client)

        with DurableStream(
            "https://example.com/stream",
            client=mock_client,
        ):
            pass

        mock_client.close.assert_not_called()
