"""Tests for header parsing utilities."""

import pytest

from durable_streams._parse import (
    batch_for_json_append,
    decode_json_items,
    flatten_json_array,
    parse_json_response,
    parse_response_headers,
    wrap_for_json_append,
)


class TestParseResponseHeaders:
    """Tests for parse_response_headers."""

    def test_parses_next_offset(self) -> None:
        headers = {"Stream-Next-Offset": "12345_678"}
        meta = parse_response_headers(headers)
        assert meta.next_offset == "12345_678"

    def test_parses_cursor(self) -> None:
        headers = {"Stream-Cursor": "abc123"}
        meta = parse_response_headers(headers)
        assert meta.cursor == "abc123"

    def test_parses_up_to_date(self) -> None:
        headers = {"Stream-Up-To-Date": "true"}
        meta = parse_response_headers(headers)
        assert meta.up_to_date is True

    def test_up_to_date_false_when_missing(self) -> None:
        headers = {"Stream-Next-Offset": "123"}
        meta = parse_response_headers(headers)
        assert meta.up_to_date is False

    def test_parses_content_type(self) -> None:
        headers = {"Content-Type": "application/json"}
        meta = parse_response_headers(headers)
        assert meta.content_type == "application/json"

    def test_case_insensitive_headers(self) -> None:
        headers = {
            "stream-next-offset": "123",
            "stream-cursor": "abc",
            "stream-up-to-date": "true",
        }
        meta = parse_response_headers(headers)
        assert meta.next_offset == "123"
        assert meta.cursor == "abc"
        assert meta.up_to_date is True

    def test_empty_headers(self) -> None:
        headers: dict[str, str] = {}
        meta = parse_response_headers(headers)
        assert meta.next_offset is None
        assert meta.cursor is None
        assert meta.up_to_date is False


class TestFlattenJsonArray:
    """Tests for flatten_json_array."""

    def test_flattens_array(self) -> None:
        data = [{"a": 1}, {"b": 2}]
        result = flatten_json_array(data)
        assert result == [{"a": 1}, {"b": 2}]

    def test_wraps_non_array(self) -> None:
        data = {"a": 1}
        result = flatten_json_array(data)
        assert result == [{"a": 1}]

    def test_empty_array(self) -> None:
        data: list[object] = []
        result = flatten_json_array(data)
        assert result == []

    def test_nested_array(self) -> None:
        data = [[1, 2], [3, 4]]
        result = flatten_json_array(data)
        assert result == [[1, 2], [3, 4]]  # Only one level of flattening

    def test_primitive_value(self) -> None:
        data = "hello"
        result = flatten_json_array(data)
        assert result == ["hello"]


class TestParseJsonResponse:
    """Tests for parse_json_response."""

    def test_parses_bytes(self) -> None:
        data = b'{"key": "value"}'
        result = parse_json_response(data)
        assert result == {"key": "value"}

    def test_parses_string(self) -> None:
        data = '{"key": "value"}'
        result = parse_json_response(data)
        assert result == {"key": "value"}

    def test_parses_array(self) -> None:
        data = b"[1, 2, 3]"
        result = parse_json_response(data)
        assert result == [1, 2, 3]


class TestDecodeJsonItems:
    """Tests for decode_json_items."""

    def test_flattens_and_returns_items(self) -> None:
        data = b'[{"id": 1}, {"id": 2}]'
        result = decode_json_items(data)
        assert result == [{"id": 1}, {"id": 2}]

    def test_with_decoder(self) -> None:
        data = b"[1, 2, 3]"
        result = decode_json_items(data, decoder=lambda x: x * 2)
        assert result == [2, 4, 6]

    def test_single_value(self) -> None:
        data = b'{"id": 1}'
        result = decode_json_items(data)
        assert result == [{"id": 1}]


class TestWrapForJsonAppend:
    """Tests for wrap_for_json_append."""

    def test_wraps_dict(self) -> None:
        result = wrap_for_json_append({"key": "value"})
        assert result == [{"key": "value"}]

    def test_wraps_string(self) -> None:
        result = wrap_for_json_append("hello")
        assert result == ["hello"]

    def test_wraps_number(self) -> None:
        result = wrap_for_json_append(42)
        assert result == [42]

    def test_wraps_array(self) -> None:
        # Arrays are also wrapped - server will flatten
        result = wrap_for_json_append([1, 2, 3])
        assert result == [[1, 2, 3]]


class TestBatchForJsonAppend:
    """Tests for batch_for_json_append."""

    def test_batches_items(self) -> None:
        items = [{"a": 1}, {"b": 2}]
        result = batch_for_json_append(items)
        assert result == b'[{"a": 1}, {"b": 2}]'

    def test_empty_raises(self) -> None:
        with pytest.raises(ValueError, match="empty"):
            batch_for_json_append([])
