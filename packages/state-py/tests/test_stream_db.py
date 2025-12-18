"""Tests for StreamDB - ported from stream-db.test.ts."""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING

import pytest
from durable_streams import AsyncDurableStream, DurableStream
from pydantic import BaseModel

from durable_streams_state import (
    CollectionDefinition,
    create_async_stream_db,
    create_state_schema,
    create_stream_db,
)

if TYPE_CHECKING:
    from conftest import TestServer


# Pydantic models for testing
class User(BaseModel):
    id: str
    name: str
    email: str


class Message(BaseModel):
    id: str
    text: str
    userId: str


@pytest.mark.integration
class TestStreamDB:
    """Test StreamDB with durable streams."""

    def test_define_stream_state_and_create_db_with_collections(
        self, test_server: TestServer
    ) -> None:
        """Should define stream state and create db with collections."""
        # Define the stream state structure
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
                "messages": CollectionDefinition(
                    model=Message, type="message", primary_key="id"
                ),
            }
        )

        # Create a durable stream for writing test data
        stream_path = f"/db/chat-{int(time.time() * 1000)}"
        stream = DurableStream.create(
            url=f"{test_server.url}{stream_path}",
            content_type="application/json",
        )

        # Create the stream DB
        db = create_stream_db(
            stream=DurableStream(
                url=f"{test_server.url}{stream_path}",
                content_type="application/json",
            ),
            state=stream_state,
        )

        # Verify collections are accessible
        assert "users" in db.collections
        assert "messages" in db.collections

        # Write change events
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"id": "1", "name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )
        stream.append(
            {
                "type": "user",
                "key": "2",
                "value": {"name": "Alice", "email": "alice@example.com"},
                "headers": {"operation": "insert"},
            }
        )
        stream.append(
            {
                "type": "message",
                "key": "msg1",
                "value": {"text": "Hello!", "userId": "1"},
                "headers": {"operation": "insert"},
            }
        )

        # Preload (waits for all data to sync)
        db.preload()

        # Query using collection interface
        kyle = db.collections["users"].get("1")
        alice = db.collections["users"].get("2")
        msg = db.collections["messages"].get("msg1")

        assert kyle is not None
        assert kyle.name == "Kyle"
        assert kyle.email == "kyle@example.com"
        assert alice is not None
        assert alice.name == "Alice"
        assert msg is not None
        assert msg.text == "Hello!"
        assert msg.userId == "1"

        # Cleanup
        db.close()

    def test_handle_update_operations(self, test_server: TestServer) -> None:
        """Should handle update operations."""
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/update-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        db = create_stream_db(
            stream=DurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
        )

        # Insert then update
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle", "email": "kyle@old.com"},
                "headers": {"operation": "insert"},
            }
        )
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle", "email": "kyle@new.com"},
                "headers": {"operation": "update"},
            }
        )

        db.preload()

        user = db.collections["users"].get("1")
        assert user is not None
        assert user.email == "kyle@new.com"

        db.close()

    def test_handle_delete_operations(self, test_server: TestServer) -> None:
        """Should handle delete operations."""
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/delete-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        db = create_stream_db(
            stream=DurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
        )

        # Insert then delete
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )
        stream.append(
            {
                "type": "user",
                "key": "1",
                "headers": {"operation": "delete"},
            }
        )

        db.preload()

        user = db.collections["users"].get("1")
        assert user is None

        db.close()

    def test_handle_empty_streams(self, test_server: TestServer) -> None:
        """Should handle empty streams."""
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/empty-{int(time.time() * 1000)}"

        DurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        # Use live=False for empty stream to avoid blocking
        db = create_stream_db(
            stream=DurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
            live=False,
        )

        # No events written, just preload
        db.preload()

        user = db.collections["users"].get("1")
        assert user is None
        assert db.collections["users"].size == 0

        db.close()

    def test_ignore_unknown_event_types(self, test_server: TestServer) -> None:
        """Should ignore unknown event types."""
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/unknown-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        db = create_stream_db(
            stream=DurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
        )

        # Write events with unknown types (should be ignored)
        stream.append(
            {
                "type": "unknown_type",
                "key": "1",
                "value": {"foo": "bar"},
                "headers": {"operation": "insert"},
            }
        )
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        db.preload()

        # User should be inserted, unknown type ignored
        user = db.collections["users"].get("1")
        assert user is not None
        assert user.name == "Kyle"
        assert db.collections["users"].size == 1

        db.close()

    def test_receive_live_updates_after_preload(self, test_server: TestServer) -> None:
        """Should receive live updates after preload."""
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/live-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        db = create_stream_db(
            stream=DurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
        )

        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        db.preload()
        assert db.collections["users"].get("1") is not None
        assert db.collections["users"].get("1").name == "Kyle"

        # Write more events AFTER preload
        stream.append(
            {
                "type": "user",
                "key": "2",
                "value": {"name": "Alice", "email": "alice@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        # Wait a bit for live update to arrive
        time.sleep(0.1)

        # New user should be visible
        alice = db.collections["users"].get("2")
        assert alice is not None
        assert alice.name == "Alice"

        db.close()

    def test_route_events_to_correct_collections_by_type(
        self, test_server: TestServer
    ) -> None:
        """Should route events to correct collections by type."""
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
                "messages": CollectionDefinition(
                    model=Message, type="message", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/routing-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        db = create_stream_db(
            stream=DurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
        )

        # Mix of user and message events
        stream.append(
            {
                "type": "message",
                "key": "m1",
                "value": {"text": "First", "userId": "1"},
                "headers": {"operation": "insert"},
            }
        )
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )
        stream.append(
            {
                "type": "message",
                "key": "m2",
                "value": {"text": "Second", "userId": "1"},
                "headers": {"operation": "insert"},
            }
        )

        db.preload()

        # Verify correct routing
        assert db.collections["users"].size == 1
        assert db.collections["messages"].size == 2
        assert db.collections["users"].get("1").name == "Kyle"
        assert db.collections["messages"].get("m1").text == "First"
        assert db.collections["messages"].get("m2").text == "Second"

        db.close()

    def test_handle_repeated_operations_on_same_key(
        self, test_server: TestServer
    ) -> None:
        """Should handle repeated operations on the same key."""
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/repeated-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        db = create_stream_db(
            stream=DurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
        )

        # Sequence of operations on the same key
        # 1. Insert
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle", "email": "kyle@v1.com"},
                "headers": {"operation": "insert"},
            }
        )
        # 2. Update
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle Smith", "email": "kyle@v2.com"},
                "headers": {"operation": "update"},
            }
        )
        # 3. Another update
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle J Smith", "email": "kyle@v3.com"},
                "headers": {"operation": "update"},
            }
        )
        # 4. Delete
        stream.append(
            {
                "type": "user",
                "key": "1",
                "headers": {"operation": "delete"},
            }
        )
        # 5. Re-insert with new data
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "New Kyle", "email": "newkyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        db.preload()

        # Final state should be the re-inserted value
        user = db.collections["users"].get("1")
        assert user is not None
        assert user.name == "New Kyle"
        assert user.email == "newkyle@example.com"
        assert db.collections["users"].size == 1

        db.close()

    def test_handle_interleaved_operations_on_multiple_keys(
        self, test_server: TestServer
    ) -> None:
        """Should handle interleaved operations on multiple keys."""
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/interleaved-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        db = create_stream_db(
            stream=DurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
        )

        # Interleaved operations on different keys
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Alice", "email": "alice@example.com"},
                "headers": {"operation": "insert"},
            }
        )
        stream.append(
            {
                "type": "user",
                "key": "2",
                "value": {"name": "Bob", "email": "bob@example.com"},
                "headers": {"operation": "insert"},
            }
        )
        stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Alice Updated", "email": "alice@new.com"},
                "headers": {"operation": "update"},
            }
        )
        stream.append(
            {
                "type": "user",
                "key": "3",
                "value": {"name": "Charlie", "email": "charlie@example.com"},
                "headers": {"operation": "insert"},
            }
        )
        stream.append(
            {
                "type": "user",
                "key": "2",
                "headers": {"operation": "delete"},
            }
        )
        stream.append(
            {
                "type": "user",
                "key": "3",
                "value": {"name": "Charlie Updated", "email": "charlie@new.com"},
                "headers": {"operation": "update"},
            }
        )

        db.preload()

        # Verify final state
        assert (
            db.collections["users"].size == 2
        )  # Alice and Charlie remain, Bob deleted
        assert db.collections["users"].get("1").name == "Alice Updated"
        assert db.collections["users"].get("2") is None  # Bob was deleted
        assert db.collections["users"].get("3").name == "Charlie Updated"

        db.close()

    def test_reject_primitive_values(self, test_server: TestServer) -> None:
        """Should reject primitive values (non-objects)."""
        # Use a simple string model (but this won't work with StreamDB)
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/primitives-{int(time.time() * 1000)}"

        stream = DurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        # Append a primitive value BEFORE creating the DB
        stream.append(
            {
                "type": "user",
                "key": "theme",
                "value": "dark",  # primitive string, not an object
                "headers": {"operation": "insert"},
            }
        )

        db = create_stream_db(
            stream=DurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
        )

        # Should throw when trying to process the primitive value during preload
        with pytest.raises(
            ValueError, match="StreamDB collections require object values"
        ):
            db.preload()

        db.close()

    def test_reject_duplicate_event_types(self) -> None:
        """Should reject duplicate event types across collections."""
        with pytest.raises(ValueError, match="(?i)duplicate event type"):
            create_state_schema(
                {
                    "users": CollectionDefinition(
                        model=User, type="person", primary_key="id"
                    ),
                    "admins": CollectionDefinition(
                        model=User, type="person", primary_key="id"
                    ),
                }
            )

    def test_reject_reserved_collection_names(self) -> None:
        """Should reject reserved collection names."""
        with pytest.raises(ValueError, match="(?i)reserved collection name"):
            create_state_schema(
                {
                    "preload": CollectionDefinition(
                        model=User, type="user", primary_key="id"
                    ),
                }
            )

        with pytest.raises(ValueError, match="(?i)reserved collection name"):
            create_state_schema(
                {
                    "close": CollectionDefinition(
                        model=User, type="user", primary_key="id"
                    ),
                }
            )


@pytest.mark.integration
class TestStateSchemaEventHelpers:
    """Test state schema event helper methods."""

    def test_create_insert_events_with_correct_structure(self) -> None:
        """Should create insert events with correct structure."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        insert_event = state_schema["users"].insert(
            key="123",
            value={"id": "123", "name": "Kyle", "email": "kyle@example.com"},
        )

        assert insert_event == {
            "type": "user",
            "key": "123",
            "value": User(id="123", name="Kyle", email="kyle@example.com"),
            "headers": {"operation": "insert"},
        }

    def test_create_update_events_with_correct_structure(self) -> None:
        """Should create update events with correct structure."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        update_event = state_schema["users"].update(
            key="123",
            value={"id": "123", "name": "Kyle M", "email": "kyle@example.com"},
            old_value={"id": "123", "name": "Kyle", "email": "kyle@example.com"},
        )

        assert update_event["type"] == "user"
        assert update_event["key"] == "123"
        assert update_event["headers"]["operation"] == "update"
        assert update_event["value"].name == "Kyle M"
        assert update_event["old_value"].name == "Kyle"

    def test_create_delete_events_with_correct_structure(self) -> None:
        """Should create delete events with correct structure."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        delete_event = state_schema["users"].delete(
            key="123",
            old_value={"id": "123", "name": "Kyle", "email": "kyle@example.com"},
        )

        assert delete_event["type"] == "user"
        assert delete_event["key"] == "123"
        assert delete_event["headers"]["operation"] == "delete"
        assert delete_event["old_value"].name == "Kyle"

    def test_create_delete_events_without_old_value(self) -> None:
        """Should create delete events without old_value."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        delete_event = state_schema["users"].delete(key="123")

        assert delete_event["type"] == "user"
        assert delete_event["key"] == "123"
        assert delete_event["headers"]["operation"] == "delete"
        assert "old_value" not in delete_event

    def test_use_correct_event_type_for_different_collections(self) -> None:
        """Should use correct event type for different collections."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
                "messages": CollectionDefinition(
                    model=Message, type="message", primary_key="id"
                ),
            }
        )

        user_event = state_schema["users"].insert(
            key="1",
            value={"id": "1", "name": "Kyle", "email": "kyle@example.com"},
        )
        message_event = state_schema["messages"].insert(
            key="msg1",
            value={"id": "msg1", "text": "Hello", "userId": "1"},
        )

        assert user_event["type"] == "user"
        assert message_event["type"] == "message"

    def test_support_custom_headers(self) -> None:
        """Should support custom headers including txid and timestamp."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        insert_event = state_schema["users"].insert(
            key="123",
            value={"id": "123", "name": "Kyle", "email": "kyle@example.com"},
            headers={
                "txid": "tx-001",
                "timestamp": "2025-01-15T12:00:00Z",
                "sourceApp": "web-app",
            },
        )

        assert insert_event["headers"]["operation"] == "insert"
        assert insert_event["headers"]["txid"] == "tx-001"
        assert insert_event["headers"]["timestamp"] == "2025-01-15T12:00:00Z"
        assert insert_event["headers"]["sourceApp"] == "web-app"


@pytest.mark.integration
class TestEventHelperValidation:
    """Test event helper validation."""

    def test_validate_insert_value_and_throw_on_invalid_data(self) -> None:
        """Should validate insert value and throw on invalid data."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        # Valid data should work
        state_schema["users"].insert(
            value={"id": "1", "name": "Kyle", "email": "kyle@example.com"}
        )

        # Invalid data should throw
        with pytest.raises(ValueError, match="Validation failed for user insert"):
            state_schema["users"].insert(
                value={"id": "1", "name": "Kyle"}  # missing email
            )

    def test_validate_update_value_and_throw_on_invalid_data(self) -> None:
        """Should validate update value and throw on invalid data."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        # Valid data should work
        state_schema["users"].update(
            value={"id": "1", "name": "Kyle Mathews", "email": "kyle@example.com"}
        )

        # Invalid value should throw
        with pytest.raises(ValueError, match="Validation failed for user update"):
            state_schema["users"].update(
                value={"id": "1", "name": "Kyle"}  # missing email
            )

    def test_throw_error_when_delete_has_neither_key_nor_old_value(self) -> None:
        """Should throw error when delete has neither key nor oldValue."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        with pytest.raises(
            ValueError, match="must provide either 'key' or 'old_value'"
        ):
            state_schema["users"].delete()

    def test_allow_delete_with_just_key(self) -> None:
        """Should allow delete with just key."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        event = state_schema["users"].delete(key="123")
        assert event["key"] == "123"
        assert "old_value" not in event

    def test_allow_delete_with_just_old_value(self) -> None:
        """Should allow delete with just oldValue."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        event = state_schema["users"].delete(
            old_value={"id": "456", "name": "Test", "email": "test@example.com"}
        )
        assert event["key"] == "456"
        assert event["old_value"].id == "456"

    def test_not_allow_user_headers_to_override_operation(self) -> None:
        """Should not allow user headers to override operation."""
        state_schema = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        # Try to override operation in insert
        insert_event = state_schema["users"].insert(
            value={"id": "1", "name": "Kyle", "email": "kyle@example.com"},
            headers={"operation": "delete"},  # Try to override
        )
        assert insert_event["headers"]["operation"] == "insert"

        # Try to override operation in update
        update_event = state_schema["users"].update(
            value={"id": "1", "name": "Kyle", "email": "kyle@example.com"},
            headers={"operation": "delete"},
        )
        assert update_event["headers"]["operation"] == "update"

        # Try to override operation in delete
        delete_event = state_schema["users"].delete(
            key="1",
            headers={"operation": "insert"},
        )
        assert delete_event["headers"]["operation"] == "delete"


@pytest.mark.integration
class TestAsyncStreamDB:
    """Test AsyncStreamDB with durable streams."""

    @pytest.mark.asyncio
    async def test_async_stream_db_basic_operations(
        self, test_server: TestServer
    ) -> None:
        """Should handle basic async StreamDB operations."""
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/async-basic-{int(time.time() * 1000)}"

        stream = await AsyncDurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        db = create_async_stream_db(
            stream=AsyncDurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
        )

        # Write events
        await stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )
        await stream.append(
            {
                "type": "user",
                "key": "2",
                "value": {"name": "Alice", "email": "alice@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        await db.preload()

        assert db.collections["users"].get("1").name == "Kyle"
        assert db.collections["users"].get("2").name == "Alice"
        assert db.collections["users"].size == 2

        await db.aclose()

    @pytest.mark.asyncio
    async def test_async_live_updates(self, test_server: TestServer) -> None:
        """Should receive async live updates after preload."""
        stream_state = create_state_schema(
            {
                "users": CollectionDefinition(
                    model=User, type="user", primary_key="id"
                ),
            }
        )

        stream_url = f"{test_server.url}/db/async-live-{int(time.time() * 1000)}"

        stream = await AsyncDurableStream.create(
            url=stream_url,
            content_type="application/json",
        )

        db = create_async_stream_db(
            stream=AsyncDurableStream(url=stream_url, content_type="application/json"),
            state=stream_state,
        )

        await stream.append(
            {
                "type": "user",
                "key": "1",
                "value": {"name": "Kyle", "email": "kyle@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        await db.preload()
        assert db.collections["users"].get("1").name == "Kyle"

        # Write more events AFTER preload
        await stream.append(
            {
                "type": "user",
                "key": "2",
                "value": {"name": "Alice", "email": "alice@example.com"},
                "headers": {"operation": "insert"},
            }
        )

        # Wait for live update
        await asyncio.sleep(0.1)

        assert db.collections["users"].get("2").name == "Alice"

        await db.aclose()
