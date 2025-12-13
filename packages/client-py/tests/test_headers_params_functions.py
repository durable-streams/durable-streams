"""
Tests for function-based headers and params.

Matches TypeScript client test coverage from headers-params-functions.test.ts.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import httpx

from durable_streams import DurableStream, stream


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

    # Track the request for inspection
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


def get_request_headers(mock_client: MagicMock, call_index: int = 0) -> dict:
    """Extract headers from the captured build_request call."""
    if call_index < len(mock_client.build_request.call_args_list):
        call_kwargs = mock_client.build_request.call_args_list[call_index]
        return dict(call_kwargs[1].get("headers", {}))
    return {}


def get_request_url(mock_client: MagicMock, call_index: int = 0) -> str:
    """Extract URL from the captured build_request call."""
    if call_index < len(mock_client.build_request.call_args_list):
        call_args = mock_client.build_request.call_args_list[call_index]
        # URL is the second positional argument (after "GET")
        return str(call_args[0][1])
    return ""


class TestFunctionBasedHeaders:
    """Tests for function-based headers."""

    def test_calls_sync_function_headers(self):
        """Should call sync function headers."""
        mock_response = MockResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        header_fn = MagicMock(return_value="Bearer token-123")

        stream(
            "https://example.com/stream",
            client=mock_client,
            headers={"Authorization": header_fn},
        )

        header_fn.assert_called_once()
        headers = get_request_headers(mock_client)
        assert headers["Authorization"] == "Bearer token-123"

    def test_supports_multiple_function_headers(self):
        """Should support multiple function headers."""
        mock_response = MockResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        auth_fn = MagicMock(return_value="Bearer token")
        tenant_fn = MagicMock(return_value="tenant-123")

        stream(
            "https://example.com/stream",
            client=mock_client,
            headers={
                "Authorization": auth_fn,
                "X-Tenant-Id": tenant_fn,
            },
        )

        auth_fn.assert_called_once()
        tenant_fn.assert_called_once()
        headers = get_request_headers(mock_client)
        assert headers["Authorization"] == "Bearer token"
        assert headers["X-Tenant-Id"] == "tenant-123"

    def test_mixes_static_and_function_headers(self):
        """Should mix static and function headers."""
        mock_response = MockResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        dynamic_fn = MagicMock(return_value="dynamic-value")

        stream(
            "https://example.com/stream",
            client=mock_client,
            headers={
                "X-Static": "static-value",
                "X-Dynamic": dynamic_fn,
            },
        )

        dynamic_fn.assert_called_once()
        headers = get_request_headers(mock_client)
        assert headers["X-Static"] == "static-value"
        assert headers["X-Dynamic"] == "dynamic-value"


class TestFunctionBasedParams:
    """Tests for function-based params."""

    def test_calls_sync_function_params(self):
        """Should call sync function params."""
        mock_response = MockResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        param_fn = MagicMock(return_value="tenant-abc")

        stream(
            "https://example.com/stream",
            client=mock_client,
            params={"tenant": param_fn},
        )

        param_fn.assert_called_once()
        called_url = get_request_url(mock_client)
        assert "tenant=tenant-abc" in called_url

    def test_supports_multiple_function_params(self):
        """Should support multiple function params."""
        mock_response = MockResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        tenant_fn = MagicMock(return_value="tenant-123")
        region_fn = MagicMock(return_value="us-west")

        stream(
            "https://example.com/stream",
            client=mock_client,
            params={
                "tenant": tenant_fn,
                "region": region_fn,
            },
        )

        tenant_fn.assert_called_once()
        region_fn.assert_called_once()
        called_url = get_request_url(mock_client)
        assert "tenant=tenant-123" in called_url
        assert "region=us-west" in called_url

    def test_mixes_static_and_function_params(self):
        """Should mix static and function params."""
        mock_response = MockResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        dynamic_fn = MagicMock(return_value="dynamic")

        stream(
            "https://example.com/stream",
            client=mock_client,
            params={
                "static": "value",
                "dynamic": dynamic_fn,
            },
        )

        dynamic_fn.assert_called_once()
        called_url = get_request_url(mock_client)
        assert "static=value" in called_url
        assert "dynamic=dynamic" in called_url


class TestDurableStreamHandleFunctionHeaders:
    """Tests for function headers with DurableStream."""

    def test_resolves_handle_function_headers(self):
        """Should resolve handle-level function headers."""
        mock_response = MockResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        header_fn = MagicMock(return_value="Bearer dynamic-token")

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            headers={"Authorization": header_fn},
        )

        handle.stream()

        header_fn.assert_called()
        headers = get_request_headers(mock_client)
        assert headers["Authorization"] == "Bearer dynamic-token"

    def test_resolves_handle_function_params(self):
        """Should resolve handle-level function params."""
        mock_response = MockResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        param_fn = MagicMock(return_value="dynamic-tenant")

        handle = DurableStream(
            "https://example.com/stream",
            client=mock_client,
            params={"tenant": param_fn},
        )

        handle.stream()

        param_fn.assert_called()
        called_url = get_request_url(mock_client)
        assert "tenant=dynamic-tenant" in called_url


class TestCombinedHeadersAndParams:
    """Tests for combined function headers and params."""

    def test_supports_both_function_headers_and_params(self):
        """Should support both function headers and params."""
        mock_response = MockResponse(
            b"[]",
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
            },
        )
        mock_client = setup_mock_client(mock_response)

        header_fn = MagicMock(return_value="Bearer token")
        param_fn = MagicMock(return_value="tenant-123")

        stream(
            "https://example.com/stream",
            client=mock_client,
            headers={"Authorization": header_fn},
            params={"tenant": param_fn},
        )

        header_fn.assert_called_once()
        param_fn.assert_called_once()

        headers = get_request_headers(mock_client)
        assert headers["Authorization"] == "Bearer token"

        called_url = get_request_url(mock_client)
        assert "tenant=tenant-123" in called_url


class TestPerRequestResolutionInLiveMode:
    """Tests for per-request resolution in live mode."""

    def test_calls_header_functions_on_each_long_poll_request(self):
        """Should call header functions on each long-poll request."""
        call_count = 0

        def header_fn():
            nonlocal call_count
            call_count += 1
            return f"Bearer token-{call_count}"

        # First response: not up-to-date (no header)
        first_response = MockResponse(
            b'[{"id": 1}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
                # No Stream-Up-To-Date = not up to date
            },
        )

        # Second response: up-to-date
        second_response = MockResponse(
            b'[{"id": 2}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "2",
                "Stream-Up-To-Date": "true",
            },
        )

        mock_client = setup_mock_client_multi([first_response, second_response])

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live="long-poll",
            headers={"Authorization": header_fn},
        )

        # Consume to trigger live polling
        items = res.read_json()

        # Header function should be called at least twice (per-request resolution)
        assert call_count >= 2

        # Verify different values were used
        first_call_headers = get_request_headers(mock_client, 0)
        second_call_headers = get_request_headers(mock_client, 1)

        assert first_call_headers["Authorization"] == "Bearer token-1"
        assert second_call_headers["Authorization"] == "Bearer token-2"

        assert items == [{"id": 1}, {"id": 2}]

    def test_calls_param_functions_on_each_long_poll_request(self):
        """Should call param functions on each long-poll request."""
        call_count = 0

        def param_fn():
            nonlocal call_count
            call_count += 1
            return f"tenant-{call_count}"

        # First response: not up-to-date (no header)
        first_response = MockResponse(
            b'[{"id": 1}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "1",
            },
        )

        # Second response: up-to-date
        second_response = MockResponse(
            b'[{"id": 2}]',
            headers={
                "content-type": "application/json",
                "Stream-Next-Offset": "2",
                "Stream-Up-To-Date": "true",
            },
        )

        mock_client = setup_mock_client_multi([first_response, second_response])

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live="long-poll",
            params={"tenant": param_fn},
        )

        # Consume to trigger live polling
        items = res.read_json()

        # Param function should be called at least twice (per-request resolution)
        assert call_count >= 2

        # Verify different values were used
        first_call_url = get_request_url(mock_client, 0)
        second_call_url = get_request_url(mock_client, 1)

        assert "tenant=tenant-1" in first_call_url
        assert "tenant=tenant-2" in second_call_url

        assert items == [{"id": 1}, {"id": 2}]

    def test_calls_both_header_and_param_functions_on_each_poll(self):
        """Should call both header and param functions on each poll."""
        header_call_count = 0
        param_call_count = 0

        def header_fn():
            nonlocal header_call_count
            header_call_count += 1
            return f"Bearer token-{header_call_count}"

        def param_fn():
            nonlocal param_call_count
            param_call_count += 1
            return f"tenant-{param_call_count}"

        # Three responses
        responses = [
            MockResponse(
                b'[{"id": 1}]',
                headers={
                    "content-type": "application/json",
                    "Stream-Next-Offset": "1",
                    # No Stream-Up-To-Date = not up to date
                },
            ),
            MockResponse(
                b'[{"id": 2}]',
                headers={
                    "content-type": "application/json",
                    "Stream-Next-Offset": "2",
                    # No Stream-Up-To-Date = not up to date
                },
            ),
            MockResponse(
                b'[{"id": 3}]',
                headers={
                    "content-type": "application/json",
                    "Stream-Next-Offset": "3",
                    "Stream-Up-To-Date": "true",  # Present = up to date
                },
            ),
        ]

        mock_client = setup_mock_client_multi(responses)

        res = stream(
            "https://example.com/stream",
            client=mock_client,
            live="long-poll",
            headers={"Authorization": header_fn},
            params={"tenant": param_fn},
        )

        # Consume to trigger live polling
        items = res.read_json()

        # Both functions should be called at least 3 times
        assert header_call_count >= 3
        assert param_call_count >= 3

        assert items == [{"id": 1}, {"id": 2}, {"id": 3}]
