"""Tests for JSON flattening behavior."""

from durable_streams._parse import (
    decode_json_items,
    flatten_json_array,
)


class TestJsonFlatten:
    """Test JSON array flattening for iter_json semantics."""

    def test_flattens_simple_array(self) -> None:
        """Arrays should be flattened to individual items."""
        data = b"[1, 2, 3]"
        items = decode_json_items(data)
        assert items == [1, 2, 3]

    def test_flattens_object_array(self) -> None:
        """Arrays of objects should be flattened."""
        data = b'[{"id": 1}, {"id": 2}]'
        items = decode_json_items(data)
        assert items == [{"id": 1}, {"id": 2}]

    def test_wraps_single_object(self) -> None:
        """Single objects should be wrapped in a list."""
        data = b'{"id": 1}'
        items = decode_json_items(data)
        assert items == [{"id": 1}]

    def test_wraps_single_primitive(self) -> None:
        """Single primitives should be wrapped in a list."""
        data = b'"hello"'
        items = decode_json_items(data)
        assert items == ["hello"]

    def test_empty_array_returns_empty(self) -> None:
        """Empty arrays should return empty list."""
        data = b"[]"
        items = decode_json_items(data)
        assert items == []

    def test_nested_arrays_not_flattened(self) -> None:
        """Nested arrays should only flatten one level."""
        data = b"[[1, 2], [3, 4]]"
        items = decode_json_items(data)
        # Only one level of flattening - returns the inner arrays as items
        assert items == [[1, 2], [3, 4]]

    def test_with_custom_decoder(self) -> None:
        """Custom decoder should be applied to each item."""
        data = b'[{"name": "alice"}, {"name": "bob"}]'
        items = decode_json_items(data, decoder=lambda x: x["name"].upper())
        assert items == ["ALICE", "BOB"]

    def test_mixed_types_array(self) -> None:
        """Arrays with mixed types should be flattened."""
        data = b'[1, "two", {"three": 3}, [4]]'
        items = decode_json_items(data)
        assert items == [1, "two", {"three": 3}, [4]]


class TestFlattenJsonArrayDirect:
    """Direct tests for flatten_json_array function."""

    def test_returns_array_as_is(self) -> None:
        result = flatten_json_array([1, 2, 3])
        assert result == [1, 2, 3]

    def test_wraps_non_array_in_list(self) -> None:
        result = flatten_json_array({"key": "value"})
        assert result == [{"key": "value"}]

    def test_wraps_none(self) -> None:
        result = flatten_json_array(None)
        assert result == [None]

    def test_wraps_number(self) -> None:
        result = flatten_json_array(42)
        assert result == [42]

    def test_wraps_string(self) -> None:
        result = flatten_json_array("hello")
        assert result == ["hello"]

    def test_wraps_boolean(self) -> None:
        result = flatten_json_array(True)
        assert result == [True]
