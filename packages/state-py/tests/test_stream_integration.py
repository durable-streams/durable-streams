"""Tests for stream integration - ported from stream-integration.test.ts."""

from __future__ import annotations

import time

import pytest
from durable_streams import AsyncDurableStream, DurableStream

from durable_streams_state import MaterializedState


@pytest.mark.integration
class TestStreamIntegration:
    """Test MaterializedState with actual durable streams."""

    def test_write_change_events_and_materialize_them(
        self,
        test_server: conftest.TestServer,  # noqa: F821
    ) -> None:
        """Should write change events to a stream and materialize them."""
        stream_path = f"/state/config-{int(time.time() * 1000)}"

        # Create the stream with JSON mode
        stream = DurableStream.create(
            url=f"{test_server.url}{stream_path}",
            content_type="application/json",
        )

        # Write change events
        stream.append(
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "insert"},
            }
        )

        stream.append(
            {
                "type": "config",
                "key": "language",
                "value": "en",
                "headers": {"operation": "insert"},
            }
        )

        stream.append(
            {
                "type": "config",
                "key": "theme",
                "value": "light",
                "old_value": "dark",
                "headers": {"operation": "update"},
            }
        )

        # Read back and materialize
        state = MaterializedState()
        with stream.stream(live=False) as res:
            for event in res.iter_json():
                state.apply(event)

        # Verify the materialized state
        assert state.get("config", "theme") == "light"
        assert state.get("config", "language") == "en"

    def test_stream_and_materialize_one_at_a_time(
        self,
        test_server: conftest.TestServer,  # noqa: F821
    ) -> None:
        """Should stream and materialize events one at a time."""
        stream_path = f"/state/streaming-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=f"{test_server.url}{stream_path}",
            content_type="application/json",
        )

        # Write events
        stream.append(
            {
                "type": "user",
                "key": "123",
                "value": {"name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        stream.append(
            {
                "type": "user",
                "key": "456",
                "value": {"name": "Alice", "email": "alice@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        # Stream and materialize one at a time
        state = MaterializedState()

        with stream.stream(live=False) as res:
            for event in res.iter_json():
                state.apply(event)

        # Verify
        assert state.get("user", "123") == {
            "name": "Kyle",
            "email": "kyle@example.com",
        }
        assert state.get("user", "456") == {
            "name": "Alice",
            "email": "alice@example.com",
        }

        users = state.get_type("user")
        assert len(users) == 2

    def test_handle_multiple_types_in_stream(
        self,
        test_server: conftest.TestServer,  # noqa: F821
    ) -> None:
        """Should handle multiple types in a stream."""
        stream_path = f"/state/multi-type-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=f"{test_server.url}{stream_path}",
            content_type="application/json",
        )

        stream.append(
            {
                "type": "user",
                "key": "123",
                "value": {"name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        stream.append(
            {
                "type": "user",
                "key": "456",
                "value": {"name": "Alice", "email": "alice@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        stream.append(
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "insert"},
            }
        )

        # Read and materialize
        state = MaterializedState()
        with stream.stream(live=False) as res:
            for event in res.iter_json():
                state.apply(event)

        # Verify both types are materialized correctly
        assert state.get("user", "123") == {
            "name": "Kyle",
            "email": "kyle@example.com",
        }
        assert state.get("user", "456") == {
            "name": "Alice",
            "email": "alice@example.com",
        }
        assert state.get("config", "theme") == "dark"

        # Verify we can query by type
        users = state.get_type("user")
        assert len(users) == 2

    def test_handle_delete_operations(
        self,
        test_server: conftest.TestServer,  # noqa: F821
    ) -> None:
        """Should handle delete operations."""
        stream_path = f"/state/delete-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=f"{test_server.url}{stream_path}",
            content_type="application/json",
        )

        stream.append(
            {
                "type": "user",
                "key": "123",
                "value": {"name": "Kyle"},
                "headers": {"operation": "insert"},
            }
        )

        stream.append(
            {
                "type": "user",
                "key": "456",
                "value": {"name": "Alice"},
                "headers": {"operation": "insert"},
            }
        )

        stream.append(
            {
                "type": "user",
                "key": "123",
                "old_value": {"name": "Kyle"},
                "headers": {"operation": "delete"},
            }
        )

        # Read and materialize
        state = MaterializedState()
        with stream.stream(live=False) as res:
            for event in res.iter_json():
                state.apply(event)

        # User 123 should be deleted, 456 should remain
        assert state.get("user", "123") is None
        assert state.get("user", "456") == {"name": "Alice"}

        users = state.get_type("user")
        assert len(users) == 1

    def test_resume_from_offset_and_materialize_new_events(
        self,
        test_server: conftest.TestServer,  # noqa: F821
    ) -> None:
        """Should resume from an offset and materialize new events."""
        stream_path = f"/state/resume-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=f"{test_server.url}{stream_path}",
            content_type="application/json",
        )

        # Write initial events
        stream.append(
            {
                "type": "config",
                "key": "theme",
                "value": "dark",
                "headers": {"operation": "insert"},
            }
        )

        stream.append(
            {
                "type": "config",
                "key": "language",
                "value": "en",
                "headers": {"operation": "insert"},
            }
        )

        # Read and materialize initial state
        state = MaterializedState()
        with stream.stream(live=False) as initial_res:
            for event in initial_res.iter_json():
                state.apply(event)
            # Save the offset
            saved_offset = initial_res.offset

        assert state.get("config", "theme") == "dark"
        assert state.get("config", "language") == "en"

        # Write more events
        stream.append(
            {
                "type": "config",
                "key": "theme",
                "value": "light",
                "old_value": "dark",
                "headers": {"operation": "update"},
            }
        )

        stream.append(
            {
                "type": "config",
                "key": "fontSize",
                "value": 14,
                "headers": {"operation": "insert"},
            }
        )

        # Resume from saved offset and materialize new events
        with stream.stream(offset=saved_offset, live=False) as resume_res:
            for event in resume_res.iter_json():
                state.apply(event)

        # Verify updated state
        assert state.get("config", "theme") == "light"
        assert state.get("config", "language") == "en"
        assert state.get("config", "fontSize") == 14


@pytest.mark.integration
class TestAsyncStreamIntegration:
    """Test MaterializedState with async durable streams."""

    @pytest.mark.asyncio
    async def test_async_write_and_materialize(
        self,
        test_server: conftest.TestServer,  # noqa: F821
    ) -> None:
        """Should write and materialize events asynchronously."""
        stream_path = f"/state/async-{int(time.time() * 1000)}"

        stream = await AsyncDurableStream.create(
            url=f"{test_server.url}{stream_path}",
            content_type="application/json",
        )

        # Write events
        await stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle"},
                "headers": {"operation": "insert"},
            }
        )
        await stream.append(
            {
                "type": "user",
                "key": "2",
                "value": {"name": "Alice"},
                "headers": {"operation": "insert"},
            }
        )

        # Read and materialize
        state = MaterializedState()
        async with stream.stream(live=False) as res:
            async for event in res.iter_json():
                state.apply(event)

        assert state.get("user", "1") == {"name": "Kyle"}
        assert state.get("user", "2") == {"name": "Alice"}
