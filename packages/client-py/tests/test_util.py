"""Tests for utility functions."""

from durable_streams._util import (
    build_url_with_params,
    encode_body,
    is_json_content_type,
    is_sse_compatible_content_type,
    normalize_content_type,
    resolve_headers_sync,
    resolve_params_sync,
)


class TestResolveHeadersSync:
    """Tests for resolve_headers_sync."""

    def test_static_headers(self) -> None:
        headers = {"Authorization": "Bearer token", "X-Custom": "value"}
        result = resolve_headers_sync(headers)
        assert result == {"Authorization": "Bearer token", "X-Custom": "value"}

    def test_callable_headers(self) -> None:
        headers = {
            "Authorization": lambda: "Bearer dynamic-token",
            "X-Static": "static-value",
        }
        result = resolve_headers_sync(headers)
        assert result["Authorization"] == "Bearer dynamic-token"
        assert result["X-Static"] == "static-value"

    def test_none_headers(self) -> None:
        result = resolve_headers_sync(None)
        assert result == {}


class TestResolveParamsSync:
    """Tests for resolve_params_sync."""

    def test_static_params(self) -> None:
        params = {"key1": "value1", "key2": "value2"}
        result = resolve_params_sync(params)
        assert result == {"key1": "value1", "key2": "value2"}

    def test_callable_params(self) -> None:
        params = {
            "static": "value",
            "dynamic": lambda: "computed",
        }
        result = resolve_params_sync(params)
        assert result["static"] == "value"
        assert result["dynamic"] == "computed"

    def test_none_values_excluded(self) -> None:
        params = {"key1": "value1", "key2": None}
        result = resolve_params_sync(params)
        assert result == {"key1": "value1"}
        assert "key2" not in result

    def test_none_params(self) -> None:
        result = resolve_params_sync(None)
        assert result == {}


class TestNormalizeContentType:
    """Tests for normalize_content_type."""

    def test_simple_content_type(self) -> None:
        assert normalize_content_type("application/json") == "application/json"

    def test_with_charset(self) -> None:
        assert (
            normalize_content_type("application/json; charset=utf-8")
            == "application/json"
        )

    def test_with_multiple_params(self) -> None:
        assert (
            normalize_content_type("text/plain; charset=utf-8; boundary=something")
            == "text/plain"
        )

    def test_uppercase(self) -> None:
        assert normalize_content_type("Application/JSON") == "application/json"

    def test_none(self) -> None:
        assert normalize_content_type(None) == ""

    def test_empty(self) -> None:
        assert normalize_content_type("") == ""


class TestIsJsonContentType:
    """Tests for is_json_content_type."""

    def test_application_json(self) -> None:
        assert is_json_content_type("application/json") is True

    def test_with_charset(self) -> None:
        assert is_json_content_type("application/json; charset=utf-8") is True

    def test_text_plain(self) -> None:
        assert is_json_content_type("text/plain") is False

    def test_none(self) -> None:
        assert is_json_content_type(None) is False


class TestIsSseCompatibleContentType:
    """Tests for is_sse_compatible_content_type."""

    def test_text_plain(self) -> None:
        assert is_sse_compatible_content_type("text/plain") is True

    def test_text_html(self) -> None:
        assert is_sse_compatible_content_type("text/html") is True

    def test_application_json(self) -> None:
        assert is_sse_compatible_content_type("application/json") is True

    def test_application_octet_stream(self) -> None:
        assert is_sse_compatible_content_type("application/octet-stream") is False

    def test_none(self) -> None:
        assert is_sse_compatible_content_type(None) is False


class TestEncodeBody:
    """Tests for encode_body."""

    def test_bytes_passthrough(self) -> None:
        data = b"hello world"
        result = encode_body(data)
        assert result == b"hello world"

    def test_string_to_utf8(self) -> None:
        data = "hello world"
        result = encode_body(data)
        assert result == b"hello world"

    def test_unicode_string(self) -> None:
        data = "héllo wörld"
        result = encode_body(data)
        assert result == "héllo wörld".encode()

    def test_dict_to_json(self) -> None:
        data = {"key": "value"}
        result = encode_body(data)
        assert result == b'{"key": "value"}'

    def test_list_to_json(self) -> None:
        data = [1, 2, 3]
        result = encode_body(data)
        assert result == b"[1, 2, 3]"


class TestBuildUrlWithParams:
    """Tests for build_url_with_params."""

    def test_adds_params_to_url(self) -> None:
        url = "https://example.com/stream"
        params = {"offset": "123", "live": "long-poll"}
        result = build_url_with_params(url, params)
        assert "offset=123" in result
        assert "live=long-poll" in result

    def test_preserves_existing_params(self) -> None:
        url = "https://example.com/stream?existing=value"
        params = {"new": "param"}
        result = build_url_with_params(url, params)
        assert "existing=value" in result
        assert "new=param" in result

    def test_empty_params(self) -> None:
        url = "https://example.com/stream"
        result = build_url_with_params(url, {})
        assert result == "https://example.com/stream"

    def test_url_encoding(self) -> None:
        url = "https://example.com/stream"
        params = {"key": "value with spaces"}
        result = build_url_with_params(url, params)
        assert "value+with+spaces" in result or "value%20with%20spaces" in result
