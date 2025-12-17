from __future__ import annotations

from pydantic import BaseModel

from durable_streams_state import CollectionDefinition, create_state_schema


class User(BaseModel):
    id: str
    name: str


def test_schema_helpers_build_events() -> None:
    schema = create_state_schema(
        {
            "users": CollectionDefinition(model=User, type="user", primary_key="id"),
        }
    )

    evt = schema["users"].insert(value={"id": "1", "name": "Alice"})
    assert evt["type"] == "user"
    assert evt["key"] == "1"
    assert evt["headers"]["operation"] == "insert"
