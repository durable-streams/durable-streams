"""durable_streams_state

A Python state materialization layer over Durable Streams.

Public API intentionally mirrors `packages/state` (TypeScript) but is pythonic:
- Pydantic-powered schema validation
- Sync + async StreamDB implementations sharing the same core dispatcher
"""

from durable_streams_state.materialized_state import MaterializedState
from durable_streams_state.schema import (
    CollectionDefinition,
    StateSchema,
    create_state_schema,
)
from durable_streams_state.stream_db import (
    AsyncStreamDB,
    StreamDB,
    create_async_stream_db,
    create_stream_db,
)
from durable_streams_state.types import (
    ChangeEvent,
    ChangeHeaders,
    ControlEvent,
    Operation,
    StateEvent,
)

__all__ = [
    # Types
    "Operation",
    "ChangeHeaders",
    "ChangeEvent",
    "ControlEvent",
    "StateEvent",
    # Schema
    "CollectionDefinition",
    "StateSchema",
    "create_state_schema",
    # Materializer
    "MaterializedState",
    # Stream DB
    "StreamDB",
    "AsyncStreamDB",
    "create_stream_db",
    "create_async_stream_db",
]
