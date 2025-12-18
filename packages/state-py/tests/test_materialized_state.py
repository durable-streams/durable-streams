"""Tests for MaterializedState - ported from key-value.test.ts."""

from __future__ import annotations

from durable_streams_state import MaterializedState


class TestMaterializedState:
    """Test MaterializedState key-value operations."""

    def test_should_materialize_insert_events(self) -> None:
        state = MaterializedState()

        state.apply(
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "insert"},
            }
        )

        assert state.get("config", "theme") == "dark"

    def test_should_materialize_update_events(self) -> None:
        state = MaterializedState()

        state.apply(
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "insert"},
            }
        )

        state.apply(
            {
                "type": "config",
                "key": "theme",
                "value": "light",
                "old_value": "dark",
                "headers": {"operation": "update"},
            }
        )

        assert state.get("config", "theme") == "light"

    def test_should_materialize_delete_events(self) -> None:
        state = MaterializedState()

        state.apply(
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "insert"},
            }
        )

        state.apply(
            {
                "type": "config",
                "key": "theme",
                "old_value": "dark",
                "headers": {"operation": "delete"},
            }
        )

        assert state.get("config", "theme") is None

    def test_should_handle_multiple_types_in_same_stream(self) -> None:
        state = MaterializedState()

        state.apply(
            {
                "type": "user",
                "key": "123",
                "value": {"name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        state.apply(
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "insert"},
            }
        )

        assert state.get("user", "123") == {"name": "Kyle", "email": "kyle@example.com"}
        assert state.get("config", "theme") == "dark"

    def test_should_provide_access_to_all_rows_of_a_type(self) -> None:
        state = MaterializedState()

        state.apply(
            {
                "type": "user",
                "key": "123",
                "value": {"name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        state.apply(
            {
                "type": "user",
                "key": "456",
                "value": {"name": "Alice", "email": "alice@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        users = state.get_type("user")
        assert len(users) == 2
        assert users.get("123") == {"name": "Kyle", "email": "kyle@example.com"}
        assert users.get("456") == {"name": "Alice", "email": "alice@example.com"}

    def test_should_apply_batch_of_events(self) -> None:
        state = MaterializedState()

        state.apply_batch(
            [
                {
                    "type": "config",
                    "key": "theme",
                    "value": "dark",
                    "headers": {"operation": "insert"},
                },
                {
                    "type": "config",
                    "key": "language",
                    "value": "en",
                    "headers": {"operation": "insert"},
                },
            ]
        )

        assert state.get("config", "theme") == "dark"
        assert state.get("config", "language") == "en"

    def test_should_replay_from_scratch(self) -> None:
        events = [
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "insert"},
            },
            {
                "type": "config",
                "key": "theme",
                "value": "light",
                "headers": {"operation": "update"},
            },
        ]

        state = MaterializedState()
        state.clear()
        state.apply_batch(events)

        assert state.get("config", "theme") == "light"

    def test_should_handle_upsert_events(self) -> None:
        state = MaterializedState()

        # Upsert on new key acts like insert
        state.apply(
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "upsert"},
            }
        )

        assert state.get("config", "theme") == "dark"

        # Upsert on existing key acts like update
        state.apply(
            {
                "type": "config",
                "key": "theme",
                "value": "light",
                "headers": {"operation": "upsert"},
            }
        )

        assert state.get("config", "theme") == "light"

    def test_type_count_property(self) -> None:
        state = MaterializedState()

        assert state.type_count == 0

        state.apply(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Alice"},
                "headers": {"operation": "insert"},
            }
        )

        assert state.type_count == 1

        state.apply(
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "insert"},
            }
        )

        assert state.type_count == 2

    def test_types_property(self) -> None:
        state = MaterializedState()

        assert state.types == []

        state.apply(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Alice"},
                "headers": {"operation": "insert"},
            }
        )
        state.apply(
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "insert"},
            }
        )

        assert sorted(state.types) == ["config", "user"]

    def test_clear_removes_all_data(self) -> None:
        state = MaterializedState()

        state.apply(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Alice"},
                "headers": {"operation": "insert"},
            }
        )

        assert state.type_count == 1

        state.clear()

        assert state.type_count == 0
        assert state.get("user", "1") is None

    def test_ignores_malformed_events(self) -> None:
        state = MaterializedState()

        # Missing type
        state.apply({"key": "1", "value": "x", "headers": {"operation": "insert"}})  # type: ignore[typeddict-item]
        # Missing key
        state.apply({"type": "t", "value": "x", "headers": {"operation": "insert"}})  # type: ignore[typeddict-item]
        # Missing operation
        state.apply({"type": "t", "key": "1", "value": "x", "headers": {}})  # type: ignore[typeddict-item]

        assert state.type_count == 0
